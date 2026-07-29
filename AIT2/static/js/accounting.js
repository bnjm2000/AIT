const accountingState = {
  data: null,
  tab: 'overview',
  search: '',
  sourceFilter: 'unposted',
  searchTimer: null,
  journalLines: [],
  editingJournalId: '',
  sourceTarget: null
};

function accountingRoot() {
  return document.getElementById('accounting-page-root');
}

function accountingEscape(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(String(value ?? ''));
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function accountingAttr(value) {
  if (typeof escapeHtmlAttr === 'function') return escapeHtmlAttr(String(value ?? ''));
  return accountingEscape(value).replace(/"/g, '&quot;');
}

function accountingMoney(value) {
  const amount = Number(value) || 0;
  return `${amount < 0 ? '-' : ''}$${Math.abs(amount).toLocaleString('en-SG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function accountingDate(value) {
  const raw = String(value || '').slice(0, 10);
  if (!raw) return '-';
  const parsed = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
}

function accountingSvg(name) {
  const paths = {
    journal: '<path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"></path>',
    source: '<path d="M7 3h7l4 4v14H7zM14 3v5h4M9 13h6M9 17h4"></path>',
    export: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14"></path>',
    plus: '<path d="M12 5v14M5 12h14"></path>',
    reverse: '<path d="m9 7-5 5 5 5M4 12h9a6 6 0 0 1 6 6"></path>',
    check: '<path d="m5 12 4 4L19 6"></path>',
    search: '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path>',
    settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"></path>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.journal}</svg>`;
}

async function loadAccounting(options = {}) {
  const root = accountingRoot();
  if (!root) return;
  if (typeof isPlatformAdminUser === 'function' && !isPlatformAdminUser()) {
    root.innerHTML = '<div class="accounting-empty">Administrative access is required.</div>';
    return;
  }
  if (!options.preserve) root.innerHTML = '<div class="loading">Loading accounting...</div>';
  const period = accountingState.data?.period || {};
  const query = new URLSearchParams();
  if (period.from) query.set('from', period.from);
  if (period.to) query.set('to', period.to);
  try {
    const response = await apiCall(`/api/finance/accounting${query.size ? `?${query}` : ''}`);
    accountingState.data = response.data;
    renderAccounting();
  } catch (error) {
    root.innerHTML = `<div class="accounting-empty">Could not load accounting.<br>${accountingEscape(error.message || error)}</div>`;
  }
}

async function accountingSetPeriod() {
  const from = document.getElementById('accountingPeriodFrom')?.value || '';
  const to = document.getElementById('accountingPeriodTo')?.value || '';
  accountingState.data = { ...(accountingState.data || {}), period: { from, to } };
  await loadAccounting({ preserve: true });
}

function accountingSetTab(tab) {
  accountingState.tab = tab;
  renderAccounting();
}

function accountingKpi(label, value, tone, note = '') {
  return `<div class="accounting-kpi ${tone}"><span>${accountingEscape(label)}</span><strong>${accountingMoney(value)}</strong>${note ? `<small>${accountingEscape(note)}</small>` : ''}</div>`;
}

function accountingHeader() {
  const data = accountingState.data || {};
  const period = data.period || {};
  return `
    <header class="accounting-header">
      <div>
        <h2>Accounting</h2>
        <p>Company books and GST working records</p>
      </div>
      <div class="accounting-header-actions">
        <label><span>From</span><input id="accountingPeriodFrom" type="date" value="${accountingAttr(period.from)}"></label>
        <label><span>To</span><input id="accountingPeriodTo" type="date" value="${accountingAttr(period.to)}"></label>
        <button type="button" class="accounting-icon-button" title="Apply period" onclick="accountingSetPeriod()">${accountingSvg('check')}</button>
        <button type="button" class="btn btn-secondary accounting-action" onclick="accountingOpenJournal()">${accountingSvg('plus')} Journal</button>
      </div>
    </header>
  `;
}

function accountingTabs() {
  const tabs = [
    ['overview', 'Overview'],
    ['sources', 'Sales & Purchases'],
    ['banking', 'Banking'],
    ['transactions', 'Transactions'],
    ['journals', 'Journals'],
    ['accounts', 'Chart of Accounts'],
    ['gst', 'GST'],
    ['reports', 'Reports'],
    ['settings', 'Settings']
  ];
  return `<nav class="accounting-tabs" aria-label="Accounting views">${tabs.map(([key, label]) => `
    <button type="button" class="${accountingState.tab === key ? 'active' : ''}" onclick="accountingSetTab('${key}')">${accountingEscape(label)}${key === 'sources' && accountingState.data?.unpostedCount ? `<span>${accountingState.data.unpostedCount}</span>` : ''}</button>
  `).join('')}</nav>`;
}

function accountingRenderOverview() {
  const data = accountingState.data || {};
  const summary = data.summary || {};
  const sources = (data.sourceDocuments || []).filter(row => !row.posted).slice(0, 8);
  const journals = (data.journals || []).slice(0, 7);
  return `
    <section class="accounting-kpi-grid" aria-label="Accounting summary">
      ${accountingKpi('Cash at bank', summary.cash, 'cash')}
      ${accountingKpi('Receivables', summary.receivables, 'receivable')}
      ${accountingKpi('Payables', summary.payables, 'payable')}
      ${accountingKpi('Revenue', summary.revenue, 'revenue')}
      ${accountingKpi('Net profit', summary.netProfit, summary.netProfit < 0 ? 'negative' : 'profit')}
      ${accountingKpi('Net GST', summary.gstPayable, summary.gstPayable < 0 ? 'receivable' : 'gst', summary.gstPayable < 0 ? 'Claimable' : 'Payable')}
    </section>
    <div class="accounting-overview-grid">
      <section class="accounting-panel">
        <div class="accounting-panel-heading"><div><h3>Unposted documents</h3><p>Review before they enter the ledger</p></div><button type="button" class="accounting-link" onclick="accountingSetTab('sources')">View all</button></div>
        ${sources.length ? `<div class="accounting-compact-list">${sources.map(row => `
          <button type="button" onclick="accountingOpenSource('${accountingAttr(encodeURIComponent(row.key))}')"><span><strong>${accountingEscape(row.number)}</strong><small>${accountingEscape(row.contact || row.kind)}</small></span><span><b>${accountingMoney(row.gross)}</b><small>${accountingDate(row.date)}</small></span></button>
        `).join('')}</div>` : '<div class="accounting-empty compact">Everything available is posted.</div>'}
      </section>
      <section class="accounting-panel">
        <div class="accounting-panel-heading"><div><h3>Recent journals</h3><p>Drafts and posted entries</p></div><button type="button" class="accounting-link" onclick="accountingSetTab('journals')">View all</button></div>
        ${journals.length ? `<div class="accounting-compact-list">${journals.map(row => `
          <button type="button" onclick="accountingOpenJournal('${accountingAttr(row.id)}')"><span><strong>${accountingEscape(row.number)}</strong><small>${accountingEscape(row.description || row.reference || '-')}</small></span><span><b>${accountingMoney(row.debitTotal)}</b><small class="accounting-status ${row.status}">${accountingEscape(row.status)}</small></span></button>
        `).join('')}</div>` : '<div class="accounting-empty compact">No journal entries yet.</div>'}
      </section>
    </div>
    <section class="accounting-panel accounting-health">
      <div class="accounting-panel-heading"><div><h3>Books health</h3><p>${accountingDate(data.period?.from)} to ${accountingDate(data.period?.to)}</p></div></div>
      <div class="accounting-health-grid">
        <div><span>Unposted documents</span><strong>${data.unpostedCount || 0}</strong></div>
        <div><span>Draft journals</span><strong>${(data.journals || []).filter(row => row.status === 'draft').length}</strong></div>
        <div><span>Trial balance</span><strong>${Math.abs((data.trialBalance || []).reduce((sum, row) => sum + Number(row.debit || 0) - Number(row.credit || 0), 0)) < 0.005 ? 'Balanced' : 'Review'}</strong></div>
        <div><span>GST registration</span><strong>${data.settings?.gstRegistered ? 'Active' : 'Not enabled'}</strong></div>
      </div>
    </section>
  `;
}

function accountingSearchControl(placeholder) {
  return `<label class="accounting-search">${accountingSvg('search')}<input type="search" value="${accountingAttr(accountingState.search)}" placeholder="${accountingAttr(placeholder)}" oninput="accountingSearchChanged(this)"></label>`;
}

function accountingSearchChanged(input) {
  accountingState.search = input.value;
  clearTimeout(accountingState.searchTimer);
  accountingState.searchTimer = setTimeout(() => {
    renderAccountingBody();
    const replacement = document.querySelector('#accountingBody .accounting-search input');
    if (replacement) {
      replacement.focus({ preventScroll: true });
      replacement.setSelectionRange(replacement.value.length, replacement.value.length);
    }
  }, 120);
}

function accountingFilteredSources() {
  const query = accountingState.search.trim().toLowerCase();
  return (accountingState.data?.sourceDocuments || []).filter(row => {
    if (accountingState.sourceFilter === 'unposted' && row.posted) return false;
    if (accountingState.sourceFilter === 'posted' && !row.posted) return false;
    if (!query) return true;
    return [row.number, row.contact, row.description, row.kind, row.eventId].some(value => String(value || '').toLowerCase().includes(query));
  });
}

function accountingRenderSources() {
  const rows = accountingFilteredSources();
  return `
    <section class="accounting-panel accounting-table-panel">
      <div class="accounting-panel-heading responsive"><div><h3>Sales and purchase documents</h3><p>Posting creates balanced ledger entries once</p></div><div class="accounting-tools">${accountingSearchControl('Search documents...')}<div class="accounting-segments">${['unposted', 'posted', 'all'].map(value => `<button type="button" class="${accountingState.sourceFilter === value ? 'active' : ''}" onclick="accountingState.sourceFilter='${value}';renderAccountingBody()">${value[0].toUpperCase() + value.slice(1)}</button>`).join('')}</div></div></div>
      <div class="accounting-table-scroll"><table class="accounting-table"><thead><tr><th>Date</th><th>Document</th><th>Contact</th><th>Event</th><th>Status</th><th class="money">Amount</th><th></th></tr></thead><tbody>
        ${rows.map(row => `<tr><td>${accountingDate(row.date)}</td><td><strong>${accountingEscape(row.number)}</strong><small>${accountingEscape(row.description || row.kind)}</small></td><td>${accountingEscape(row.contact || '-')}</td><td>${row.eventId ? `#${row.eventId}` : '-'}</td><td><span class="accounting-status ${row.posted ? 'posted' : 'draft'}">${row.posted ? 'Posted' : 'Unposted'}</span></td><td class="money"><strong>${accountingMoney(row.gross)}</strong></td><td class="actions">${row.posted ? '' : `<button type="button" class="btn btn-primary compact" onclick="accountingOpenSource('${accountingAttr(encodeURIComponent(row.key))}')">Post</button>`}</td></tr>`).join('') || '<tr><td colspan="7" class="accounting-empty">No matching documents.</td></tr>'}
      </tbody></table></div>
    </section>
  `;
}

function accountingRenderTransactions() {
  const query = accountingState.search.trim().toLowerCase();
  const rows = (accountingState.data?.transactions || []).filter(row => !query || [row.number, row.reference, row.accountCode, row.accountName, row.description, row.contact, row.eventId].some(value => String(value || '').toLowerCase().includes(query)));
  return `
    <section class="accounting-panel accounting-table-panel">
      <div class="accounting-panel-heading responsive"><div><h3>General ledger</h3><p>Posted lines for the selected period</p></div><div class="accounting-tools">${accountingSearchControl('Search ledger...')}<a class="btn btn-secondary accounting-action" href="${accountingExportUrl('transactions')}">${accountingSvg('export')} CSV</a></div></div>
      <div class="accounting-table-scroll"><table class="accounting-table dense"><thead><tr><th>Date</th><th>Journal</th><th>Account</th><th>Description</th><th>GST</th><th class="money">Debit</th><th class="money">Credit</th></tr></thead><tbody>
        ${rows.map(row => `<tr><td>${accountingDate(row.date)}</td><td><strong>${accountingEscape(row.number)}</strong><small>${accountingEscape(row.reference || '-')}</small></td><td><strong>${accountingEscape(row.accountCode)}</strong><small>${accountingEscape(row.accountName)}</small></td><td>${accountingEscape(row.description || '-')}<small>${accountingEscape([row.contact, row.eventId ? `Event #${row.eventId}` : ''].filter(Boolean).join(' · '))}</small></td><td><span class="accounting-tax-code">${accountingEscape(row.taxCode)}</span></td><td class="money">${row.debit ? accountingMoney(row.debit) : '-'}</td><td class="money">${row.credit ? accountingMoney(row.credit) : '-'}</td></tr>`).join('') || '<tr><td colspan="7" class="accounting-empty">No posted transactions in this period.</td></tr>'}
      </tbody></table></div>
    </section>
  `;
}

function accountingRenderBanking() {
  const data = accountingState.data || {};
  const summary = data.bankSummary || {};
  const query = accountingState.search.trim().toLowerCase();
  const rows = (data.bankTransactions || []).filter(row => !query || [row.description, row.reference, row.amount, row.date].some(value => String(value || '').toLowerCase().includes(query)));
  return `
    <section class="accounting-kpi-grid banking" aria-label="Bank reconciliation summary">
      ${accountingKpi('Statement movement', summary.statementMovement, 'cash')}
      ${accountingKpi('Ledger movement', summary.ledgerMovement, 'receivable')}
      ${accountingKpi('Difference', summary.difference, Math.abs(Number(summary.difference || 0)) < 0.005 ? 'profit' : 'negative', `${summary.unmatchedCount || 0} unmatched`)}
    </section>
    <section class="accounting-panel accounting-table-panel">
      <div class="accounting-panel-heading responsive"><div><h3>Bank reconciliation</h3><p>Imported statement activity for the selected period</p></div><div class="accounting-tools">${accountingSearchControl('Search bank activity...')}<button type="button" class="btn btn-secondary accounting-action" onclick="accountingOpenBankImport()">${accountingSvg('source')} Import CSV</button><button type="button" class="btn btn-primary accounting-action" onclick="accountingOpenBankTransaction()">${accountingSvg('plus')} Add transaction</button></div></div>
      <div class="accounting-table-scroll"><table class="accounting-table"><thead><tr><th>Date</th><th>Description</th><th>Reference</th><th>Status</th><th class="money">Money out</th><th class="money">Money in</th><th></th></tr></thead><tbody>
        ${rows.map(row => `<tr><td>${accountingDate(row.date)}</td><td><strong>${accountingEscape(row.description)}</strong><small>${accountingEscape(row.bankAccount || '')}</small></td><td>${accountingEscape(row.reference || '-')}</td><td><span class="accounting-status ${row.status === 'matched' ? 'posted' : 'draft'}">${accountingEscape(row.status)}</span>${row.journalId ? `<small>${accountingEscape(row.journalId)}</small>` : ''}</td><td class="money">${Number(row.amount) < 0 ? accountingMoney(Math.abs(row.amount)) : '-'}</td><td class="money">${Number(row.amount) > 0 ? accountingMoney(row.amount) : '-'}</td><td class="actions">${row.status === 'matched' ? '' : `<button type="button" class="accounting-row-action primary" onclick="accountingOpenBankMatch('${accountingAttr(row.id)}')">Match</button><button type="button" class="accounting-row-action" onclick="accountingDeleteBankTransaction('${accountingAttr(row.id)}')">Delete</button>`}</td></tr>`).join('') || '<tr><td colspan="7" class="accounting-empty">No bank transactions imported.</td></tr>'}
      </tbody></table></div>
    </section>
  `;
}

function accountingRenderJournals() {
  const query = accountingState.search.trim().toLowerCase();
  const rows = (accountingState.data?.journals || []).filter(row => !query || [row.number, row.description, row.reference, row.createdBy].some(value => String(value || '').toLowerCase().includes(query)));
  return `
    <section class="accounting-panel accounting-table-panel">
      <div class="accounting-panel-heading responsive"><div><h3>Journal entries</h3><p>Posted entries are corrected by reversal</p></div><div class="accounting-tools">${accountingSearchControl('Search journals...')}<button type="button" class="btn btn-primary accounting-action" onclick="accountingOpenJournal()">${accountingSvg('plus')} New journal</button></div></div>
      <div class="accounting-table-scroll"><table class="accounting-table"><thead><tr><th>Date</th><th>Journal</th><th>Description</th><th>Status</th><th class="money">Total</th><th></th></tr></thead><tbody>
        ${rows.map(row => `<tr><td>${accountingDate(row.date)}</td><td><strong>${accountingEscape(row.number)}</strong><small>${accountingEscape(row.reference || '-')}</small></td><td>${accountingEscape(row.description || '-')}<small>${accountingEscape(row.createdBy || '')}</small></td><td><span class="accounting-status ${row.status}">${accountingEscape(row.status)}</span>${row.reversedJournalId ? '<small>Reversed</small>' : ''}</td><td class="money"><strong>${accountingMoney(row.debitTotal)}</strong></td><td class="actions"><button type="button" class="accounting-row-action" onclick="accountingOpenJournal('${accountingAttr(row.id)}')">View</button>${row.status === 'draft' ? `<button type="button" class="accounting-row-action primary" onclick="accountingPostJournal('${accountingAttr(row.id)}')">Post</button>` : !row.reversedJournalId ? `<button type="button" class="accounting-row-action" onclick="accountingReverseJournal('${accountingAttr(row.id)}')">Reverse</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="accounting-empty">No journal entries.</td></tr>'}
      </tbody></table></div>
    </section>
  `;
}

function accountingRenderAccounts() {
  const query = accountingState.search.trim().toLowerCase();
  const rows = (accountingState.data?.accounts || []).filter(row => !query || [row.code, row.name, row.type, row.group].some(value => String(value || '').toLowerCase().includes(query)));
  return `
    <section class="accounting-panel accounting-table-panel">
      <div class="accounting-panel-heading responsive"><div><h3>Chart of accounts</h3><p>System and company-specific accounts</p></div><div class="accounting-tools">${accountingSearchControl('Search accounts...')}<button type="button" class="btn btn-primary accounting-action" onclick="accountingOpenAccount()">${accountingSvg('plus')} Add account</button></div></div>
      <div class="accounting-table-scroll"><table class="accounting-table dense"><thead><tr><th>Code</th><th>Account</th><th>Type</th><th>Group</th><th>Status</th><th></th></tr></thead><tbody>
        ${rows.map(row => `<tr><td><strong>${accountingEscape(row.code)}</strong></td><td>${accountingEscape(row.name)}</td><td>${accountingEscape(row.type)}</td><td>${accountingEscape(row.group || '-')}</td><td><span class="accounting-status ${row.active === false ? 'inactive' : 'posted'}">${row.active === false ? 'Inactive' : 'Active'}</span></td><td class="actions"><button type="button" class="accounting-row-action" onclick="accountingToggleAccount('${accountingAttr(row.code)}',${row.active === false ? 'true' : 'false'})">${row.active === false ? 'Activate' : 'Deactivate'}</button></td></tr>`).join('')}
      </tbody></table></div>
    </section>
  `;
}

const ACCOUNTING_GST_LABELS = {
  1: 'Standard-rated supplies', 2: 'Zero-rated supplies', 3: 'Exempt supplies', 4: 'Total supplies',
  5: 'Taxable purchases', 6: 'Output tax due', 7: 'Input tax claimed', 8: 'Net GST payable / (claimable)',
  9: 'Imports under approved schemes', 10: 'Tourist refunds claimed', 11: 'Bad debt / reverse-charge refunds',
  12: 'Pre-registration claims', 13: 'Revenue', 14: 'Reverse-charge imports', 15: 'Marketplace remote services',
  16: 'Marketplace / redeliverer LVG', 17: 'Imported low-value goods'
};

function accountingRenderGst() {
  const data = accountingState.data || {};
  const gst = data.gst || {};
  return `
    <section class="accounting-gst-heading">
      <div><h3>GST return working</h3><p>${accountingDate(data.period?.from)} to ${accountingDate(data.period?.to)} · SGD</p></div>
      <a class="btn btn-secondary accounting-action" href="${accountingExportUrl('gst')}">${accountingSvg('export')} Export schedule</a>
    </section>
    ${!data.settings?.gstRegistered ? '<div class="accounting-notice warning"><strong>GST is not enabled for this company.</strong><span>Enable it in Accounting Settings before using this schedule for filing work.</span></div>' : `<div class="accounting-notice"><strong>${accountingEscape(data.settings.gstRegistrationNumber || 'GST registration number not entered')}</strong><span>Configured rate: ${Number(data.settings.gstRate || 0)}%</span></div>`}
    <section class="accounting-gst-grid">${Array.from({ length: 17 }, (_, index) => index + 1).map(number => `
      <div class="accounting-gst-box ${number === 8 ? 'total' : ''}"><span>Box ${number}</span><p>${accountingEscape(ACCOUNTING_GST_LABELS[number])}</p><strong>${accountingMoney(gst[`box${number}`])}</strong>${number > 9 && number !== 13 ? '<small>Special declaration</small>' : ''}</div>
    `).join('')}</section>
    <div class="accounting-notice neutral"><strong>Review before filing</strong><span>This is a GST F5 working schedule from posted tax codes. Validate tax invoices, blocked input tax, reverse charge, schemes and special declarations before filing in myTax Portal.</span></div>
  `;
}

function accountingReportTable(title, rows, total, exportName) {
  return `<section class="accounting-panel accounting-report"><div class="accounting-panel-heading"><h3>${accountingEscape(title)}</h3><a class="accounting-link" href="${accountingExportUrl(exportName)}">Export CSV</a></div><div class="accounting-report-rows">${rows.map(row => `<div><span>${accountingEscape([row.code, row.name].filter(Boolean).join(' · '))}</span><strong>${accountingMoney(row.amount)}</strong></div>`).join('') || '<div><span>No balances</span><strong>$0.00</strong></div>'}<div class="total"><span>Total</span><strong>${accountingMoney(total)}</strong></div></div></section>`;
}

function accountingRenderReports() {
  const data = accountingState.data || {};
  const pnl = data.profitLoss || {};
  const sheet = data.balanceSheet || {};
  const assets = (sheet.assets || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const liabilities = (sheet.liabilities || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const equity = (sheet.equity || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return `
    <div class="accounting-reports-grid">
      ${accountingReportTable('Profit & Loss', pnl.rows || [], pnl.netProfit || 0, 'profit-loss')}
      ${accountingReportTable('Assets', sheet.assets || [], assets, 'balance-sheet')}
      ${accountingReportTable('Liabilities', sheet.liabilities || [], liabilities, 'balance-sheet')}
      ${accountingReportTable('Equity', sheet.equity || [], equity, 'balance-sheet')}
    </div>
    <section class="accounting-panel accounting-table-panel">
      <div class="accounting-panel-heading"><div><h3>Trial balance</h3><p>As at ${accountingDate(data.period?.to)}</p></div><a class="accounting-link" href="${accountingExportUrl('trial-balance')}">Export CSV</a></div>
      <div class="accounting-table-scroll"><table class="accounting-table dense"><thead><tr><th>Account</th><th>Type</th><th class="money">Debit</th><th class="money">Credit</th></tr></thead><tbody>${(data.trialBalance || []).map(row => `<tr><td><strong>${accountingEscape(row.code)}</strong> ${accountingEscape(row.name)}</td><td>${accountingEscape(row.type)}</td><td class="money">${row.debit ? accountingMoney(row.debit) : '-'}</td><td class="money">${row.credit ? accountingMoney(row.credit) : '-'}</td></tr>`).join('') || '<tr><td colspan="4" class="accounting-empty">No posted balances.</td></tr>'}</tbody></table></div>
    </section>
  `;
}

function accountingAccountOptions(selected = '', types = []) {
  return (accountingState.data?.accounts || []).filter(row => row.active !== false && (!types.length || types.includes(row.type))).map(row => `<option value="${accountingAttr(row.code)}" ${String(row.code) === String(selected) ? 'selected' : ''}>${accountingEscape(row.code)} · ${accountingEscape(row.name)}</option>`).join('');
}

function accountingRenderSettings() {
  const settings = accountingState.data?.settings || {};
  return `
    <form class="accounting-settings" onsubmit="accountingSaveSettings(event)">
      <section class="accounting-panel"><div class="accounting-panel-heading"><div><h3>GST configuration</h3><p>Singapore GST working defaults</p></div><label class="accounting-switch"><input id="accountingGstRegistered" type="checkbox" ${settings.gstRegistered ? 'checked' : ''}><span></span><b>GST registered</b></label></div><div class="accounting-form-grid three"><label><span>GST registration number</span><input id="accountingGstNumber" value="${accountingAttr(settings.gstRegistrationNumber)}"></label><label><span>GST rate (%)</span><input id="accountingGstRate" type="number" min="0" max="100" step="0.01" value="${Number(settings.gstRate ?? 9)}"></label><label><span>Filing frequency</span><select id="accountingFilingFrequency"><option value="quarterly" ${settings.filingFrequency === 'quarterly' ? 'selected' : ''}>Quarterly</option><option value="monthly" ${settings.filingFrequency === 'monthly' ? 'selected' : ''}>Monthly</option></select></label></div></section>
      <section class="accounting-panel"><div class="accounting-panel-heading"><div><h3>Books controls</h3><p>Financial year, retention and posting defaults</p></div></div><div class="accounting-form-grid three"><label><span>Financial year starts</span><select id="accountingYearStart">${Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}" ${Number(settings.financialYearStartMonth) === index + 1 ? 'selected' : ''}>${new Date(2026, index, 1).toLocaleString('en-SG', { month: 'long' })}</option>`).join('')}</select></label><label><span>Accounting basis</span><select id="accountingBasis"><option value="accrual" ${settings.accountingBasis !== 'cash' ? 'selected' : ''}>Accrual</option><option value="cash" ${settings.accountingBasis === 'cash' ? 'selected' : ''}>Cash</option></select></label><label><span>Record retention (years)</span><input id="accountingRetention" type="number" min="5" max="20" value="${Number(settings.recordRetentionYears || 5)}"></label><label><span>Lock entries through</span><input id="accountingLockDate" type="date" value="${accountingAttr(settings.periodLockDate)}"></label><label><span>Default bank account</span><select id="accountingBankAccount">${accountingAccountOptions(settings.defaultBankAccount, ['asset'])}</select></label><label><span>Default receivable account</span><select id="accountingReceivableAccount">${accountingAccountOptions(settings.defaultReceivableAccount, ['asset'])}</select></label><label><span>Default payable account</span><select id="accountingPayableAccount">${accountingAccountOptions(settings.defaultPayableAccount, ['liability'])}</select></label></div></section>
      <div class="accounting-form-actions"><button type="submit" class="btn btn-primary">Save accounting settings</button></div>
    </form>
  `;
}

function renderAccountingBody() {
  const body = document.getElementById('accountingBody');
  if (!body) return;
  const renderers = {
    overview: accountingRenderOverview,
    sources: accountingRenderSources,
    banking: accountingRenderBanking,
    transactions: accountingRenderTransactions,
    journals: accountingRenderJournals,
    accounts: accountingRenderAccounts,
    gst: accountingRenderGst,
    reports: accountingRenderReports,
    settings: accountingRenderSettings
  };
  body.innerHTML = (renderers[accountingState.tab] || accountingRenderOverview)();
}

function renderAccounting() {
  const root = accountingRoot();
  if (!root || !accountingState.data) return;
  root.innerHTML = `${accountingHeader()}${accountingTabs()}<main id="accountingBody" class="accounting-body"></main>`;
  renderAccountingBody();
}

function accountingExportUrl(report) {
  const period = accountingState.data?.period || {};
  const query = new URLSearchParams({ report, from: period.from || '', to: period.to || '' });
  return `/api/finance/accounting/export.csv?${query}`;
}

function accountingEnsureModal() {
  if (document.getElementById('accountingModal')) return;
  const modal = document.createElement('div');
  modal.id = 'accountingModal';
  modal.className = 'modal';
  modal.innerHTML = '<div class="modal-content accounting-modal"><div class="modal-header"><h3 id="accountingModalTitle" class="modal-title">Accounting</h3><button type="button" class="close-btn" onclick="closeModal(\'accountingModal\')">&times;</button></div><div id="accountingModalBody"></div></div>';
  document.body.appendChild(modal);
}

function accountingNewLine(value = {}) {
  return { id: value.id || `line_${Date.now()}_${Math.random().toString(16).slice(2)}`, accountCode: value.accountCode || '', description: value.description || '', debit: Number(value.debit) || 0, credit: Number(value.credit) || 0, taxCode: value.taxCode || 'OP', taxBase: Number(value.taxBase) || 0, gstAmount: Number(value.gstAmount) || 0, contact: value.contact || '', eventId: value.eventId || '' };
}

function accountingCollectJournalLines() {
  accountingState.journalLines = Array.from(document.querySelectorAll('[data-accounting-journal-line]')).map(row => accountingNewLine({
    id: row.dataset.lineId,
    accountCode: row.querySelector('[data-field="accountCode"]')?.value,
    description: row.querySelector('[data-field="description"]')?.value,
    debit: row.querySelector('[data-field="debit"]')?.value,
    credit: row.querySelector('[data-field="credit"]')?.value,
    taxCode: row.querySelector('[data-field="taxCode"]')?.value,
    taxBase: row.querySelector('[data-field="taxBase"]')?.value,
    gstAmount: row.querySelector('[data-field="gstAmount"]')?.value,
    contact: row.querySelector('[data-field="contact"]')?.value,
    eventId: row.querySelector('[data-field="eventId"]')?.value
  }));
}

function accountingJournalLineHtml(line, index, readonly) {
  return `<div class="accounting-journal-line" data-accounting-journal-line data-line-id="${accountingAttr(line.id)}"><span class="line-number">${index + 1}</span><label class="account"><span>Account</span><select data-field="accountCode" ${readonly ? 'disabled' : ''}><option value="">Choose account</option>${accountingAccountOptions(line.accountCode)}</select></label><label class="description"><span>Description</span><input data-field="description" value="${accountingAttr(line.description)}" ${readonly ? 'readonly' : ''}></label><label><span>Debit</span><input data-field="debit" type="number" min="0" step="0.01" value="${line.debit || ''}" oninput="accountingUpdateJournalBalance()" ${readonly ? 'readonly' : ''}></label><label><span>Credit</span><input data-field="credit" type="number" min="0" step="0.01" value="${line.credit || ''}" oninput="accountingUpdateJournalBalance()" ${readonly ? 'readonly' : ''}></label><label><span>GST code</span><select data-field="taxCode" ${readonly ? 'disabled' : ''}>${(accountingState.data?.taxCodes || []).map(row => `<option value="${accountingAttr(row.code)}" ${row.code === line.taxCode ? 'selected' : ''}>${accountingEscape(row.code)} · ${accountingEscape(row.name)}</option>`).join('')}</select></label><label><span>Taxable value</span><input data-field="taxBase" type="number" step="0.01" value="${line.taxBase || ''}" ${readonly ? 'readonly' : ''}></label><label><span>GST amount</span><input data-field="gstAmount" type="number" step="0.01" value="${line.gstAmount || ''}" ${readonly ? 'readonly' : ''}></label>${readonly ? '' : `<button type="button" class="accounting-remove-line" title="Remove line" onclick="accountingRemoveJournalLine(${index})">&times;</button>`}<input data-field="contact" type="hidden" value="${accountingAttr(line.contact)}"><input data-field="eventId" type="hidden" value="${accountingAttr(line.eventId)}"></div>`;
}

function accountingRenderJournalLines(readonly = false) {
  const root = document.getElementById('accountingJournalLines');
  if (!root) return;
  root.innerHTML = accountingState.journalLines.map((line, index) => accountingJournalLineHtml(line, index, readonly)).join('');
  accountingUpdateJournalBalance();
}

function accountingUpdateJournalBalance() {
  const rows = Array.from(document.querySelectorAll('[data-accounting-journal-line]'));
  const debit = rows.reduce((sum, row) => sum + Number(row.querySelector('[data-field="debit"]')?.value || 0), 0);
  const credit = rows.reduce((sum, row) => sum + Number(row.querySelector('[data-field="credit"]')?.value || 0), 0);
  const node = document.getElementById('accountingJournalBalance');
  if (node) {
    node.innerHTML = `<span>Debits <strong>${accountingMoney(debit)}</strong></span><span>Credits <strong>${accountingMoney(credit)}</strong></span><span class="${Math.abs(debit - credit) < 0.005 ? 'balanced' : 'unbalanced'}">Difference <strong>${accountingMoney(debit - credit)}</strong></span>`;
  }
}

function accountingAddJournalLine() {
  accountingCollectJournalLines();
  accountingState.journalLines.push(accountingNewLine());
  accountingRenderJournalLines();
}

function accountingRemoveJournalLine(index) {
  accountingCollectJournalLines();
  if (accountingState.journalLines.length <= 2) return;
  accountingState.journalLines.splice(index, 1);
  accountingRenderJournalLines();
}

function accountingOpenJournal(journalId = '') {
  accountingEnsureModal();
  const journal = (accountingState.data?.journals || []).find(row => row.id === journalId);
  const readonly = journal?.status === 'posted';
  accountingState.editingJournalId = journal?.id || '';
  accountingState.journalLines = (journal?.lines || [accountingNewLine(), accountingNewLine()]).map(accountingNewLine);
  document.getElementById('accountingModalTitle').textContent = journal ? journal.number : 'New journal entry';
  document.getElementById('accountingModalBody').innerHTML = `<form class="accounting-journal-form" onsubmit="accountingSaveJournal(event)"><div class="accounting-form-grid three"><label><span>Date</span><input id="accountingJournalDate" type="date" value="${accountingAttr(journal?.date || new Date().toISOString().slice(0, 10))}" ${readonly ? 'readonly' : ''}></label><label><span>Reference</span><input id="accountingJournalReference" value="${accountingAttr(journal?.reference || '')}" ${readonly ? 'readonly' : ''}></label><label><span>Status</span><select id="accountingJournalStatus" ${readonly ? 'disabled' : ''}><option value="draft" ${journal?.status !== 'posted' ? 'selected' : ''}>Draft</option><option value="posted" ${journal?.status === 'posted' ? 'selected' : ''}>Post now</option></select></label><label class="span-all"><span>Description</span><input id="accountingJournalDescription" value="${accountingAttr(journal?.description || '')}" required ${readonly ? 'readonly' : ''}></label></div><div id="accountingJournalLines" class="accounting-journal-lines"></div>${readonly ? '' : '<button type="button" class="accounting-add-line" onclick="accountingAddJournalLine()">+ Add line</button>'}<div id="accountingJournalBalance" class="accounting-journal-balance"></div><div class="modal-actions">${journal && !readonly ? '<button type="button" class="btn btn-danger" onclick="accountingDeleteJournal()">Delete draft</button>' : ''}<button type="button" class="btn btn-secondary" onclick="closeModal(\'accountingModal\')">Close</button>${readonly ? (!journal.reversedJournalId ? `<button type="button" class="btn btn-secondary" onclick="closeModal('accountingModal');accountingReverseJournal('${accountingAttr(journal.id)}')">Reverse</button>` : '') : '<button type="submit" class="btn btn-primary">Save journal</button>'}</div></form>`;
  accountingRenderJournalLines(readonly);
  openModal('accountingModal');
}

async function accountingSaveJournal(event) {
  event.preventDefault();
  accountingCollectJournalLines();
  const payload = { date: document.getElementById('accountingJournalDate').value, reference: document.getElementById('accountingJournalReference').value, description: document.getElementById('accountingJournalDescription').value, status: document.getElementById('accountingJournalStatus').value, lines: accountingState.journalLines };
  try {
    const endpoint = accountingState.editingJournalId ? `/api/finance/accounting/journals/${encodeURIComponent(accountingState.editingJournalId)}` : '/api/finance/accounting/journals';
    const response = await apiCall(endpoint, accountingState.editingJournalId ? 'PUT' : 'POST', payload);
    accountingState.data = response.data;
    closeModal('accountingModal');
    renderAccounting();
    showNotification('success', 'Journal saved');
  } catch (error) { showNotification('error', error.message || 'Could not save journal'); }
}

async function accountingDeleteJournal() {
  if (!accountingState.editingJournalId) return;
  const confirmed = await showAppConfirm({ title: 'Delete draft journal?', message: 'This draft has not affected the ledger yet.', confirmText: 'Delete', cancelText: 'Keep draft', danger: true });
  if (!confirmed) return;
  try { const response = await apiCall(`/api/finance/accounting/journals/${encodeURIComponent(accountingState.editingJournalId)}`, 'DELETE'); accountingState.data = response.data; closeModal('accountingModal'); renderAccounting(); } catch (error) { showNotification('error', error.message); }
}

async function accountingPostJournal(journalId) {
  const confirmed = await showAppConfirm({ title: 'Post journal?', message: 'Posted entries affect the books and can only be corrected by reversal.', confirmText: 'Post', cancelText: 'Cancel' });
  if (!confirmed) return;
  try { const response = await apiCall(`/api/finance/accounting/journals/${encodeURIComponent(journalId)}/post`, 'POST', {}); accountingState.data = response.data; renderAccounting(); showNotification('success', 'Journal posted'); } catch (error) { showNotification('error', error.message); }
}

async function accountingReverseJournal(journalId) {
  const confirmed = await showAppConfirm({ title: 'Reverse posted journal?', message: 'A new equal and opposite entry will be posted today.', confirmText: 'Reverse', cancelText: 'Cancel', danger: true });
  if (!confirmed) return;
  try { const response = await apiCall(`/api/finance/accounting/journals/${encodeURIComponent(journalId)}/reverse`, 'POST', {}); accountingState.data = response.data; renderAccounting(); showNotification('success', 'Reversal posted'); } catch (error) { showNotification('error', error.message); }
}

function accountingOpenSource(encodedKey) {
  accountingEnsureModal();
  const key = decodeURIComponent(encodedKey);
  const source = (accountingState.data?.sourceDocuments || []).find(row => row.key === key);
  if (!source) return;
  accountingState.sourceTarget = source;
  const isPurchase = !source.kind.startsWith('sales-');
  document.getElementById('accountingModalTitle').textContent = 'Post source document';
  document.getElementById('accountingModalBody').innerHTML = `<form class="accounting-source-form" onsubmit="accountingPostSource(event)"><div class="accounting-source-summary"><span><strong>${accountingEscape(source.number)}</strong><small>${accountingEscape(source.contact || source.kind)}</small></span><b>${accountingMoney(source.gross)}</b></div><div class="accounting-form-grid two"><label><span>Posting date</span><input id="accountingSourceDate" type="date" value="${accountingAttr(source.date)}"></label>${isPurchase ? `<label><span>Expense account</span><select id="accountingSourceAccount">${accountingAccountOptions(source.accountCode, ['expense'])}</select></label><label><span>GST treatment</span><select id="accountingSourceTax"><option value="OP">OP · Out of scope / no claim</option><option value="TX9">TX9 · Claimable GST at 9%</option><option value="TX0">TX0 · Zero-rated taxable purchase</option><option value="BL">BL · Blocked input tax</option></select></label><label><span>Credit account</span><select id="accountingSourceCounter">${accountingAccountOptions(accountingState.data.settings?.defaultPayableAccount || '2000', ['asset', 'liability'])}</select></label>` : ''}</div>${isPurchase ? '<div class="accounting-notice neutral"><strong>Input GST is never claimed automatically.</strong><span>Select TX9 only when a valid tax invoice supports the claim and the expense is allowable.</span></div>' : ''}<div class="modal-actions"><button type="button" class="btn btn-secondary" onclick="closeModal('accountingModal')">Cancel</button><button type="submit" class="btn btn-primary">Post to ledger</button></div></form>`;
  openModal('accountingModal');
}

async function accountingPostSource(event) {
  event.preventDefault();
  const source = accountingState.sourceTarget;
  if (!source) return;
  const payload = { sourceKey: source.key, date: document.getElementById('accountingSourceDate')?.value, accountCode: document.getElementById('accountingSourceAccount')?.value, taxCode: document.getElementById('accountingSourceTax')?.value, counterAccount: document.getElementById('accountingSourceCounter')?.value };
  try { const response = await apiCall('/api/finance/accounting/sources/post', 'POST', payload); accountingState.data = response.data; closeModal('accountingModal'); renderAccounting(); showNotification('success', 'Document posted'); } catch (error) { showNotification('error', error.message || 'Could not post document'); }
}

function accountingOpenBankImport() {
  accountingEnsureModal();
  document.getElementById('accountingModalTitle').textContent = 'Import bank statement';
  document.getElementById('accountingModalBody').innerHTML = `<form class="accounting-source-form" onsubmit="accountingImportBankCsv(event)"><div class="accounting-form-grid two"><label><span>Bank account</span><select id="accountingImportBankAccount">${accountingAccountOptions(accountingState.data?.settings?.defaultBankAccount || '1000', ['asset'])}</select></label><label><span>Statement CSV</span><input id="accountingBankCsv" type="file" accept=".csv,text/csv" required></label></div><div class="accounting-notice neutral"><strong>Accepted columns</strong><span>Date plus Amount, or separate Debit and Credit columns. Description and Reference are optional. Duplicate rows are skipped.</span></div><div class="modal-actions"><button type="button" class="btn btn-secondary" onclick="closeModal('accountingModal')">Cancel</button><button type="submit" class="btn btn-primary">Import statement</button></div></form>`;
  openModal('accountingModal');
}

async function accountingImportBankCsv(event) {
  event.preventDefault();
  const file = document.getElementById('accountingBankCsv')?.files?.[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  form.append('bankAccount', document.getElementById('accountingImportBankAccount').value);
  try {
    const response = await apiCall('/api/finance/accounting/bank-transactions/import', 'POST', form);
    accountingState.data = response.data;
    closeModal('accountingModal');
    renderAccounting();
    const details = [response.imported ? `${response.imported} imported` : '', response.duplicates ? `${response.duplicates} duplicates skipped` : '', response.errors?.length ? `${response.errors.length} rows need review` : ''].filter(Boolean).join(' · ');
    showNotification(response.errors?.length ? 'warning' : 'success', details || 'No new transactions found');
  } catch (error) { showNotification('error', error.message || 'Could not import statement'); }
}

function accountingOpenBankTransaction() {
  accountingEnsureModal();
  document.getElementById('accountingModalTitle').textContent = 'Add bank transaction';
  document.getElementById('accountingModalBody').innerHTML = `<form class="accounting-source-form" onsubmit="accountingSaveBankTransaction(event)"><div class="accounting-form-grid two"><label><span>Date</span><input id="accountingBankDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label><label><span>Bank account</span><select id="accountingBankAccountInput">${accountingAccountOptions(accountingState.data?.settings?.defaultBankAccount || '1000', ['asset'])}</select></label><label class="span-all"><span>Description</span><input id="accountingBankDescription" required></label><label><span>Reference</span><input id="accountingBankReference"></label><label><span>Amount</span><input id="accountingBankAmount" type="number" step="0.01" required></label></div><div class="accounting-notice neutral"><strong>Amount direction</strong><span>Use a positive amount for money in and a negative amount for money out.</span></div><div class="modal-actions"><button type="button" class="btn btn-secondary" onclick="closeModal('accountingModal')">Cancel</button><button type="submit" class="btn btn-primary">Add transaction</button></div></form>`;
  openModal('accountingModal');
}

async function accountingSaveBankTransaction(event) {
  event.preventDefault();
  const payload = { date: document.getElementById('accountingBankDate').value, bankAccount: document.getElementById('accountingBankAccountInput').value, description: document.getElementById('accountingBankDescription').value, reference: document.getElementById('accountingBankReference').value, amount: document.getElementById('accountingBankAmount').value };
  try { const response = await apiCall('/api/finance/accounting/bank-transactions', 'POST', payload); accountingState.data = response.data; closeModal('accountingModal'); renderAccounting(); showNotification('success', 'Bank transaction added'); } catch (error) { showNotification('error', error.message); }
}

function accountingOpenBankMatch(transactionId) {
  accountingEnsureModal();
  const transaction = (accountingState.data?.bankTransactions || []).find(row => row.id === transactionId);
  if (!transaction) return;
  const incoming = Number(transaction.amount) > 0;
  const defaultAccount = incoming ? '1100' : '6800';
  document.getElementById('accountingModalTitle').textContent = 'Match bank transaction';
  document.getElementById('accountingModalBody').innerHTML = `<form class="accounting-source-form" onsubmit="accountingMatchBankTransaction(event,'${accountingAttr(transaction.id)}')"><div class="accounting-source-summary"><span><strong>${accountingEscape(transaction.description)}</strong><small>${accountingDate(transaction.date)} · ${accountingEscape(transaction.reference || 'No reference')}</small></span><b>${accountingMoney(transaction.amount)}</b></div><div class="accounting-form-grid two"><label><span>Match to account</span><select id="accountingBankMatchAccount">${accountingAccountOptions(defaultAccount)}</select></label><label><span>GST treatment</span><select id="accountingBankMatchTax">${incoming ? '<option value="OP">OP · No GST</option><option value="SR9">SR9 · Standard-rated receipt</option>' : '<option value="OP">OP · No GST claim</option><option value="TX9">TX9 · Claimable GST at 9%</option><option value="TX0">TX0 · Zero-rated purchase</option><option value="BL">BL · Blocked input tax</option>'}</select></label><label class="span-all"><span>Ledger description</span><input id="accountingBankMatchDescription" value="${accountingAttr(transaction.description)}"></label></div><div class="accounting-notice neutral"><strong>Posting result</strong><span>A balanced journal will be posted and linked to this statement line.</span></div><div class="modal-actions"><button type="button" class="btn btn-secondary" onclick="closeModal('accountingModal')">Cancel</button><button type="submit" class="btn btn-primary">Match and post</button></div></form>`;
  openModal('accountingModal');
}

async function accountingMatchBankTransaction(event, transactionId) {
  event.preventDefault();
  const payload = { accountCode: document.getElementById('accountingBankMatchAccount').value, taxCode: document.getElementById('accountingBankMatchTax').value, description: document.getElementById('accountingBankMatchDescription').value };
  try { const response = await apiCall(`/api/finance/accounting/bank-transactions/${encodeURIComponent(transactionId)}/match`, 'POST', payload); accountingState.data = response.data; closeModal('accountingModal'); renderAccounting(); showNotification('success', 'Bank transaction matched'); } catch (error) { showNotification('error', error.message); }
}

async function accountingDeleteBankTransaction(transactionId) {
  const confirmed = await showAppConfirm({ title: 'Delete bank transaction?', message: 'Only the imported statement row will be removed.', confirmText: 'Delete', cancelText: 'Cancel', danger: true });
  if (!confirmed) return;
  try { const response = await apiCall(`/api/finance/accounting/bank-transactions/${encodeURIComponent(transactionId)}`, 'DELETE'); accountingState.data = response.data; renderAccounting(); } catch (error) { showNotification('error', error.message); }
}

function accountingOpenAccount() {
  accountingEnsureModal();
  document.getElementById('accountingModalTitle').textContent = 'Add account';
  document.getElementById('accountingModalBody').innerHTML = `<form class="accounting-account-form" onsubmit="accountingSaveAccount(event)"><div class="accounting-form-grid two"><label><span>Account code</span><input id="accountingAccountCode" maxlength="30" required></label><label><span>Account name</span><input id="accountingAccountName" maxlength="160" required></label><label><span>Account type</span><select id="accountingAccountType"><option value="asset">Asset</option><option value="liability">Liability</option><option value="equity">Equity</option><option value="revenue">Revenue</option><option value="expense">Expense</option></select></label><label><span>Group</span><input id="accountingAccountGroup" maxlength="120"></label></div><div class="modal-actions"><button type="button" class="btn btn-secondary" onclick="closeModal('accountingModal')">Cancel</button><button type="submit" class="btn btn-primary">Add account</button></div></form>`;
  openModal('accountingModal');
}

async function accountingSaveAccount(event) {
  event.preventDefault();
  const payload = { code: document.getElementById('accountingAccountCode').value, name: document.getElementById('accountingAccountName').value, type: document.getElementById('accountingAccountType').value, group: document.getElementById('accountingAccountGroup').value };
  try { const response = await apiCall('/api/finance/accounting/accounts', 'POST', payload); accountingState.data = response.data; closeModal('accountingModal'); renderAccounting(); showNotification('success', 'Account added'); } catch (error) { showNotification('error', error.message); }
}

async function accountingToggleAccount(code, active) {
  const account = (accountingState.data?.accounts || []).find(row => row.code === code);
  if (!account) return;
  try { const response = await apiCall(`/api/finance/accounting/accounts/${encodeURIComponent(code)}`, 'PUT', { ...account, active }); accountingState.data = response.data; renderAccounting(); } catch (error) { showNotification('error', error.message); }
}

async function accountingSaveSettings(event) {
  event.preventDefault();
  const payload = { gstRegistered: document.getElementById('accountingGstRegistered').checked, gstRegistrationNumber: document.getElementById('accountingGstNumber').value, gstRate: document.getElementById('accountingGstRate').value, filingFrequency: document.getElementById('accountingFilingFrequency').value, financialYearStartMonth: document.getElementById('accountingYearStart').value, accountingBasis: document.getElementById('accountingBasis').value, recordRetentionYears: document.getElementById('accountingRetention').value, periodLockDate: document.getElementById('accountingLockDate').value, defaultBankAccount: document.getElementById('accountingBankAccount').value, defaultReceivableAccount: document.getElementById('accountingReceivableAccount').value, defaultPayableAccount: document.getElementById('accountingPayableAccount').value };
  try { const response = await apiCall('/api/finance/accounting/settings', 'PUT', payload); accountingState.data = response.data; renderAccounting(); showNotification('success', 'Accounting settings saved'); } catch (error) { showNotification('error', error.message); }
}
