const costingState = {
  documents: [],
  current: null,
  baseDocument: null,
  vendors: [],
  lookupsPromise: null,
  catalog: [],
  catalogTimer: null,
  saveTimer: null,
  activeSave: null,
  changeVersion: 0,
  listQuery: '',
  listRequestSeq: 0,
  listLoading: false,
  statuses: [],
  mineOnly: false,
  sort: 'updated',
  summaryGrouping: 'category',
  addCategory: '',
  collapsedCategories: {},
  dragLineIndex: null,
  dragLineIndexes: [],
  dragWholeLineGroup: false,
  dragCategory: '',
  dragSubprojectId: '',
  activeSubprojectId: '',
  quotationSyncMode: '',
  contextDocumentId: '',
  contextLineId: '',
  inventoryLinkLineId: '',
  inventoryLinkCatalog: [],
  inventoryLinkTimer: null,
  inventoryLinkSelection: null
};

async function costingHandleRealtimeChanges(changes) {
  const costingIds = [...new Set((Array.isArray(changes) ? changes : [])
    .map(row => String(row?.costingId || '').trim())
    .filter(Boolean))];
  if (!costingIds.length) return false;
  const currentId = String(costingState.current?.id || '');
  if (currentId && costingIds.includes(currentId)) {
    const response = await apiCall(`/api/costings/${encodeURIComponent(currentId)}`);
    const latest = response.data;
    const base = costingState.baseDocument || costingState.current;
    const hasLocalChanges = !financeValuesEqual(costingState.current, base);
    if (hasLocalChanges) {
      costingState.current = financeMergeDocumentConflict(
        base,
        costingState.current,
        latest
      );
      costingState.current.documentVersion = base.documentVersion;
    } else {
      costingState.current = latest;
      costingState.baseDocument = financeCloneDocument(latest);
    }
    costingRenderEditor();
  }
  if (!currentId) {
    await Promise.all(costingIds.map(async costingId => {
      try {
        const response = await apiCall(`/api/costings/${encodeURIComponent(costingId)}`);
        const detail = response.data;
        const summary = {
          ...detail,
          lineCount: (detail.lineItems || []).length
        };
        const index = costingState.documents.findIndex(row => String(row.id) === costingId);
        if (index >= 0) costingState.documents[index] = summary;
        else costingState.documents.unshift(summary);
      } catch (error) {
        if (error?.status === 404) {
          costingState.documents = costingState.documents.filter(
            row => String(row.id) !== costingId
          );
        }
      }
    }));
    costingRenderList();
  }
  return true;
}

function costingRoot() {
  return document.getElementById('costing-page-root');
}

function costingEscape(value) {
  return typeof financeEscape === 'function'
    ? financeEscape(value)
    : escapeHtml(String(value ?? ''));
}

function costingAttr(value) {
  return typeof financeEscapeAttr === 'function'
    ? financeEscapeAttr(value)
    : escapeHtmlAttr(String(value ?? ''));
}

function costingNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function costingMoney(value) {
  return typeof financeMoney === 'function'
    ? financeMoney(value)
    : `$${costingNumber(value).toFixed(2)}`;
}

function costingFormatMoneyInput(input) {
  if (!input) return;
  input.value = costingNumber(input.value).toFixed(2);
}

function costingLineRecalculate(line, mode = 'cost') {
  line.quantity = Math.max(0, costingNumber(line.quantity, 1));
  line.multiplier = Math.max(0, costingNumber(line.multiplier, 1));
  line.itemCost = Math.max(0, costingNumber(line.itemCost));
  line.costTotal = line.quantity * line.multiplier * line.itemCost;
  line.targetMarginPercent = Math.max(-100, Math.min(9999, costingNumber(line.targetMarginPercent, 20)));
  line.calculatedSalePrice = Math.max(0, line.costTotal * (1 + line.targetMarginPercent / 100));
  if (mode === 'margin-percent') {
    line.salePrice = line.calculatedSalePrice;
  } else if (mode === 'margin-amount') {
    line.salePrice = Math.max(0, line.costTotal + costingNumber(line.marginAmount));
    line.targetMarginPercent = line.costTotal
      ? ((line.salePrice - line.costTotal) / line.costTotal) * 100
      : (line.salePrice ? 100 : 0);
    line.calculatedSalePrice = line.salePrice;
  } else {
    line.salePrice = Math.max(0, costingNumber(line.salePrice, line.calculatedSalePrice));
  }
  line.marginAmount = line.salePrice - line.costTotal;
  line.marginPercent = line.costTotal
    ? (line.marginAmount / line.costTotal) * 100
    : (line.salePrice ? 100 : 0);
  line.calculatedMarginAmount = line.calculatedSalePrice - line.costTotal;
  line.saleDifference = line.salePrice - line.calculatedSalePrice;
  return line;
}

function costingLines() {
  return costingState.current?.lineItems || [];
}

function costingSubprojects(document = costingState.current) {
  if (!document) return [{ id: 'main', name: 'Main Room' }];
  if (!Array.isArray(document.subprojects) || !document.subprojects.length) {
    document.subprojects = [{ id: 'main', name: 'Main Room' }];
  }
  return document.subprojects;
}

function costingActiveSubprojectId(document = costingState.current) {
  const rows = costingSubprojects(document);
  if (!rows.some(row => row.id === costingState.activeSubprojectId)) {
    costingState.activeSubprojectId = rows[0]?.id || 'main';
  }
  return costingState.activeSubprojectId;
}

function costingVisibleLines(subprojectId = costingActiveSubprojectId()) {
  return costingLines().filter(
    line => String(line.subprojectId || 'main') === String(subprojectId || 'main')
  );
}

function costingCategories(subprojectId = costingActiveSubprojectId()) {
  const categories = [];
  costingVisibleLines(subprojectId).forEach(line => {
    const name = String(line.category || 'General').trim() || 'General';
    if (!categories.includes(name)) categories.push(name);
  });
  return categories;
}

function costingCategoryLines(category, subprojectId = costingActiveSubprojectId()) {
  return costingLines().filter(line => String(line.category || 'General') === String(category || 'General')
    && String(line.subprojectId || 'main') === String(subprojectId || 'main'));
}

function costingCategoryDefaults(category, subprojectId = costingActiveSubprojectId()) {
  const line = costingCategoryLines(category, subprojectId)[0];
  return {
    multiplierLabel: line?.multiplierLabel === 'Day' ? 'Day' : 'Mult',
    multiplier: Math.max(0, costingNumber(line?.multiplier, 1)),
    targetMarginPercent: Math.max(-100, Math.min(9999, costingNumber(line?.targetMarginPercent, 20)))
  };
}

function costingLineItemKey(line) {
  const catalogKey = String(line?.catalogKey || '').trim().toLowerCase();
  if (catalogKey) return `catalog:${catalogKey}`;
  const sourceIds = [...new Set((line?.sourceAssetIds || [])
    .map(value => String(value || '').trim().toLowerCase()).filter(Boolean))].sort();
  if (sourceIds.length) return `assets:${sourceIds.join('|')}`;
  return `custom:${[
    line?.description, line?.brand, line?.model, line?.departmentCode,
    line?.category || 'General'
  ].map(value => String(value || '').trim().toLowerCase()).join('|')}`;
}

function costingLineNameKey(lineOrName) {
  const value = typeof lineOrName === 'object'
    ? lineOrName?.description
    : lineOrName;
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function costingNewPricingBindingId() {
  return `pricing_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function costingUnboundPriceNames() {
  if (!costingState.current) return [];
  if (!Array.isArray(costingState.current.unboundPriceNames)) {
    costingState.current.unboundPriceNames = [];
  }
  return costingState.current.unboundPriceNames;
}

function costingApplyUnboundNamePolicy(line) {
  if (!line) return;
  const nameKey = costingLineNameKey(line);
  if (nameKey && costingUnboundPriceNames().includes(nameKey)) {
    line.pricingBindingId = costingNewPricingBindingId();
  } else {
    line.pricingBindingId = '';
  }
}

function costingLineSaleGroupKey(line) {
  const bindingId = String(line?.pricingBindingId || '').trim().toLowerCase();
  if (bindingId) return `binding:${bindingId}`;
  const nameKey = costingLineNameKey(line);
  return nameKey ? `name:${nameKey}` : costingLineItemKey(line);
}

function costingLineUnitSale(line, field = 'salePrice') {
  const divisor = Math.max(0, costingNumber(line?.quantity))
    * Math.max(0, costingNumber(line?.multiplier));
  const total = Math.max(0, costingNumber(line?.[field]));
  return divisor ? total / divisor : total;
}

function costingSetSaleGroupUnitPrice(index, unitPrice) {
  const source = costingLines()[index];
  if (!source) return;
  const groupKey = costingLineSaleGroupKey(source);
  costingLines().forEach(line => {
    if (costingLineSaleGroupKey(line) !== groupKey) return;
    const divisor = Math.max(0, costingNumber(line.quantity))
      * Math.max(0, costingNumber(line.multiplier));
    line.salePrice = Math.round(
      Math.max(0, costingNumber(unitPrice)) * (divisor || 1) * 100
    ) / 100;
    costingLineRecalculate(line, 'sale');
  });
}

function costingEqualiseSaleGroups(lines) {
  const groups = new Map();
  (lines || []).forEach(line => {
    const key = costingLineSaleGroupKey(line);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  });
  groups.forEach(rows => {
    if (rows.length < 2) return;
    const totalSale = rows.reduce(
      (sum, line) => sum + Math.max(0, costingNumber(line.salePrice)), 0
    );
    const totalUnits = rows.reduce(
      (sum, line) => sum + Math.max(0, costingNumber(line.quantity))
        * Math.max(0, costingNumber(line.multiplier)), 0
    );
    const unitPrice = totalUnits ? totalSale / totalUnits : totalSale / rows.length;
    rows.forEach(line => {
      const divisor = Math.max(0, costingNumber(line.quantity))
        * Math.max(0, costingNumber(line.multiplier));
      line.salePrice = Math.round(unitPrice * (divisor || 1) * 100) / 100;
      costingLineRecalculate(line, 'sale');
    });
  });
}

function costingPriceState(actualPrice, costPrice, targetPrice) {
  const actual = costingNumber(actualPrice);
  const cost = costingNumber(costPrice);
  const target = costingNumber(targetPrice);
  if (actual < cost - 0.005) return 'is-below-cost';
  if (actual < target - 0.005) return 'is-below-margin';
  return 'is-above-margin';
}

function costingUnitPriceState(line) {
  return costingPriceState(
    costingLineUnitSale(line),
    line.itemCost,
    costingLineUnitSale(line, 'calculatedSalePrice')
  );
}

function costingSaleState(line) {
  return costingPriceState(
    line.salePrice,
    line.costTotal,
    line.calculatedSalePrice
  );
}

function costingComparisonMoney(actualPrice, costPrice) {
  const difference = costingNumber(actualPrice) - costingNumber(costPrice);
  return difference
    ? `${difference > 0 ? '+' : ''}${costingMoney(difference)}`
    : '$0.00';
}

const COSTING_PRICE_STATE_CLASSES = [
  'is-above-margin',
  'is-below-margin',
  'is-below-cost'
];

function costingApplyPriceState(element, state) {
  if (!element) return;
  COSTING_PRICE_STATE_CLASSES.forEach(className => {
    element.classList.toggle(className, className === state);
  });
}

function costingMultiplierHeaderLabel(category) {
  return costingCategoryDefaults(category).multiplierLabel === 'Day' ? 'Day(s)' : 'Mult';
}

function costingAdjustment(category, subprojectId = costingActiveSubprojectId()) {
  if (!costingState.current) return { category, subprojectId, amount: 0 };
  let row = (costingState.current.categoryAdjustments || []).find(
    item => String(item.category || '').toLowerCase() === String(category).toLowerCase()
      && String(item.subprojectId || 'main') === String(subprojectId || 'main')
  );
  if (!row) {
    row = { category, subprojectId, amount: 0 };
    (costingState.current.categoryAdjustments ||= []).push(row);
  }
  return row;
}

function costingCategoryTotals(category, subprojectId = costingActiveSubprojectId()) {
  const lines = costingCategoryLines(category, subprojectId);
  const cost = lines.reduce((sum, line) => sum + costingNumber(line.costTotal), 0);
  const rawSale = lines.reduce((sum, line) => sum + costingNumber(line.salePrice), 0);
  const adjustment = costingNumber(costingAdjustment(category, subprojectId).amount);
  const charged = Math.max(0, rawSale + adjustment);
  return { category, cost, rawSale, adjustment: charged - rawSale, charged, profit: charged - cost };
}

function costingTotals() {
  const total = { cost: 0, sale: 0, profit: 0 };
  costingSubprojects().forEach(room => {
    costingCategories(room.id).forEach(category => {
      const row = costingCategoryTotals(category, room.id);
      total.cost += row.cost;
      total.sale += row.charged;
      total.profit += row.profit;
    });
  });
  return total;
}

function costingSummaryRows() {
  const byVendor = costingState.summaryGrouping === 'vendor';
  const rows = [];
  const rowsByKey = new Map();
  costingVisibleLines().forEach(line => {
    const label = byVendor
      ? (String(line.vendorName || '').trim() || 'Unassigned')
      : (String(line.category || '').trim() || 'General');
    const key = label.toLowerCase();
    let row = rowsByKey.get(key);
    if (!row) {
      row = { label, amount: 0 };
      rowsByKey.set(key, row);
      rows.push(row);
    }
    row.amount += costingNumber(line.costTotal);
  });
  return rows;
}

function costingSummaryRowsMarkup() {
  const emptyLabel = costingState.summaryGrouping === 'vendor'
    ? 'No vendors yet.'
    : 'No categories yet.';
  return costingSummaryRows().map(row => `<div><span>${costingEscape(row.label)}</span><strong>${costingEscape(costingMoney(row.amount))}</strong></div>`).join('')
    || `<p class="costing-muted">${emptyLabel}</p>`;
}

function costingSummaryHeading() {
  const activeRoom = costingSubprojects().find(
    row => row.id === costingActiveSubprojectId()
  ) || costingSubprojects()[0];
  return `${activeRoom?.name || 'Main Room'} Cost by ${costingState.summaryGrouping === 'vendor' ? 'Vendor' : 'Category'}`;
}

function costingSetSummaryGrouping(grouping) {
  costingState.summaryGrouping = grouping === 'vendor' ? 'vendor' : 'category';
  document.querySelectorAll('[data-costing-summary-group]').forEach(button => {
    const selected = button.dataset.costingSummaryGroup === costingState.summaryGrouping;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', selected ? 'true' : 'false');
  });
  const heading = document.getElementById('costingBreakdownHeading');
  const list = document.getElementById('costingBreakdownList');
  if (heading) heading.textContent = costingSummaryHeading();
  if (list) list.innerHTML = costingSummaryRowsMarkup();
}

function costingVendorManagementRows() {
  if (!costingState.current) return [];
  const saved = new Map((costingState.current.vendorManagement || []).map(row => [row.key, row]));
  const rows = [];
  const byKey = new Map();
  costingLines().forEach(line => {
    const name = String(line.vendorName || '').trim();
    if (!name || name.toLowerCase() === 'self') return;
    const key = line.vendorId
      ? `${String(line.vendorType || 'vendor').toLowerCase()}:${line.vendorId}`
      : `name:${name.toLowerCase().replace(/\s+/g, ' ')}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        vendorId: line.vendorId || '',
        vendorType: line.vendorType || 'vendor',
        vendorName: name,
        mode: saved.get(key)?.mode === 'outsourced' ? 'outsourced' : 'dry-hire',
        itemCount: 0,
        quantity: 0,
        amount: 0
      };
      byKey.set(key, row);
      rows.push(row);
    }
    row.itemCount += 1;
    row.quantity += Math.max(0, costingNumber(line.quantity));
    row.amount += Math.max(0, costingNumber(line.costTotal));
  });
  costingState.current.vendorManagement = rows;
  return rows;
}

function costingVendorManagementMarkup(readOnly = false) {
  const rows = costingVendorManagementRows();
  if (!rows.length) return '';
  return `<section class="costing-side-card vendor-management-card">
    <header><h3>Vendor Management</h3><button type="button" class="vendor-management-open" onclick="costingOpenVendorManagement()">Open</button></header>
    <p class="vendor-management-help">Self pickup items appear as loans in Plan. Delivered items go directly to the venue.</p>
  </section>`;
}

function costingVendorManagementDialogMarkup() {
  const readOnly = costingState.current?.status === 'converted';
  const rows = costingVendorManagementRows();
  return `<div class="modal-content vendor-management-dialog">
    <div class="modal-header">
      <div><h3 class="modal-title">Vendor Management</h3><p>Choose how each vendor fulfils their equipment.</p></div>
      <button type="button" class="close-btn" aria-label="Close vendor management" onclick="closeModal('costingVendorManagementModal')">&times;</button>
    </div>
    <div class="vendor-management-list">
      ${rows.map(row => {
        const key = encodeURIComponent(row.key || '');
        const dryHire = row.mode !== 'outsourced';
        return `<div class="vendor-management-row" data-vendor-management-key="${costingAttr(row.key || '')}">
          <div class="vendor-management-details"><strong>${costingEscape(row.vendorName || 'Vendor')}</strong><small data-vendor-management-meta>${Number(row.itemCount || 0)} item line${Number(row.itemCount || 0) === 1 ? '' : 's'} &middot; ${costingEscape(costingMoney(row.amount))}</small></div>
          <div class="vendor-mode-toggle" role="radiogroup" aria-label="Fulfilment for ${costingAttr(row.vendorName || 'vendor')}">
            <button type="button" role="radio" aria-checked="${dryHire}" class="${dryHire ? 'selected' : ''}" ${readOnly ? 'disabled' : ''} onclick="costingSetVendorManagement('${costingAttr(key)}','dry-hire')">Self Pickup</button>
            <button type="button" role="radio" aria-checked="${!dryHire}" class="${!dryHire ? 'selected' : ''}" ${readOnly ? 'disabled' : ''} onclick="costingSetVendorManagement('${costingAttr(key)}','outsourced')">Delivered</button>
          </div>
        </div>`;
      }).join('') || '<p class="vendor-management-empty">No external vendors in this costing.</p>'}
    </div>
    <p class="vendor-management-help">Self pickup items appear as loans in Plan. Delivered items go directly to the venue.</p>
  </div>`;
}

function costingOpenVendorManagement() {
  let modal = document.getElementById('costingVendorManagementModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'costingVendorManagementModal';
    modal.className = 'modal vendor-management-modal';
    modal.addEventListener('click', event => {
      if (event.target === modal) closeModal(modal.id);
    });
    document.body.appendChild(modal);
  }
  modal.innerHTML = costingVendorManagementDialogMarkup();
  openModal(modal.id);
}

function costingSetVendorManagement(encodedKey, mode) {
  const key = decodeURIComponent(encodedKey || '');
  const row = costingVendorManagementRows().find(item => item.key === key);
  if (!row || !['dry-hire', 'outsourced'].includes(mode)) return;
  row.mode = mode;
  costingState.changeVersion += 1;
  costingQueueSave();
  const modal = document.getElementById('costingVendorManagementModal');
  if (modal?.classList.contains('active')) {
    modal.innerHTML = costingVendorManagementDialogMarkup();
  }
}

function costingRefreshVendorManagementAmounts() {
  costingVendorManagementRows().forEach(row => {
    const root = document.querySelector(
      `[data-vendor-management-key="${CSS.escape(row.key || '')}"]`
    );
    const meta = root?.querySelector('[data-vendor-management-meta]');
    if (meta) meta.textContent = `${Number(row.itemCount || 0)} item line${Number(row.itemCount || 0) === 1 ? '' : 's'} · ${costingMoney(row.amount)}`;
  });
}

function loadCosting() {
  costingState.current = null;
  // Render/request the costing list immediately. Vendor suggestions are useful
  // when editing, but loading Manpower & Transport must never hold the whole
  // page on its initial placeholder.
  const listPromise = costingLoadList();
  if (!costingState.lookupsPromise) {
    costingState.lookupsPromise = costingLoadLookups().finally(() => {
      costingState.lookupsPromise = null;
    });
  }
  return listPromise;
}

async function costingLoadLookups() {
  try {
    const response = await apiCall('/api/costings/lookups');
    costingState.vendors = response.data?.vendors || [];
  } catch {
    costingState.vendors = [];
  }
}

async function costingLoadList() {
  const root = costingRoot();
  if (!root) return;
  const requestSeq = ++costingState.listRequestSeq;
  costingState.listLoading = true;
  if (!root.querySelector('.costing-toolbar')) {
    root.innerHTML = '<div class="loading">Loading costings...</div>';
  }
  try {
    const params = new URLSearchParams();
    if (costingState.listQuery) params.set('query', costingState.listQuery);
    if (costingListCanToggleMine() && costingState.mineOnly) params.set('mine', '1');
    costingState.statuses.forEach(status => params.append('status', status));
    const response = await apiCall(`/api/costings?${params.toString()}`);
    if (requestSeq !== costingState.listRequestSeq) return;
    costingState.documents = response.data || [];
    costingRenderList();
  } catch (error) {
    if (requestSeq !== costingState.listRequestSeq) return;
    const results = document.getElementById('costingListResults');
    if (results) results.innerHTML = '<div class="finance-empty">Could not load costings.</div>';
    else root.innerHTML = '<div class="finance-empty">Could not load costings.</div>';
    showNotification('error', error.message || 'Failed to load costings');
  } finally {
    if (requestSeq === costingState.listRequestSeq) costingState.listLoading = false;
  }
}

function costingSortedDocuments() {
  const rows = [...costingState.documents];
  if (costingState.sort === 'project') {
    rows.sort((a, b) => String(a.projectName || '').localeCompare(String(b.projectName || '')));
  } else {
    rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
  return rows;
}

function costingListSortLabel(value = costingState.sort) {
  return value === 'project' ? 'Project name' : 'Last modified';
}

function costingListSortControl() {
  return `
    <div class="finance-custom-control finance-list-sort-control" onclick="event.stopPropagation()">
      <button type="button" class="finance-list-sort-button" onclick="financeToggleMenu('costing-list-sort-menu',event)" aria-haspopup="menu">
        <span id="costingListSortLabel">${costingEscape(costingListSortLabel())}</span><span aria-hidden="true">v</span>
      </button>
      <div class="finance-custom-menu finance-list-sort-menu" id="costing-list-sort-menu" role="menu">
        ${['updated', 'project'].map(value => `<button type="button" class="${value === costingState.sort ? 'selected' : ''}" onclick="costingSetListSort('${value}')">${costingEscape(costingListSortLabel(value))}</button>`).join('')}
      </div>
    </div>`;
}

function costingSetListSort(value) {
  costingState.sort = value === 'project' ? 'project' : 'updated';
  if (typeof financeCloseMenus === 'function') financeCloseMenus();
  const label = document.getElementById('costingListSortLabel');
  if (label) label.textContent = costingListSortLabel();
  costingRenderList();
}

function costingListCanToggleMine() {
  const role = typeof currentUserRole === 'function'
    ? currentUserRole()
    : String(window.currentUser?.role || '').toLowerCase();
  return role === 'admin'
    || (typeof isPlatformAdminUser === 'function' && isPlatformAdminUser());
}

function costingListShowsSalesperson() {
  return costingListCanToggleMine();
}

function costingToggleMineOnly() {
  costingState.mineOnly = !costingState.mineOnly;
  const toggle = document.querySelector('.costing-list-mine-toggle');
  toggle?.classList.toggle('on', costingState.mineOnly);
  toggle?.setAttribute('aria-checked', costingState.mineOnly ? 'true' : 'false');
  costingLoadList();
}

function costingListResultsHtml() {
  const rows = costingSortedDocuments();
  const showSalesperson = costingListShowsSalesperson();
  const counts = costingState.documents.reduce((result, row) => {
    result[row.status] = (result[row.status] || 0) + 1;
    return result;
  }, {});
  return `<div class="finance-card" id="costingListResults">
    <div class="finance-list-status-filters" aria-label="Filter costing statuses">
      <button type="button" class="finance-list-filter ${!costingState.statuses.length ? 'active' : ''}" onclick="costingToggleStatus('all')">All<span>${costingState.documents.length}</span></button>
      ${['draft', 'linked', 'converted'].map(status => `<button type="button" class="finance-list-filter status-${status} ${costingState.statuses.includes(status) ? 'active' : ''}" aria-pressed="${costingState.statuses.includes(status) ? 'true' : 'false'}" onclick="costingToggleStatus('${status}')">${status === 'draft' ? 'Draft' : status === 'linked' ? 'Quotation linked' : 'Quotation made'}<span>${counts[status] || 0}</span></button>`).join('')}
    </div>
    ${rows.length ? `<div class="costing-list-wrap"><table class="finance-list-table costing-list-table">
      <thead><tr><th>Number</th><th>Project Name</th>${showSalesperson ? '<th>Salesperson</th>' : ''}<th class="finance-list-status-heading">Status</th><th>Items</th><th style="text-align:right;">Client price</th><th style="text-align:right;">Profit</th><th>Last modified</th></tr></thead>
      <tbody>${rows.map(row => `<tr class="finance-list-row" data-costing-id="${costingAttr(row.id)}" onclick="costingOpen('${costingAttr(row.id)}')" oncontextmenu="costingOpenContextMenu(event,'${costingAttr(row.id)}')">
        <td><span class="finance-doc-number">${costingEscape(row.convertedQuotationNumber || 'Not linked')}</span><br><small>${row.convertedQuotationNumber ? 'Linked costing' : 'Costing draft'}</small></td>
        <td class="finance-project-cell"><strong>${costingEscape(row.projectName || 'Project name required')}</strong>${row.eventLocation ? `<small class="finance-project-dates">${costingEscape(row.eventLocation)}</small>` : ''}</td>
        ${showSalesperson ? `<td><strong>${costingEscape(row.salesperson || row.createdBy || 'Unassigned')}</strong>${row.salespersonUsername || row.createdBy ? `<br><small>${costingEscape(row.salespersonUsername || row.createdBy)}</small>` : ''}</td>` : ''}
        <td class="finance-list-status-cell"><span class="costing-status is-${costingAttr(row.status)}">${row.status === 'converted' ? 'Quotation made' : row.status === 'linked' ? 'Quotation linked' : 'Draft'}</span></td>
        <td>${Number(row.lineCount || 0)}</td>
        <td style="text-align:right;font-weight:750;">${costingEscape(costingMoney(row.totals?.sale))}</td>
        <td class="${costingNumber(row.totals?.profit) < 0 ? 'costing-negative' : 'costing-positive'}" style="text-align:right;font-weight:750;">${costingEscape(costingMoney(row.totals?.profit))}</td>
        <td>${costingEscape(typeof financeDateTime === 'function' ? financeDateTime(row.updatedAt) : String(row.updatedAt || '').slice(0, 16).replace('T', ' '))}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div class="finance-list-pagination"><span>Showing ${rows.length} costing${rows.length === 1 ? '' : 's'}</span></div>` : '<div class="finance-empty">No costings match the current search or filters.<br><button type="button" class="btn btn-primary" style="margin-top:14px" onclick="costingCreate()">Create the first costing</button></div>'}
  </div>`;
}

function costingRenderList() {
  const root = costingRoot();
  if (!root) return;
  const existingResults = document.getElementById('costingListResults');
  if (existingResults && root.contains(existingResults)) {
    existingResults.outerHTML = costingListResultsHtml();
    return;
  }
  const showMineToggle = costingListCanToggleMine();
  root.innerHTML = `
    <div class="finance-toolbar costing-toolbar">
      <div class="finance-toolbar-heading"><div class="finance-toolbar-title-line"><h2>Costings</h2>
        ${showMineToggle ? `<button type="button" class="finance-switch finance-list-mine-toggle costing-list-mine-toggle ${costingState.mineOnly ? 'on' : ''}" role="switch" aria-checked="${costingState.mineOnly ? 'true' : 'false'}" onclick="costingToggleMineOnly()"><span aria-hidden="true"></span>My costings</button>` : ''}
        </div>
        <p class="finance-subtitle">Your costings, linked quotations and project profitability.</p></div>
      <div class="finance-toolbar-actions">
        <input class="finance-search" type="search" value="${costingAttr(costingState.listQuery)}" placeholder="Search costings..." autocomplete="off" oninput="costingQueueListSearch(this.value)">
        ${costingListSortControl()}
        <button type="button" class="btn btn-primary" onclick="costingCreate()">+ New Costing</button>
      </div>
    </div>
    ${costingListResultsHtml()}`;
}

function costingQueueListSearch(value) {
  costingState.listQuery = String(value || '').trim();
  clearTimeout(costingState.listTimer);
  costingState.listTimer = setTimeout(costingLoadList, 350);
}

function costingToggleStatus(status) {
  if (status === 'all') costingState.statuses = [];
  else costingState.statuses = costingState.statuses.includes(status)
    ? costingState.statuses.filter(value => value !== status)
    : [...costingState.statuses, status];
  costingLoadList();
}

function costingEnsureContextMenu() {
  let menu = document.getElementById('costingContextMenu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'costingContextMenu';
  menu.className = 'finance-quotation-context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" role="menuitem" onclick="event.stopPropagation();costingEditFromMenu()"><span>Edit costing</span></button>
    <button type="button" role="menuitem" onclick="event.stopPropagation();costingDuplicateFromMenu()"><span>Duplicate costing</span></button>
    <button type="button" class="danger" role="menuitem" onclick="event.stopPropagation();costingDeleteFromMenu()"><span>Delete costing</span></button>`;
  document.body.appendChild(menu);
  return menu;
}

function costingCloseContextMenu() {
  document.getElementById('costingContextMenu')?.classList.remove('open');
  document.querySelectorAll('.costing-list-table .context-open').forEach(row => row.classList.remove('context-open'));
  costingState.contextDocumentId = '';
}

function costingOpenContextMenu(event, documentId) {
  event.preventDefault();
  event.stopPropagation();
  costingCloseContextMenu();
  const menu = costingEnsureContextMenu();
  costingState.contextDocumentId = documentId;
  document.querySelector(`[data-costing-id="${CSS.escape(String(documentId))}"]`)?.classList.add('context-open');
  menu.classList.add('open');
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
  menu.querySelector('button')?.focus();
}

function costingEditFromMenu() {
  const id = costingState.contextDocumentId;
  costingCloseContextMenu();
  if (id) costingOpen(id);
}

async function costingDuplicateFromMenu() {
  const id = costingState.contextDocumentId;
  costingCloseContextMenu();
  if (!id) return;
  try {
    const response = await apiCall(`/api/costings/${encodeURIComponent(id)}/duplicate`, 'POST', {});
    showNotification('success', `${response.data.projectName} created`);
    costingLoadList();
  } catch (error) {
    showNotification('error', error.message || 'Failed to duplicate costing');
  }
}

async function costingDeleteFromMenu() {
  const id = costingState.contextDocumentId;
  const source = costingState.documents.find(row => String(row.id) === String(id));
  costingCloseContextMenu();
  if (!id) return;
  const confirmed = await showAppConfirm({
    title: 'Delete costing?',
    message: `Delete the costing for ${source?.projectName || 'this project'}? Its quotation will be kept and unlinked.`,
    confirmText: 'Delete Costing',
    variant: 'danger'
  });
  if (!confirmed) return;
  try {
    await apiCall(`/api/costings/${encodeURIComponent(id)}`, 'DELETE');
    showNotification('success', 'Costing deleted');
    costingLoadList();
  } catch (error) {
    showNotification('error', error.message || 'Failed to delete costing');
  }
}

async function costingCreate() {
  const details = await showAppForm({
    title: 'New Costing',
    message: 'Start with the project details. Only Project Name is required.',
    confirmText: 'Create Costing',
    fields: [
      { name: 'projectName', label: 'Project Name', placeholder: 'Enter project name', required: true, maxLength: 500 },
      { name: 'eventLocation', label: 'Location (optional)', placeholder: 'Enter location', maxLength: 600 }
    ]
  });
  const projectName = String(details?.projectName || '').trim();
  if (!String(projectName || '').trim()) return;
  try {
    const response = await apiCall('/api/costings', 'POST', {
      projectName,
      eventLocation: String(details?.eventLocation || '').trim()
    });
    costingState.current = response.data;
    costingState.baseDocument = financeCloneDocument(response.data);
    costingState.activeSubprojectId = '';
    costingState.quotationSyncMode = '';
    if (typeof updateAppDetailHistory === 'function') {
      updateAppDetailHistory(`/costing/${encodeURIComponent(costingState.current.id)}`);
    }
    costingRenderEditor();
  } catch (error) {
    showNotification('error', error.message || 'Failed to create costing');
  }
}

async function costingOpen(id, options = {}) {
  const root = costingRoot();
  if (root) root.innerHTML = '<div class="loading">Opening costing...</div>';
  if (options.updateHistory !== false && typeof updateAppDetailHistory === 'function') {
    updateAppDetailHistory(`/costing/${encodeURIComponent(id)}`, options.replaceHistory === true);
  }
  try {
    const response = await apiCall(`/api/costings/${encodeURIComponent(id)}`);
    costingState.current = response.data;
    costingState.baseDocument = financeCloneDocument(response.data);
    costingState.activeSubprojectId = '';
    costingState.quotationSyncMode = '';
    costingLines().forEach(line => costingLineRecalculate(line));
    costingRenderEditor();
  } catch (error) {
    if (options.updateHistory !== false && typeof updateAppDetailHistory === 'function') {
      updateAppDetailHistory('/costing', true);
    }
    showNotification('error', error.message || 'Failed to open costing');
    costingLoadList();
  }
}

function costingVendorOptions() {
  return `<datalist id="costingVendorOptions"><option value="Self" label="Self"></option>${costingState.vendors.map(row => `<option value="${costingAttr(row.name)}" label="${costingAttr(row.label || (row.type === 'worker' ? 'Worker' : 'Vendor'))}"></option>`).join('')}</datalist>`;
}

function costingVendorHue(value) {
  const name = String(value || '').trim().toLowerCase();
  let hash = 17;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

function costingLineIsInventoryLinked(line) {
  if (typeof line?.inventoryLinked === 'boolean') return line.inventoryLinked;
  return Array.isArray(line?.sourceAssetIds) && line.sourceAssetIds.some(
    assetId => String(assetId || '').trim()
  );
}

function costingSelfLinkClass(line) {
  if (String(line?.vendorName || '').trim().toLowerCase() !== 'self') return '';
  return costingLineIsInventoryLinked(line) ? 'is-self-linked' : 'is-self-unlinked';
}

function costingVendorColourChanged(input, lineIndex = -1) {
  if (!input) return;
  const name = String(input.value || '').trim();
  const isSelf = name.toLowerCase() === 'self';
  const linked = costingLineIsInventoryLinked(costingLines()[lineIndex]);
  input.classList.toggle('is-self', isSelf);
  input.classList.toggle('is-self-linked', isSelf && linked);
  input.classList.toggle('is-self-unlinked', isSelf && !linked);
  input.classList.toggle('is-empty', !name);
  input.style.setProperty('--vendor-hue', String(costingVendorHue(name)));
}

function costingEnsureLineContextMenu() {
  let menu = document.getElementById('costingLineContextMenu');
  if (menu) return menu;
  menu = document.createElement('div');
  menu.id = 'costingLineContextMenu';
  menu.className = 'finance-quotation-context-menu';
  menu.setAttribute('role', 'menu');
  document.body.appendChild(menu);
  return menu;
}

function costingCloseLineContextMenu() {
  document.getElementById('costingLineContextMenu')?.classList.remove('open');
  document.querySelectorAll('.costing-line.context-open').forEach(
    row => row.classList.remove('context-open')
  );
  costingState.contextLineId = '';
}

function costingOpenLineContextMenu(event, lineId) {
  const line = costingLines().find(row => String(row.id) === String(lineId));
  const linked = costingLineIsInventoryLinked(line);
  const self = String(line?.vendorName || '').trim().toLowerCase() === 'self';
  if (!line || costingState.current?.status === 'converted') return;
  event.preventDefault();
  event.stopPropagation();
  costingCloseLineContextMenu();
  const menu = costingEnsureLineContextMenu();
  costingState.contextLineId = String(lineId);
  document.querySelector(`.costing-line[data-costing-line-id="${CSS.escape(String(lineId))}"]`)?.classList.add('context-open');
  const matchingNames = costingSameNameLines(line);
  const priceAction = matchingNames.length > 1
    ? `<button type="button" role="menuitem" onclick="event.stopPropagation();${costingSameNamePricesLinked(matchingNames) ? 'costingUnbindSameNamePricesFromMenu()' : 'costingLinkSameNamePricesFromMenu()'}"><span>${costingSameNamePricesLinked(matchingNames) ? 'Unbind unit prices' : 'Link unit prices'}</span></button>`
    : '';
  const inventoryActions = linked
    ? `${self ? '<button type="button" role="menuitem" onclick="event.stopPropagation();costingOpenInventoryLinkFromMenu()"><span>Change inventory link</span></button>' : ''}<button type="button" role="menuitem" onclick="event.stopPropagation();costingBreakInventoryLinkFromMenu()"><span>Break inventory link</span></button>`
    : self
      ? '<button type="button" role="menuitem" onclick="event.stopPropagation();costingOpenInventoryLinkFromMenu()"><span>Link to inventory</span></button>'
      : '';
  menu.innerHTML = `
    <button type="button" role="menuitem" onclick="event.stopPropagation();costingSplitLineFromMenu()"><span>Split item</span></button>
    <button type="button" role="menuitem" onclick="event.stopPropagation();costingDuplicateLineFromMenu()"><span>Duplicate item</span></button>
    ${priceAction}${inventoryActions}
    <button type="button" class="danger" role="menuitem" onclick="event.stopPropagation();costingDeleteLineFromMenu()"><span>Delete item</span></button>`;
  menu.classList.add('open');
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
  menu.querySelector('button')?.focus();
}

function costingSameNameLines(line) {
  const nameKey = costingLineNameKey(line);
  if (!nameKey) return [];
  return costingLines().filter(candidate => costingLineNameKey(candidate) === nameKey);
}

function costingSameNamePricesLinked(lines) {
  if (!Array.isArray(lines) || lines.length < 2) return true;
  const firstKey = costingLineSaleGroupKey(lines[0]);
  return lines.every(line => costingLineSaleGroupKey(line) === firstKey);
}

function costingCloneLine(line) {
  return {
    ...JSON.parse(JSON.stringify(line || {})),
    id: `costline_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    groupLeader: false
  };
}

async function costingSplitLineFromMenu() {
  const lineId = costingState.contextLineId;
  const index = costingLines().findIndex(row => String(row.id) === String(lineId));
  const line = costingLines()[index];
  costingCloseLineContextMenu();
  if (!line) return;
  const currentQuantity = Math.max(0, costingNumber(line.quantity));
  if (currentQuantity <= 0) {
    showNotification('warning', 'This item has no quantity to split');
    return;
  }
  const value = await showAppPrompt({
    title: 'Split item',
    message: `Move part of the ${currentQuantity} quantity into a new costing line.`,
    inputLabel: 'Quantity to move',
    inputType: 'number',
    defaultValue: currentQuantity > 1 ? '1' : String(currentQuantity / 2),
    confirmText: 'Split',
    required: true
  });
  if (value === null) return;
  const splitQuantity = costingNumber(value, -1);
  if (splitQuantity <= 0 || splitQuantity >= currentQuantity) {
    showNotification('warning', `Enter a quantity greater than 0 and less than ${currentQuantity}`);
    return;
  }
  const unitPrice = costingLineUnitSale(line);
  const clone = costingCloneLine(line);
  line.quantity = Math.round((currentQuantity - splitQuantity) * 10000) / 10000;
  clone.quantity = Math.round(splitQuantity * 10000) / 10000;
  [line, clone].forEach(row => {
    const divisor = Math.max(0, costingNumber(row.quantity))
      * Math.max(0, costingNumber(row.multiplier));
    row.salePrice = Math.round(unitPrice * (divisor || 1) * 100) / 100;
    costingLineRecalculate(row, 'sale');
  });
  costingLines().splice(index + 1, 0, clone);
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
}

function costingDuplicateLineFromMenu() {
  const lineId = costingState.contextLineId;
  const index = costingLines().findIndex(row => String(row.id) === String(lineId));
  const line = costingLines()[index];
  costingCloseLineContextMenu();
  if (!line) return;
  const clone = costingCloneLine(line);
  if (costingUnboundPriceNames().includes(costingLineNameKey(clone))) {
    clone.pricingBindingId = costingNewPricingBindingId();
  }
  costingLines().splice(index + 1, 0, clone);
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
}

async function costingDeleteLineFromMenu() {
  const lineId = costingState.contextLineId;
  const index = costingLines().findIndex(row => String(row.id) === String(lineId));
  const line = costingLines()[index];
  costingCloseLineContextMenu();
  if (!line) return;
  const confirmed = await showAppConfirm({
    title: 'Delete costing item?',
    message: `Remove ${line.description || 'this item'} from the costing?`,
    confirmText: 'Delete Item',
    variant: 'danger'
  });
  if (!confirmed) return;
  costingRemoveLine(index);
}

function costingUnbindSameNamePricesFromMenu() {
  const lineId = costingState.contextLineId;
  const source = costingLines().find(row => String(row.id) === String(lineId));
  costingCloseLineContextMenu();
  const matches = costingSameNameLines(source);
  if (matches.length < 2) return;
  const nameKey = costingLineNameKey(source);
  if (!costingUnboundPriceNames().includes(nameKey)) {
    costingUnboundPriceNames().push(nameKey);
  }
  matches.forEach(line => { line.pricingBindingId = costingNewPricingBindingId(); });
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
  showNotification('success', 'Unit prices can now be edited independently');
}

function costingLinkSameNamePricesFromMenu() {
  const lineId = costingState.contextLineId;
  const source = costingLines().find(row => String(row.id) === String(lineId));
  costingCloseLineContextMenu();
  const matches = costingSameNameLines(source);
  if (matches.length < 2) return;
  const nameKey = costingLineNameKey(source);
  costingState.current.unboundPriceNames = costingUnboundPriceNames().filter(
    value => value !== nameKey
  );
  const unitPrice = costingLineUnitSale(source);
  matches.forEach(line => {
    line.pricingBindingId = '';
    const divisor = Math.max(0, costingNumber(line.quantity))
      * Math.max(0, costingNumber(line.multiplier));
    line.salePrice = Math.round(unitPrice * (divisor || 1) * 100) / 100;
    costingLineRecalculate(line, 'sale');
  });
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
  showNotification('success', 'Same-name unit prices linked');
}

function costingBreakInventoryLink(line) {
  if (!line) return;
  line.catalogKey = '';
  line.sourceAssetIds = [];
  line.brand = '';
  line.model = '';
  line.inventoryNameMode = 'costing';
  line.isCustom = true;
  line.inventoryLinked = false;
}

async function costingBreakInventoryLinkFromMenu() {
  const lineId = costingState.contextLineId;
  const line = costingLines().find(row => String(row.id) === String(lineId));
  costingCloseLineContextMenu();
  if (!line || !costingLineIsInventoryLinked(line)) return;
  const confirmed = await showAppConfirm({
    title: 'Break inventory link?',
    message: `${line.description || 'This costing item'} will keep its current costing name and values, but it will no longer refer to the inventory asset.`,
    confirmText: 'Break Link',
    variant: 'danger'
  });
  if (!confirmed) return;
  costingBreakInventoryLink(line);
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
  showNotification('success', 'Inventory link removed');
}

function costingInventoryLinkDialogMarkup(line) {
  return `<div class="modal-content costing-inventory-link-dialog">
    <div class="modal-header">
      <div><h3 class="modal-title">Link to inventory</h3><p>Attach ${costingEscape(line.description || 'this costing item')} to an inventory model.</p></div>
      <button type="button" class="close-btn" aria-label="Close" onclick="closeModal('costingInventoryLinkModal')">&times;</button>
    </div>
    <div class="costing-inventory-link-body">
      <label class="costing-inventory-link-search"><span>Search inventory</span><input id="costingInventoryLinkSearch" type="search" autocomplete="off" placeholder="Search brand, model, description or tag" oninput="costingSearchInventoryLinks(this.value)"></label>
      <div id="costingInventoryLinkResults" class="costing-inventory-link-results"><p>Start typing to find an inventory item.</p></div>
      <div id="costingInventoryLinkChoice" class="costing-inventory-link-choice" hidden></div>
    </div>
  </div>`;
}

function costingOpenInventoryLinkFromMenu() {
  const lineId = costingState.contextLineId;
  const line = costingLines().find(row => String(row.id) === String(lineId));
  costingCloseLineContextMenu();
  if (!line) return;
  costingState.inventoryLinkLineId = lineId;
  costingState.inventoryLinkCatalog = [];
  costingState.inventoryLinkSelection = null;
  let modal = document.getElementById('costingInventoryLinkModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'costingInventoryLinkModal';
    modal.className = 'modal costing-inventory-link-modal';
    modal.addEventListener('click', event => {
      if (event.target === modal) closeModal(modal.id);
    });
    document.body.appendChild(modal);
  }
  modal.innerHTML = costingInventoryLinkDialogMarkup(line);
  openModal(modal.id);
}

function costingSearchInventoryLinks(value) {
  const query = String(value || '').trim();
  const results = document.getElementById('costingInventoryLinkResults');
  clearTimeout(costingState.inventoryLinkTimer);
  costingState.inventoryLinkSelection = null;
  document.getElementById('costingInventoryLinkChoice')?.setAttribute('hidden', '');
  if (query.length < 2) {
    costingState.inventoryLinkCatalog = [];
    if (results) results.innerHTML = '<p>Enter at least two characters.</p>';
    return;
  }
  if (results) results.innerHTML = '<p>Searching inventory...</p>';
  costingState.inventoryLinkTimer = setTimeout(async () => {
    try {
      const response = await apiCall(`/api/finance/catalog?query=${encodeURIComponent(query)}`);
      costingState.inventoryLinkCatalog = (response.data || []).filter(
        row => !row.isCustom && !row.isContainer && Array.isArray(row.sourceAssetIds) && row.sourceAssetIds.length
      );
    } catch {
      costingState.inventoryLinkCatalog = [];
    }
    const currentResults = document.getElementById('costingInventoryLinkResults');
    if (!currentResults) return;
    currentResults.innerHTML = costingState.inventoryLinkCatalog.map((row, index) => `<button type="button" onclick="costingChooseInventoryLink(${index})"><span><strong>${costingEscape(row.description || 'Inventory item')}</strong><small>${costingEscape(row.department || 'General')} &middot; ${costingNumber(row.availableQuantity)} in inventory</small></span><b>Select</b></button>`).join('') || '<p>No matching inventory items.</p>';
  }, 180);
}

function costingChooseInventoryLink(index) {
  const selected = costingState.inventoryLinkCatalog[index];
  const choice = document.getElementById('costingInventoryLinkChoice');
  if (!selected || !choice) return;
  costingState.inventoryLinkSelection = selected;
  document.querySelectorAll('#costingInventoryLinkResults button').forEach(
    (button, buttonIndex) => button.classList.toggle('selected', buttonIndex === index)
  );
  const line = costingLines().find(
    row => String(row.id) === String(costingState.inventoryLinkLineId)
  );
  choice.removeAttribute('hidden');
  choice.innerHTML = `<span>Name shown in this costing</span><div>
    <button type="button" onclick="costingApplyInventoryLink('inventory')"><strong>Use inventory name</strong><small>${costingEscape(selected.description || 'Inventory item')}</small></button>
    <button type="button" onclick="costingApplyInventoryLink('costing')"><strong>Keep current name</strong><small>${costingEscape(line?.description || 'Current costing item')}</small></button>
  </div>`;
}

function costingApplyInventoryLink(nameMode) {
  const line = costingLines().find(
    row => String(row.id) === String(costingState.inventoryLinkLineId)
  );
  const selected = costingState.inventoryLinkSelection;
  if (!line || !selected || !['inventory', 'costing'].includes(nameMode)) return;
  const currentName = {
    brand: line.brand || '',
    model: line.model || '',
    description: line.description || ''
  };
  line.catalogKey = selected.catalogKey || '';
  line.sourceAssetIds = [...new Set(selected.sourceAssetIds || [])];
  line.departmentCode = selected.departmentCode || '';
  line.brand = selected.brand || '';
  line.model = selected.model || '';
  line.description = selected.description || 'Inventory item';
  line.inventoryNameMode = nameMode;
  line.isCustom = false;
  line.inventoryLinked = true;
  if (nameMode === 'costing') Object.assign(line, currentName);
  costingState.inventoryLinkLineId = '';
  closeModal('costingInventoryLinkModal');
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
  showNotification('success', 'Costing item linked to inventory');
}

function costingDiscrepancyMarkup() {
  const rows = costingState.current?.vendorDiscrepancies || [];
  if (!rows.length) return '';
  return `<div class="costing-warning" role="alert"><strong>Vendor totals need review</strong>
    <p>These Manpower &amp; Transport amounts changed independently. Your costing values were left untouched.</p>
    <ul>${rows.map(row => `<li><b>${costingEscape(row.vendorName)}</b>: costing ${costingEscape(costingMoney(row.expectedAmount))}, vendor ${row.actualAmount == null ? 'missing' : costingEscape(costingMoney(row.actualAmount))}</li>`).join('')}</ul></div>`;
}

function costingKpiIcon(kind) {
  const icons = {
    cost: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6" rx="6" ry="3"></ellipse><path d="M6 6v4c0 1.7 2.7 3 6 3s6-1.3 6-3V6M6 10v4c0 1.7 2.7 3 6 3s6-1.3 6-3v-4M6 14v4c0 1.7 2.7 3 6 3s6-1.3 6-3v-4"></path></svg>',
    charge: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h8l4 4v14H7z"></path><path d="M15 3v5h5M13 11c-2.5 0-3.5 1-3.5 2.2 0 2.8 6.5 1.2 6.5 4 0 1.2-1 2.1-3.5 2.1M12.5 9.5v11"></path></svg>',
    profit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18 9 13l4 3 7-9"></path><path d="M15 7h5v5"></path></svg>',
    margin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9h-9z"></path><path d="M14 3.2V10h6.8A9 9 0 0 0 14 3.2z"></path></svg>'
  };
  return icons[kind] || icons.cost;
}

function costingMarginPercent(totals) {
  return totals.cost ? totals.profit / totals.cost * 100 : (totals.sale ? 100 : 0);
}

function costingSubprojectTabsMarkup(readOnly) {
  return showbaseLineWorkspace.subprojectTabsMarkup({
    rows: costingSubprojects(),
    activeId: costingActiveSubprojectId(),
    readOnly,
    handlerPrefix: 'costing',
    className: 'costing-subproject-tabs',
    ariaLabel: 'Costing sub-projects'
  });
}

function costingRenderEditor() {
  const root = costingRoot();
  const current = costingState.current;
  if (!root || !current) return;
  const readOnly = current.status === 'converted';
  const hasLinkedQuotation = Boolean(current.convertedQuotationId || current.sourceQuotationId);
  const totals = costingTotals();
  const categories = costingCategories();
  const activeRoom = costingSubprojects().find(
    row => row.id === costingActiveSubprojectId()
  ) || costingSubprojects()[0];
  const quotationNumber = current.convertedQuotationNumber || current.sourceQuotationNumber || '';
  const ownerName = current.salesperson || current.salespersonUsername || current.createdBy || 'Unassigned';
  const marginPercent = costingMarginPercent(totals);
  root.innerHTML = `
    <header class="costing-workspace-header">
      <div>
        <h2>Event Costing</h2>
        <p>Track internal costs, sell price, and category profit for each quotation.</p>
      </div>
      <div class="costing-header-nav">
        <div class="costing-breadcrumb"><button type="button" onclick="costingBackToList()">Costings</button><span>/</span><b>${costingEscape(quotationNumber || current.projectName || 'Draft')}</b></div>
        <div class="costing-header-buttons">
          <button type="button" class="costing-outline-button" onclick="${hasLinkedQuotation ? 'costingOpenQuotation()' : 'costingBackToList()'}">&#8249;&nbsp; ${hasLinkedQuotation ? 'Go to Quotation' : 'Back to Costings'}</button>
          <details class="costing-more-menu"><summary>&#8942;&nbsp; More</summary><div><button type="button" class="danger" onclick="costingDelete()">Delete costing</button></div></details>
        </div>
      </div>
    </header>
    ${costingDiscrepancyMarkup()}
    ${costingVendorOptions()}
    <section class="costing-project-card" aria-label="Costing details">
      <label class="costing-project-field costing-project-name-field"><span>Project Name *</span><input id="costingProjectName" value="${costingAttr(current.projectName)}" maxlength="500" ${readOnly ? 'disabled' : ''} oninput="costingProjectChanged(this.value)"></label>
      <label class="costing-project-field"><span>Event Location</span><input value="${costingAttr(current.eventLocation || '')}" maxlength="600" placeholder="Add location" ${readOnly ? 'disabled' : ''} oninput="costingLocationChanged(this.value)"></label>
      <div class="costing-project-field"><span>Salesperson</span><strong>${costingEscape(ownerName)}</strong></div>
      <div class="costing-project-field"><span>Quote No.</span><strong class="costing-quote-chip">${costingEscape(quotationNumber || 'Not created')}</strong></div>
    </section>

    <section class="costing-kpis" aria-label="Costing totals">
      <article class="costing-kpi-card is-cost"><div><span>Total Item Costing</span><strong id="costingTotalCost">${costingEscape(costingMoney(totals.cost))}</strong></div><i>${costingKpiIcon('cost')}</i></article>
      <article class="costing-kpi-card is-charge"><div><span>Total Chargeable</span><strong id="costingTotalSale">${costingEscape(costingMoney(totals.sale))}</strong></div><i>${costingKpiIcon('charge')}</i></article>
      <article class="costing-kpi-card is-profit"><div><span>Gross Profit</span><strong id="costingTotalProfit">${costingEscape(costingMoney(totals.profit))}</strong></div><i>${costingKpiIcon('profit')}</i></article>
      <article class="costing-kpi-card is-margin"><div><span>Margin</span><strong id="costingTotalMargin">${marginPercent.toFixed(1)}%</strong></div><i>${costingKpiIcon('margin')}</i></article>
    </section>

    <div class="costing-workspace-grid">
      <main class="costing-line-workspace">
        ${costingSubprojectTabsMarkup(readOnly)}
        <div class="costing-category-list showbase-category-stack">
          ${categories.map(category => costingCategoryMarkup(category, readOnly)).join('') || '<section class="costing-empty-card">No items yet. Search inventory or enter a custom item below.</section>'}
          ${readOnly ? '' : costingAddItemMarkup()}
        </div>
      </main>
      <aside class="costing-side-panel">
        <section class="costing-side-card costing-breakdown-card">
          <header><h3>Summary</h3><div class="costing-summary-grouping" role="radiogroup" aria-label="Summarise costing by">
            <button type="button" class="${costingState.summaryGrouping === 'category' ? 'selected' : ''}" role="radio" aria-checked="${costingState.summaryGrouping === 'category'}" data-costing-summary-group="category" onclick="costingSetSummaryGrouping('category')">Category</button>
            <button type="button" class="${costingState.summaryGrouping === 'vendor' ? 'selected' : ''}" role="radio" aria-checked="${costingState.summaryGrouping === 'vendor'}" data-costing-summary-group="vendor" onclick="costingSetSummaryGrouping('vendor')">Vendor</button>
          </div></header>
          <div class="costing-side-card-body">
            <h4 id="costingBreakdownHeading">${costingEscape(costingSummaryHeading())}</h4>
            <div class="costing-breakdown-list" id="costingBreakdownList">${costingSummaryRowsMarkup()}</div>
            <div class="costing-breakdown-total"><span>Total Item Costing</span><strong data-summary-total-cost>${costingEscape(costingMoney(totals.cost))}</strong></div>
          </div>
        </section>
        <section class="costing-side-card costing-profit-summary"><div><span>Gross Profit</span><strong data-summary-total-profit>${costingEscape(costingMoney(totals.profit))}</strong></div><div><span>Profit Margin</span><strong data-summary-total-margin>${marginPercent.toFixed(1)}%</strong></div></section>
        ${costingVendorManagementMarkup(readOnly)}
        <section class="costing-side-card costing-side-actions">
          <button type="button" class="costing-action-primary" onclick="${hasLinkedQuotation ? 'costingOpenQuotation()' : 'costingMakeQuotation()'}">${hasLinkedQuotation ? 'Go to Quotation' : 'Convert to Quotation'} <span>&#8250;</span></button>
          <button type="button" class="costing-action-outline" onclick="costingExportPdf(this)">Export PDF</button>
          <button type="button" class="costing-action-danger" onclick="costingDelete()">Delete costing</button>
          <small id="costingSaveState">${readOnly ? 'Read-only costing' : 'All changes saved'}</small>
        </section>
      </aside>
    </div>`;
  costingRefreshCalculations();
}

function costingCategoryMarkup(category, readOnly) {
  const encoded = encodeURIComponent(category);
  const subprojectId = costingActiveSubprojectId();
  const collapseKey = `${subprojectId}::${category}`;
  const collapsed = !!costingState.collapsedCategories[collapseKey];
  const lines = costingLines().map((line, index) => ({ line, index })).filter(
    row => row.line.category === category
      && String(row.line.subprojectId || 'main') === String(subprojectId)
  );
  const defaults = costingCategoryDefaults(category, subprojectId);
  const totals = costingCategoryTotals(category);
  const categoryHeader = showbaseLineWorkspace.categoryHeaderRowMarkup({
    colspan: 12,
    className: 'costing-category-header',
    content: `<div class="costing-category-title">${readOnly ? '' : `<span class="finance-department-drag-handle costing-category-drag-handle" draggable="true" title="Drag category" ondragstart="costingDragCategoryStart(event,'${costingAttr(encoded)}')" ondragend="costingDragEnd()">&#9776;</span>`}${showbaseLineWorkspace.categoryToggleMarkup({
      label: `${category} category`,
      collapsed,
      action: `costingToggleCategory(${JSON.stringify(encoded)})`,
      className: 'finance-collapse-button costing-category-toggle'
    })}<input aria-label="Category name" value="${costingAttr(category)}" ${readOnly ? 'disabled' : ''} onchange="costingRenameCategory('${costingAttr(encoded)}',this.value)"></div>
      <div class="costing-category-metrics"><span>Category Cost <strong data-category-cost>${costingEscape(costingMoney(totals.cost))}</strong></span><b></b><span>Revenue <strong data-category-revenue>${costingEscape(costingMoney(totals.charged))}</strong></span><b></b><span>Profit <strong class="is-profit" data-category-profit-display>${costingEscape(costingMoney(totals.profit))}</strong></span></div>`
  });
  return `<section class="${showbaseLineWorkspace.categorySectionClass({ className: 'costing-category-card', collapsed })}" data-category-total="${costingAttr(encoded)}" ondragover="costingDragCategoryOver(event,'${costingAttr(encoded)}')" ondragleave="costingDragCategoryLeave(event)" ondrop="costingDropCategory(event,'${costingAttr(encoded)}')">
    <div class="costing-table-wrap"><table class="costing-table showbase-category-table">
      <colgroup><col class="col-item"><col class="col-qty"><col class="col-mult"><col class="col-vendor"><col class="col-remarks"><col class="col-money"><col class="col-money"><col class="col-margin"><col class="col-money"><col class="col-unit-price"><col class="col-sale"><col class="col-menu"></colgroup>
      <thead>
        ${categoryHeader}
        <tr class="costing-column-header showbase-category-column-header"><th>Item</th><th>Qty</th><th>${readOnly ? costingMultiplierHeaderLabel(category) : `<details class="costing-header-menu"><summary class="showbase-line-header-action">${costingMultiplierHeaderLabel(category)}</summary><div><span class="costing-menu-caption">Column label</span><div class="costing-label-choice"><button type="button" onclick="costingSetAllMultiplierLabels('Mult','${costingAttr(encoded)}')">Mult</button><button type="button" onclick="costingSetAllMultiplierLabels('Day','${costingAttr(encoded)}')">Day(s)</button></div><label>Value for all lines<input type="number" min="0" step=".5" value="${costingAttr(defaults.multiplier)}"></label><button type="button" class="apply" onclick="costingApplyMultiplierAll(this.closest('details').querySelector('input').value,'${costingAttr(encoded)}')">Apply value to this category</button></div></details>`}</th><th>${readOnly ? 'Vendor' : `<details class="costing-header-menu costing-vendor-menu"><summary class="showbase-line-header-action">Vendor</summary><div><label>Vendor for this category<input list="costingVendorOptions" placeholder="Select or enter vendor"></label><button type="button" class="apply" onclick="costingApplyCategoryVendor('${costingAttr(encoded)}',this.closest('details').querySelector('input').value)">Apply to this category</button></div></details>`}</th><th>Remarks</th><th>Unit Cost</th><th>Cost Total</th><th>${readOnly ? 'Margin' : `<details class="costing-header-menu costing-margin-menu"><summary class="showbase-line-header-action">Margin</summary><div><label>Margin percentage<input type="number" min="-100" max="9999" step=".01" value="${costingAttr(defaults.targetMarginPercent)}"></label><button type="button" class="apply" onclick="costingApplyCategoryMargin('${costingAttr(encoded)}',this.closest('details').querySelector('input').value)">Apply to this category</button></div></details>`}</th><th>Calc. Price</th><th>Unit Price</th><th>Sale Price</th><th></th></tr>
      </thead>
      <tbody>${costingGroupedLinesMarkup(lines, readOnly)}</tbody>
      <tfoot><tr class="costing-category-subtotal" ondragover="costingDragLineEndOver(event)" ondragleave="costingDragLineLeave(event)" ondrop="costingDropLineAtCategoryEnd(event,'${costingAttr(encoded)}')"><td colspan="12"><div>
        <span class="costing-subtotal-label"><strong>Category subtotal</strong><small data-category-adjustment>${totals.adjustment ? `Adjustment ${costingMoney(totals.adjustment)}` : 'No category adjustment'}</small></span>
        <label>Cost <strong data-category-cost>${costingEscape(costingMoney(totals.cost))}</strong></label>
        <label>Profit <span class="costing-inline-money">$<input data-category-profit type="number" step=".01" value="${totals.profit.toFixed(2)}" ${readOnly ? 'disabled' : ''} oninput="costingCategoryProfit('${costingAttr(encoded)}',this.value)" onblur="costingFormatMoneyInput(this)"></span></label>
        <label>Client Charge <span class="costing-inline-money">$<input data-category-charge type="number" min="0" step=".01" value="${totals.charged.toFixed(2)}" ${readOnly ? 'disabled' : ''} oninput="costingCategoryCharge('${costingAttr(encoded)}',this.value)" onblur="costingFormatMoneyInput(this)"></span></label>
      </div></td></tr></tfoot>
    </table></div>
  </section>`;
}

function costingGroupedLinesMarkup(lines, readOnly) {
  const rendered = new Set();
  return lines.map(({ line, index }) => {
    const groupId = String(line.groupId || '');
    let header = '';
    if (groupId && !rendered.has(groupId)) {
      rendered.add(groupId);
      const firstGroupIndex = lines.find(
        row => String(row.line.groupId || '') === groupId
      )?.index ?? index;
      header = `<tr class="costing-line-group-header" data-costing-line="${firstGroupIndex}" data-group-boundary="before"
        oncontextmenu="financeEditLineGroup(event,'costing','${costingAttr(groupId)}')"
        ondragover="costingDragLineOver(event,${firstGroupIndex})"
        ondragleave="costingDragLineLeave(event)"
        ondrop="costingDropLine(event,${firstGroupIndex},'${costingAttr(encodeURIComponent(line.category || 'General'))}')"
        ondragend="costingDragEnd()"><td colspan="12">${readOnly ? '' : `<span class="finance-drag-handle costing-group-drag-handle" draggable="true" title="Drag group to reorder" ondragstart="costingDragLineGroupStart(event,'${costingAttr(groupId)}','${costingAttr(line.subprojectId || 'main')}')" ondragend="costingDragEnd()">&#9776;</span>`}<span>${costingEscape(line.groupTitle || 'Group')}</span>${readOnly ? '' : `<small>Right-click to edit group</small><button type="button" title="Edit group" onclick="financeOpenLineGroupEditor('costing','${costingAttr(groupId)}')">&#9998;</button>`}</td></tr>`;
    }
    return header + costingLineMarkup(line, index, readOnly);
  }).join('');
}

function costingLineMarkup(line, index, readOnly) {
  costingLineRecalculate(line);
  const unitPrice = costingLineUnitSale(line);
  const unitPriceState = costingUnitPriceState(line);
  const saleState = costingSaleState(line);
  const itemControl = line.groupId
    ? `<div class="costing-group-item-display"><span class="${line.groupCustomText ? 'showbase-group-custom-text' : ''}">${costingEscape(line.groupCustomText ? line.description : financeGroupedLineDisplay(line))}</span>${line.groupCustomText ? '<small>Custom text</small>' : ''}</div>`
    : `<input class="costing-item-name" title="${line.sourceAssetIds?.length ? 'Linked to inventory' : 'Custom item'}" value="${costingAttr(line.description)}" data-original-value="${costingAttr(line.description)}" ${readOnly ? 'disabled' : ''} oninput="costingLineDescriptionDraft(${index},this.value)" onchange="costingLineDescriptionChanged(${index},this.value,this)">`;
  return `<tr class="costing-line" data-costing-line="${index}" data-costing-line-id="${costingAttr(line.id || '')}" oncontextmenu="costingOpenLineContextMenu(event,'${costingAttr(line.id || '')}')" ondragover="costingDragLineOver(event,${index})" ondragleave="costingDragLineLeave(event)" ondrop="costingDropLine(event,${index},'${costingAttr(encodeURIComponent(line.category || 'General'))}')" ondragend="costingDragEnd()">
    <td class="costing-item-cell"><div class="costing-item-entry">${readOnly ? '' : `<span class="finance-drag-handle costing-line-drag-handle" draggable="true" title="Drag to reorder" ondragstart="costingDragLineStart(event,${index})" ondragend="costingDragEnd()">&#9776;</span>`}${itemControl}</div></td>
    <td><input class="costing-number costing-stepper-input" aria-label="Quantity" type="number" min="0" step="1" value="${costingAttr(line.quantity)}" ${readOnly ? 'disabled' : ''} oninput="costingLineInput(${index},'quantity',this.value)"></td>
    <td><div class="costing-multiplier"><input class="costing-stepper-input" aria-label="${line.multiplierLabel === 'Day' ? 'Days' : 'Multiplier'}" type="number" min="0" step=".5" value="${costingAttr(line.multiplier)}" ${readOnly ? 'disabled' : ''} oninput="costingLineInput(${index},'multiplier',this.value)"></div></td>
    <td><input class="costing-vendor-input ${String(line.vendorName || '').toLowerCase() === 'self' ? 'is-self' : ''} ${costingSelfLinkClass(line)} ${line.vendorName ? '' : 'is-empty'}" style="--vendor-hue:${costingVendorHue(line.vendorName)}" list="costingVendorOptions" value="${costingAttr(line.vendorName || '')}" placeholder="Unassigned" ${readOnly ? 'disabled' : ''} oninput="costingVendorColourChanged(this,${index})" onchange="costingVendorChanged(${index},this.value,this)"></td>
    <td><textarea class="costing-remarks-input" rows="1" placeholder="Add note" ${readOnly ? 'disabled' : ''} oninput="costingLineInput(${index},'remarks',this.value)">${costingEscape(line.remarks || '')}</textarea></td>
    <td><span class="costing-money-input">$<input data-line-unit-cost aria-label="Unit cost" type="number" min="0" step=".01" value="${costingAttr(costingNumber(line.itemCost).toFixed(2))}" ${readOnly ? 'disabled' : ''} oninput="costingLineInput(${index},'itemCost',this.value)" onblur="costingFormatMoneyInput(this)"></span></td>
    <td><span class="costing-money-input">$<input data-line-cost-total aria-label="Cost total" type="number" min="0" step=".01" value="${costingAttr(costingNumber(line.costTotal).toFixed(2))}" ${readOnly ? 'disabled' : ''} oninput="costingLineCostTotal(${index},this.value)" onblur="costingFormatMoneyInput(this)"></span></td>
    <td class="costing-margin-cell"><div class="costing-margin ${line.calculatedMarginAmount < 0 ? 'is-negative' : 'is-positive'}"><span class="costing-margin-percent"><input data-line-margin-percent aria-label="Calculated margin percentage" type="number" step=".01" value="${costingAttr(line.targetMarginPercent.toFixed(2))}" ${readOnly ? 'disabled' : ''} oninput="costingLineMarginPercent(${index},this.value)"><span>%</span></span><span class="costing-margin-amount"><span class="costing-currency-symbol">$</span><input data-line-margin-amount aria-label="Calculated margin amount" type="number" step=".01" value="${costingAttr(line.calculatedMarginAmount.toFixed(2))}" ${readOnly ? 'disabled' : ''} oninput="costingLineMarginAmount(${index},this.value)" onblur="costingFormatMoneyInput(this)"></span></div></td>
    <td><strong data-line-calculated>${costingEscape(costingMoney(line.calculatedSalePrice))}</strong></td>
    <td class="costing-sale-price-cell"><div class="costing-sale-cell"><span class="costing-money-input costing-sale-input ${unitPriceState}" data-line-unit-price-wrap><span class="costing-currency-symbol">$</span><input data-line-unit-price aria-label="Unit price" type="number" min="0" step=".01" value="${costingAttr(unitPrice.toFixed(2))}" ${readOnly ? 'disabled' : ''} oninput="costingLineUnitPrice(${index},this.value)" onblur="costingFormatMoneyInput(this)"></span><small class="costing-sale-difference ${unitPriceState}" data-line-unit-difference title="Difference from unit cost">${costingEscape(costingComparisonMoney(unitPrice, line.itemCost))}</small></div></td>
    <td class="costing-sale-price-cell"><div class="costing-sale-cell"><span class="costing-money-input costing-sale-input ${saleState}" data-line-sale-wrap><span class="costing-currency-symbol">$</span><input data-line-sale aria-label="Sale price" type="number" min="0" step=".01" value="${costingAttr(line.salePrice.toFixed(2))}" ${readOnly ? 'disabled' : ''} oninput="costingLineSale(${index},this.value)" onblur="costingFormatMoneyInput(this)"></span><small class="costing-sale-difference ${saleState}" data-line-sale-difference title="Difference from cost total">${costingEscape(costingComparisonMoney(line.salePrice, line.costTotal))}</small></div></td>
    <td>${readOnly ? '' : `<button type="button" class="costing-remove" aria-label="Remove item" title="Remove item" onclick="costingRemoveLine(${index})">&times;</button>`}</td>
  </tr>`;
}

function costingAddItemMarkup() {
  return showbaseLineWorkspace.addRowMarkup({
    mode: 'costing',
    className: 'costing-add-item',
    search: {
      id: 'costingAddItemInput',
      resultsId: 'costingCatalogResults',
      wrapClass: 'costing-item-search',
      placeholder: 'Search inventory or enter any item...',
      oninput: 'costingSearchCatalog(this.value)',
      onkeydown: 'costingAddItemKeydown(event)'
    },
    category: {
      id: 'costingAddCategoryInput',
      resultsId: 'costingAddCategoryResults',
      value: costingState.addCategory,
      placeholder: 'Category',
      oninput: 'costingState.addCategory=this.value;costingShowAddCategorySuggestions(this.value)',
      onfocus: 'costingShowAddCategorySuggestions(this.value)',
      onblur: 'costingCloseAddCategorySuggestions()',
      onkeydown: 'costingAddCategoryKeydown(event)'
    },
    addAction: 'costingAddCustomItem()'
  });
}

function costingAvailableCategories() {
  const rows = ['General', ...costingLines().map(line => String(line.category || '').trim())];
  const seen = new Set();
  return rows.filter(value => {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function costingShowAddCategorySuggestions(query = '') {
  const results = document.getElementById('costingAddCategoryResults');
  if (!results) return;
  const needle = String(query || '').trim().toLowerCase();
  const categories = costingAvailableCategories().filter(
    value => !needle || value.toLowerCase().includes(needle)
  );
  results.innerHTML = categories.map(value => `<button type="button" onmousedown="event.preventDefault();costingChooseAddCategory('${costingAttr(encodeURIComponent(value))}')">${costingEscape(value)}</button>`).join('')
    || '<div class="finance-suggestion-empty">Enter a new category name</div>';
  results.classList.add('open');
}

function costingChooseAddCategory(encodedValue) {
  costingState.addCategory = decodeURIComponent(encodedValue);
  const input = document.getElementById('costingAddCategoryInput');
  if (input) input.value = costingState.addCategory;
  costingCloseAddCategorySuggestions();
  document.getElementById('costingAddItemInput')?.focus();
}

function costingCloseAddCategorySuggestions() {
  document.getElementById('costingAddCategoryResults')?.classList.remove('open');
}

function costingAddCategoryKeydown(event) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  costingCloseAddCategorySuggestions();
  event.currentTarget?.blur();
}

function costingToggleCategory(encodedCategory) {
  const category = decodeURIComponent(encodedCategory);
  const key = `${costingActiveSubprojectId()}::${category}`;
  costingState.collapsedCategories[key] = !costingState.collapsedCategories[key];
  const section = document.querySelector(`[data-category-total="${CSS.escape(encodedCategory)}"]`);
  showbaseLineWorkspace.setCategoryCollapsed(section, costingState.collapsedCategories[key]);
}

function costingBeginLineDrag(event, indexes, wholeGroup = false) {
  const lines = costingLines();
  const activeSubproject = costingActiveSubprojectId();
  const selected = showbaseLineWorkspace.beginDrag(
    costingState,
    event,
    lines,
    indexes,
    {
      wholeGroup,
      subprojectId: activeSubproject,
      mimeType: 'application/x-showbase-costing-lines',
      numberValue: costingNumber
    }
  );
  if (!selected.length) return;
  costingState.dragCategory = '';
}

function costingDragLineStart(event, index) {
  costingBeginLineDrag(event, [index]);
}

function costingDragLineGroupStart(event, groupId, subprojectId) {
  const indexes = costingLines().map((line, index) => ({ line, index }))
    .filter(row => (
      String(row.line.groupId || '') === String(groupId || '')
      && String(row.line.subprojectId || 'main') === String(subprojectId || 'main')
    ))
    .map(row => row.index);
  costingBeginLineDrag(event, indexes, true);
}

function costingDraggedLineIndexes(event) {
  return showbaseLineWorkspace.draggedIndexes(costingState, event, {
    mimeType: 'application/x-showbase-costing-lines',
    numberValue: costingNumber
  });
}

function costingClearLineDropTargets() {
  document.querySelectorAll(
    '.costing-line.drag-over,.costing-line.drag-over-before,.costing-line.drag-over-after,'
      + '.costing-line-group-header.drag-over-before,.costing-line-group-header.drag-over-after,'
      + '.costing-category-subtotal.drag-over'
  ).forEach(row => {
    row.classList.remove('drag-over', 'drag-over-before', 'drag-over-after');
    delete row.dataset.dropPosition;
  });
}

function costingDragLineOver(event, index) {
  if (!costingState.dragLineIndexes.length || costingState.dragLineIndexes.includes(index)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  costingClearLineDropTargets();
  const position = showbaseLineWorkspace.dropPosition(event);
  event.currentTarget.classList.add(`drag-over-${position}`);
  event.currentTarget.dataset.dropPosition = position;
}

function costingDragLineEndOver(event) {
  if (!costingState.dragLineIndexes.length) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  costingClearLineDropTargets();
  event.currentTarget.classList.add('drag-over');
}

function costingDragLineLeave(event) {
  if (event.currentTarget?.contains(event.relatedTarget)) return;
  event.currentTarget?.classList.remove('drag-over', 'drag-over-before', 'drag-over-after');
  if (event.currentTarget?.dataset) delete event.currentTarget.dataset.dropPosition;
}

function costingClearLineGroupFields(line) {
  if (!line) return;
  [
    'groupId', 'groupTitle', 'groupDisplayFields', 'groupCustomText', 'groupLeader',
    'groupHeaderQuantity'
  ].forEach(key => delete line[key]);
}

function costingDetachLineFromGroup(line) {
  if (!line?.groupId) return;
  costingClearLineGroupFields(line);
}

function costingAttachLineToGroup(line, targetGroupId, targetSubprojectId) {
  if (!line || !targetGroupId) return false;
  const roomId = String(targetSubprojectId || 'main');
  const leader = costingLines().find(candidate => (
    String(candidate.groupId || '') === String(targetGroupId)
    && String(candidate.subprojectId || 'main') === roomId
  ));
  if (!leader) return false;
  if (line.groupId) costingDetachLineFromGroup(line);
  Object.assign(line, {
    groupId: String(targetGroupId),
    groupTitle: leader.groupTitle || 'Group',
    groupDisplayFields: [...(leader.groupDisplayFields || ['brand', 'model', 'description'])],
    groupCustomText: false,
    subprojectId: roomId,
    category: leader.category || 'General'
  });
  return true;
}

function costingMoveLines(sourceIndexes, targetIndex, targetCategory, options = {}) {
  const lines = costingLines();
  const selectedIndexes = [...new Set((sourceIndexes || []).map(value => costingNumber(value, -1)))]
    .filter(index => index >= 0 && !!lines[index]);
  const movedItems = selectedIndexes.map(index => lines[index]);
  const target = options.atEnd ? null : lines[targetIndex];
  if (!movedItems.length || (!options.atEnd && (!target || movedItems.includes(target)))) {
    costingDragEnd();
    return;
  }
  const activeSubproject = costingActiveSubprojectId();
  if (movedItems.some(
    line => String(line.subprojectId || 'main') !== String(activeSubproject)
  )) {
    costingDragEnd();
    return;
  }

  const position = options.position || 'before';
  const outsideGroupBoundary = !!options.outsideGroupBoundary;
  const wholeGroup = !!costingState.dragWholeLineGroup
    || showbaseLineWorkspace.draggedWholeGroup(lines, selectedIndexes);
  if (!wholeGroup) {
    movedItems.forEach(moved => {
      const sameGroup = !!target
        && String(moved.groupId || '') === String(target.groupId || '')
        && String(moved.subprojectId || 'main') === String(target.subprojectId || 'main');
      if (target?.groupId && !outsideGroupBoundary && !sameGroup) {
        costingAttachLineToGroup(moved, target.groupId, target.subprojectId);
      } else if (moved.groupId && (options.atEnd || !sameGroup || outsideGroupBoundary)) {
        costingDetachLineFromGroup(moved);
      }
    });
  }

  [...selectedIndexes].sort((a, b) => b - a).forEach(index => lines.splice(index, 1));
  movedItems.forEach(moved => {
    moved.category = targetCategory || moved.category || 'General';
    moved.subprojectId = activeSubproject;
  });

  let insertIndex;
  if (options.atEnd) {
    insertIndex = lines.reduce((last, line, index) => (
      String(line.subprojectId || 'main') === String(activeSubproject)
        && String(line.category || 'General') === String(targetCategory || 'General')
        ? index + 1
        : last
    ), -1);
    if (insertIndex < 0) insertIndex = lines.length;
  } else {
    let anchor = target;
    if (target.groupId && (wholeGroup || outsideGroupBoundary)) {
      const targetMembers = lines.filter(line => (
        String(line.groupId || '') === String(target.groupId || '')
        && String(line.subprojectId || 'main') === String(target.subprojectId || 'main')
      ));
      if (targetMembers.length) {
        anchor = position === 'after' && wholeGroup
          ? targetMembers.at(-1)
          : targetMembers[0];
      }
    }
    insertIndex = Math.max(0, lines.indexOf(anchor));
    if (position === 'after') insertIndex += 1;
  }
  lines.splice(Math.min(lines.length, insertIndex), 0, ...movedItems);
  costingEqualiseSaleGroups(costingLines());
  costingState.changeVersion += 1;
  costingQueueSave();
  costingDragEnd();
  costingRenderEditor();
}

function costingDropLine(event, targetIndex, encodedCategory) {
  if (!costingState.dragLineIndexes.length) return;
  event.preventDefault();
  event.stopPropagation();
  const position = showbaseLineWorkspace.dropPosition(event);
  costingMoveLines(
    costingDraggedLineIndexes(event),
    targetIndex,
    decodeURIComponent(encodedCategory),
    {
      position,
      outsideGroupBoundary: event.currentTarget.dataset.groupBoundary === 'before'
        && position === 'before'
    }
  );
}

function costingDropLineAtCategoryEnd(event, encodedCategory) {
  if (!costingState.dragLineIndexes.length) return;
  event.preventDefault();
  event.stopPropagation();
  costingMoveLines(
    costingDraggedLineIndexes(event),
    costingLines().length,
    decodeURIComponent(encodedCategory),
    { atEnd: true, position: 'after' }
  );
}

function costingDragCategoryStart(event, encodedCategory) {
  costingState.dragCategory = decodeURIComponent(encodedCategory);
  costingState.dragLineIndex = null;
  costingState.dragLineIndexes = [];
  costingState.dragWholeLineGroup = false;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', costingState.dragCategory);
  event.currentTarget?.closest('.costing-category-card')?.classList.add('dragging');
}

function costingDragCategoryOver(event, encodedCategory) {
  if (!costingState.dragCategory) return;
  const target = decodeURIComponent(encodedCategory);
  if (target === costingState.dragCategory) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.costing-category-card.drag-over').forEach(card => card.classList.remove('drag-over'));
  event.currentTarget?.classList.add('drag-over');
}

function costingDragCategoryLeave(event) {
  if (event.currentTarget?.contains(event.relatedTarget)) return;
  event.currentTarget?.classList.remove('drag-over');
}

function costingDropCategory(event, encodedCategory) {
  if (!costingState.dragCategory) return;
  event.preventDefault();
  const target = decodeURIComponent(encodedCategory);
  const source = costingState.dragCategory;
  const order = costingCategories();
  const sourcePosition = order.indexOf(source);
  const targetPosition = order.indexOf(target);
  if (sourcePosition < 0 || targetPosition < 0 || sourcePosition === targetPosition) {
    costingDragEnd();
    return;
  }
  order.splice(sourcePosition, 1);
  order.splice(sourcePosition < targetPosition ? targetPosition - 1 : targetPosition, 0, source);
  const activeId = costingActiveSubprojectId();
  const activeLines = order.flatMap(category => costingCategoryLines(category, activeId));
  let activeIndex = 0;
  costingState.current.lineItems = costingLines().map(line => (
    String(line.subprojectId || 'main') === String(activeId)
      ? activeLines[activeIndex++]
      : line
  ));
  costingState.changeVersion += 1;
  costingQueueSave();
  costingDragEnd();
  costingRenderEditor();
}

function costingDragEnd() {
  costingState.dragLineIndex = null;
  costingState.dragLineIndexes = [];
  costingState.dragWholeLineGroup = false;
  costingState.dragCategory = '';
  document.querySelectorAll('.costing-line.dragging,.costing-line-group-header.dragging,.costing-category-card.dragging,.costing-category-card.drag-over')
    .forEach(node => node.classList.remove('dragging', 'drag-over'));
  costingClearLineDropTargets();
}

function costingProjectChanged(value) {
  if (!costingState.current) return;
  costingState.current.projectName = value;
  costingQueueSave();
}

function costingLocationChanged(value) {
  if (!costingState.current) return;
  costingState.current.eventLocation = value;
  costingQueueSave();
}

function costingSelectSubproject(subprojectId) {
  if (!costingSubprojects().some(row => row.id === subprojectId)) return;
  costingState.activeSubprojectId = subprojectId;
  costingState.addCategory = '';
  costingRenderEditor();
}

const costingSubprojectWorkspace = showbaseLineWorkspace.createSubprojectController({
  state: costingState,
  getRows: costingSubprojects,
  isReadOnly: () => costingState.current?.status === 'converted',
  mimeType: 'application/x-showbase-costing-room',
  commit: reordered => {
    if (!reordered || !costingState.current) return false;
    costingState.current.subprojects = reordered;
    costingState.changeVersion += 1;
    costingQueueSave();
    costingRenderEditor();
    return true;
  }
});

function costingClearSubprojectDropTargets() {
  costingSubprojectWorkspace.clearDropTargets();
}

function costingSubprojectDragStart(event, subprojectId) {
  costingSubprojectWorkspace.dragStart(event, subprojectId);
}

function costingSubprojectDragOver(event, targetId) {
  costingSubprojectWorkspace.dragOver(event, targetId);
}

function costingSubprojectDragLeave(event) {
  costingSubprojectWorkspace.dragLeave(event);
}

function costingSubprojectEndDragOver(event) {
  costingSubprojectWorkspace.endDragOver(event);
}

function costingSubprojectEndDragLeave(event) {
  costingSubprojectWorkspace.endDragLeave(event);
}

function costingSubprojectSlotDragOver(event, targetIndex) {
  costingSubprojectWorkspace.slotDragOver(event, targetIndex);
}

function costingSubprojectSlotDragLeave(event) {
  costingSubprojectWorkspace.slotDragLeave(event);
}

function costingReorderSubprojectAtIndex(sourceId, targetIndex) {
  return costingSubprojectWorkspace.reorderAtIndex(sourceId, targetIndex);
}

function costingSubprojectDropAtIndex(event, targetIndex) {
  costingSubprojectWorkspace.dropAtIndex(event, targetIndex);
}

function costingReorderSubproject(sourceId, targetId, position = 'before') {
  return costingSubprojectWorkspace.reorder(sourceId, targetId, position);
}

function costingSubprojectDrop(event, targetId) {
  costingSubprojectWorkspace.drop(event, targetId);
}

function costingSubprojectDropAtEnd(event) {
  costingSubprojectWorkspace.dropAtEnd(event);
}

function costingSubprojectDragEnd() {
  costingSubprojectWorkspace.dragEnd();
}

function costingSubprojectDragKeydown(event, subprojectId) {
  costingSubprojectWorkspace.dragKeydown(event, subprojectId);
}

async function costingAddSubproject() {
  const name = await showAppPrompt({
    title: 'Add sub-project',
    inputLabel: 'Sub-project name',
    placeholder: 'e.g. Ballroom, Breakout Room',
    confirmText: 'Add',
    required: true
  });
  if (!String(name || '').trim()) return;
  const id = `room_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  costingSubprojects().push({ id, name: String(name).trim() });
  costingState.activeSubprojectId = id;
  costingState.addCategory = '';
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
}

async function costingRenameSubproject(subprojectId) {
  const row = costingSubprojects().find(item => item.id === subprojectId);
  if (!row) return;
  const name = await showAppPrompt({
    title: 'Rename sub-project',
    inputLabel: 'Sub-project name',
    defaultValue: row.name,
    confirmText: 'Rename',
    required: true
  });
  if (!String(name || '').trim()) return;
  row.name = String(name).trim();
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
}

async function costingDeleteSubproject(subprojectId) {
  const rows = costingSubprojects();
  const row = rows.find(item => item.id === subprojectId);
  if (!row || rows.length <= 1) return;
  const lineCount = costingLines().filter(
    line => String(line.subprojectId || 'main') === subprojectId
  ).length;
  const confirmed = await showAppConfirm({
    title: `Delete ${row.name}?`,
    message: lineCount
      ? `This also removes ${lineCount} costing item${lineCount === 1 ? '' : 's'} from this sub-project and its linked quotation.`
      : 'This removes the empty sub-project from the costing and quotation.',
    confirmText: 'Delete Sub-project',
    variant: 'danger'
  });
  if (!confirmed) return;
  costingState.current.subprojects = rows.filter(item => item.id !== subprojectId);
  costingState.current.lineItems = costingLines().filter(
    line => String(line.subprojectId || 'main') !== subprojectId
  );
  costingState.current.categoryAdjustments = (
    costingState.current.categoryAdjustments || []
  ).filter(item => String(item.subprojectId || 'main') !== subprojectId);
  costingState.activeSubprojectId = costingState.current.subprojects[0].id;
  costingState.addCategory = '';
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
}

function costingLineDescriptionDraft(index, value) {
  const line = costingLines()[index];
  if (line) line.description = value;
}

async function costingLineDescriptionChanged(index, value, input) {
  const line = costingLines()[index];
  if (!line) return;
  const previous = String(input?.dataset.originalValue ?? line.description ?? '');
  const next = String(value || '').trim();
  line.description = next;
  if (next === previous) return;
  if (costingLineIsInventoryLinked(line)) {
    const decision = await showAppConfirm({
      title: 'Keep inventory link?',
      message: 'Choose whether this new costing name should remain linked to the original inventory asset.',
      confirmText: 'Keep Link',
      confirmValue: 'keep',
      alternateText: 'Break Link',
      alternateValue: 'break',
      alternateClass: 'btn-warning',
      cancelText: 'Cancel Rename',
      variant: 'warning'
    });
    if (!decision) {
      line.description = previous;
      if (input) input.value = previous;
      return;
    }
    if (decision === 'break') {
      costingBreakInventoryLink(line);
    } else {
      line.inventoryNameMode = 'costing';
    }
  } else {
    costingBreakInventoryLink(line);
  }
  costingApplyUnboundNamePolicy(line);
  if (input) input.dataset.originalValue = next;
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
}

function costingLineInput(index, field, value) {
  const line = costingLines()[index];
  if (!line) return;
  if (field === 'remarks') {
    line.remarks = value;
  } else {
    const previousUnitSale = costingLineUnitSale(line);
    const followedCalculation = Math.abs(costingNumber(line.salePrice) - costingNumber(line.calculatedSalePrice)) < 0.005;
    line[field] = costingNumber(value);
    costingLineRecalculate(line, 'cost');
    if (followedCalculation) {
      costingLineRecalculate(line, 'margin-percent');
    } else if (field === 'quantity' || field === 'multiplier') {
      const divisor = Math.max(0, costingNumber(line.quantity))
        * Math.max(0, costingNumber(line.multiplier));
      line.salePrice = Math.round(previousUnitSale * (divisor || 1) * 100) / 100;
      costingLineRecalculate(line, 'sale');
    }
    costingSetSaleGroupUnitPrice(index, costingLineUnitSale(line));
  }
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRefreshCalculations();
}

function costingLineSale(index, value) {
  const line = costingLines()[index];
  if (!line) return;
  const totalSale = Math.max(0, costingNumber(value));
  const divisor = Math.max(0, costingNumber(line.quantity))
    * Math.max(0, costingNumber(line.multiplier));
  costingSetSaleGroupUnitPrice(index, divisor ? totalSale / divisor : totalSale);
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRefreshCalculations();
}

function costingLineUnitPrice(index, value) {
  if (!costingLines()[index]) return;
  costingSetSaleGroupUnitPrice(index, Math.max(0, costingNumber(value)));
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRefreshCalculations();
}

function costingLineCostTotal(index, value) {
  const line = costingLines()[index];
  if (!line) return;
  const followedCalculation = Math.abs(
    costingNumber(line.salePrice) - costingNumber(line.calculatedSalePrice)
  ) < 0.005;
  const targetTotal = Math.max(0, costingNumber(value));
  const divisor = costingNumber(line.quantity) * costingNumber(line.multiplier);
  line.itemCost = divisor > 0
    ? Math.round((targetTotal / divisor) * 1000000) / 1000000
    : 0;
  costingLineRecalculate(line, 'cost');
  if (followedCalculation) {
    costingLineRecalculate(line, 'margin-percent');
    costingSetSaleGroupUnitPrice(index, costingLineUnitSale(line));
  }
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRefreshCalculations();
}

function costingLineMarginAmount(index, value) {
  const line = costingLines()[index];
  if (!line) return;
  const amount = costingNumber(value);
  line.targetMarginPercent = line.costTotal
    ? amount / line.costTotal * 100
    : 0;
  costingLineRecalculate(line, 'margin-percent');
  costingSetSaleGroupUnitPrice(index, costingLineUnitSale(line));
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRefreshCalculations();
}

function costingLineMarginPercent(index, value) {
  const line = costingLines()[index];
  if (!line) return;
  line.targetMarginPercent = costingNumber(value, 20);
  costingLineRecalculate(line, 'margin-percent');
  costingSetSaleGroupUnitPrice(index, costingLineUnitSale(line));
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRefreshCalculations();
}

async function costingVendorChanged(index, value, input) {
  const line = costingLines()[index];
  if (!line) return;
  const name = String(value || '').trim();
  const selected = costingState.vendors.find(row => row.name.toLowerCase() === name.toLowerCase());
  line.vendorName = selected?.name || name;
  line.vendorId = selected?.id || '';
  line.vendorType = selected?.type || 'vendor';
  if (name && name.toLowerCase() !== 'self' && costingLineIsInventoryLinked(line)) {
    costingBreakInventoryLink(line);
  }
  if (input) {
    input.value = line.vendorName;
    costingVendorColourChanged(input, index);
  }
  const followedCalculation = Math.abs(costingNumber(line.salePrice) - costingNumber(line.calculatedSalePrice)) < 0.005;
  if (name.toLowerCase() === 'self') line.itemCost = 0;
  costingLineRecalculate(line, 'cost');
  if (followedCalculation) {
    costingLineRecalculate(line, 'margin-percent');
    costingSetSaleGroupUnitPrice(index, costingLineUnitSale(line));
  }
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
  if (!name || name.toLowerCase() === 'self') return;
  try {
    const response = await apiCall('/api/costings/cost-suggestion', 'POST', { line });
    if (!response.data?.remembered || line.itemCost > 0) return;
    const followedCalculation = Math.abs(costingNumber(line.salePrice) - costingNumber(line.calculatedSalePrice)) < 0.005;
    line.itemCost = costingNumber(response.data.itemCost);
    costingLineRecalculate(line, 'cost');
    if (followedCalculation) {
      costingLineRecalculate(line, 'margin-percent');
      costingSetSaleGroupUnitPrice(index, costingLineUnitSale(line));
    }
    costingState.changeVersion += 1;
    costingQueueSave();
    costingRenderEditor();
  } catch {}
}

function costingToggleMultiplierLabel(index) {
  const line = costingLines()[index];
  if (!line) return;
  line.multiplierLabel = line.multiplierLabel === 'Day' ? 'Mult' : 'Day';
  costingQueueSave();
  costingRenderEditor();
}

function costingToggleAllMultiplierLabels() {
  const next = costingLines().some(line => line.multiplierLabel !== 'Day') ? 'Day' : 'Mult';
  costingSetAllMultiplierLabels(next);
}

function costingSetAllMultiplierLabels(label, encodedCategory = '') {
  const next = label === 'Day' ? 'Day' : 'Mult';
  const category = encodedCategory ? decodeURIComponent(encodedCategory) : '';
  costingVisibleLines().forEach(line => {
    if (!category || line.category === category) line.multiplierLabel = next;
  });
  costingEqualiseSaleGroups(costingLines());
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
}

function costingApplyMultiplierAll(valueOverride, encodedCategory = '') {
  const value = Math.max(0, costingNumber(valueOverride, 1));
  const category = encodedCategory ? decodeURIComponent(encodedCategory) : '';
  costingVisibleLines().forEach(line => {
    if (category && line.category !== category) return;
    const previousUnitSale = costingLineUnitSale(line);
    const followedCalculation = Math.abs(costingNumber(line.salePrice) - costingNumber(line.calculatedSalePrice)) < 0.005;
    line.multiplier = value;
    costingLineRecalculate(line, 'cost');
    if (followedCalculation) {
      costingLineRecalculate(line, 'margin-percent');
    } else {
      const divisor = Math.max(0, costingNumber(line.quantity))
        * Math.max(0, costingNumber(line.multiplier));
      line.salePrice = Math.round(previousUnitSale * (divisor || 1) * 100) / 100;
      costingLineRecalculate(line, 'sale');
    }
  });
  costingEqualiseSaleGroups(costingLines());
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
}

function costingApplyCategoryMargin(encodedCategory, valueOverride) {
  const category = decodeURIComponent(encodedCategory);
  const value = Math.max(-100, Math.min(9999, costingNumber(valueOverride, 20)));
  costingVisibleLines().forEach(line => {
    if (line.category !== category) return;
    line.targetMarginPercent = value;
    costingLineRecalculate(line, 'margin-percent');
  });
  costingEqualiseSaleGroups(costingLines());
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
}

function costingApplyCategoryVendor(encodedCategory, valueOverride) {
  const category = decodeURIComponent(encodedCategory);
  const name = String(valueOverride || '').trim();
  if (!name) {
    showNotification('warning', 'Choose or enter a vendor first');
    return;
  }
  const selected = costingState.vendors.find(
    row => String(row.name || '').toLowerCase() === name.toLowerCase()
  );
  costingVisibleLines().forEach(line => {
    if (line.category !== category) return;
    line.vendorName = selected?.name || name;
    line.vendorId = selected?.id || '';
    line.vendorType = selected?.type || 'vendor';
    if (name.toLowerCase() !== 'self' && costingLineIsInventoryLinked(line)) {
      costingBreakInventoryLink(line);
    }
    if (name.toLowerCase() === 'self') line.itemCost = 0;
    costingLineRecalculate(line, 'cost');
  });
  costingEqualiseSaleGroups(costingLines());
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
}

function costingCategoryCharge(encodedCategory, value) {
  const category = decodeURIComponent(encodedCategory);
  const totals = costingCategoryTotals(category);
  costingAdjustment(category).amount = Math.max(0, costingNumber(value)) - totals.rawSale;
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRefreshCalculations();
}

function costingCategoryProfit(encodedCategory, value) {
  const category = decodeURIComponent(encodedCategory);
  const totals = costingCategoryTotals(category);
  const charged = totals.cost + costingNumber(value);
  costingAdjustment(category).amount = Math.max(0, charged) - totals.rawSale;
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRefreshCalculations();
}

function costingRenameCategory(encodedCategory, value) {
  const previous = decodeURIComponent(encodedCategory);
  const next = String(value || '').trim() || previous;
  costingVisibleLines().forEach(line => { if (line.category === previous) line.category = next; });
  const adjustment = costingAdjustment(previous);
  adjustment.category = next;
  costingState.addCategory = next;
  costingQueueSave();
  costingRenderEditor();
}

function costingRemoveLine(index) {
  costingLines().splice(index, 1);
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
}

function costingRefreshCalculations() {
  costingLines().forEach((line, index) => {
    costingLineRecalculate(line, 'sale');
    const row = document.querySelector(`.costing-line[data-costing-line="${index}"]`);
    if (!row) return;
    const unitCost = row.querySelector('[data-line-unit-cost]');
    const costTotal = row.querySelector('[data-line-cost-total]');
    if (unitCost && document.activeElement !== unitCost) unitCost.value = line.itemCost.toFixed(2);
    if (costTotal && document.activeElement !== costTotal) costTotal.value = line.costTotal.toFixed(2);
    const marginAmount = row.querySelector('[data-line-margin-amount]');
    const marginPercent = row.querySelector('[data-line-margin-percent]');
    const unitPrice = row.querySelector('[data-line-unit-price]');
    const unitPriceWrap = row.querySelector('[data-line-unit-price-wrap]');
    const sale = row.querySelector('[data-line-sale]');
    const saleWrap = row.querySelector('[data-line-sale-wrap]');
    const calculated = row.querySelector('[data-line-calculated]');
    if (marginAmount && document.activeElement !== marginAmount) marginAmount.value = line.calculatedMarginAmount.toFixed(2);
    if (marginPercent && document.activeElement !== marginPercent) marginPercent.value = line.targetMarginPercent.toFixed(2);
    const currentUnitPrice = costingLineUnitSale(line);
    const unitPriceState = costingUnitPriceState(line);
    const saleState = costingSaleState(line);
    if (unitPrice && document.activeElement !== unitPrice) unitPrice.value = currentUnitPrice.toFixed(2);
    if (sale && document.activeElement !== sale) sale.value = line.salePrice.toFixed(2);
    costingApplyPriceState(unitPriceWrap, unitPriceState);
    costingApplyPriceState(saleWrap, saleState);
    if (calculated) calculated.textContent = costingMoney(line.calculatedSalePrice);
    const unitDifference = row.querySelector('[data-line-unit-difference]');
    if (unitDifference) unitDifference.textContent = costingComparisonMoney(currentUnitPrice, line.itemCost);
    costingApplyPriceState(unitDifference, unitPriceState);
    const saleDifference = row.querySelector('[data-line-sale-difference]');
    if (saleDifference) saleDifference.textContent = costingComparisonMoney(line.salePrice, line.costTotal);
    costingApplyPriceState(saleDifference, saleState);
  });
  costingCategories().forEach(category => {
    const encoded = encodeURIComponent(category);
    const row = document.querySelector(`[data-category-total="${CSS.escape(encoded)}"]`);
    if (!row) return;
    const totals = costingCategoryTotals(category);
    const profitInput = row.querySelector('[data-category-profit]');
    const chargeInput = row.querySelector('[data-category-charge]');
    if (profitInput && document.activeElement !== profitInput) profitInput.value = totals.profit.toFixed(2);
    if (chargeInput && document.activeElement !== chargeInput) chargeInput.value = totals.charged.toFixed(2);
    row.querySelectorAll('[data-category-cost]').forEach(node => { node.textContent = costingMoney(totals.cost); });
    const revenue = row.querySelector('[data-category-revenue]');
    const profit = row.querySelector('[data-category-profit-display]');
    const adjustment = row.querySelector('[data-category-adjustment]');
    if (revenue) revenue.textContent = costingMoney(totals.charged);
    if (profit) profit.textContent = costingMoney(totals.profit);
    if (adjustment) adjustment.textContent = totals.adjustment ? `Adjustment ${costingMoney(totals.adjustment)}` : 'No category adjustment';
  });
  const breakdown = document.getElementById('costingBreakdownList');
  if (breakdown) breakdown.innerHTML = costingSummaryRowsMarkup();
  costingRefreshVendorManagementAmounts();
  const totals = costingTotals();
  const sale = document.getElementById('costingTotalSale');
  const cost = document.getElementById('costingTotalCost');
  const profit = document.getElementById('costingTotalProfit');
  const margin = document.getElementById('costingTotalMargin');
  if (sale) sale.textContent = costingMoney(totals.sale);
  if (cost) cost.textContent = costingMoney(totals.cost);
  if (profit) profit.textContent = costingMoney(totals.profit);
  const marginPercent = costingMarginPercent(totals);
  if (margin) margin.textContent = `${marginPercent.toFixed(1)}%`;
  document.querySelectorAll('[data-summary-total-cost]').forEach(node => { node.textContent = costingMoney(totals.cost); });
  document.querySelectorAll('[data-summary-total-profit]').forEach(node => { node.textContent = costingMoney(totals.profit); });
  document.querySelectorAll('[data-summary-total-margin]').forEach(node => { node.textContent = `${marginPercent.toFixed(1)}%`; });
}

function costingSearchCatalog(value) {
  const query = String(value || '').trim();
  const results = document.getElementById('costingCatalogResults');
  clearTimeout(costingState.catalogTimer);
  if (query.length < 2) {
    costingState.catalog = [];
    results?.classList.remove('open');
    return;
  }
  if (results) {
    results.innerHTML = '<div class="finance-suggestion-empty">Searching inventory...</div>';
    results.classList.add('open');
  }
  costingState.catalogTimer = setTimeout(async () => {
    try {
      const response = await apiCall(`/api/finance/catalog?query=${encodeURIComponent(query)}`);
      costingState.catalog = response.data || [];
    } catch {
      costingState.catalog = [];
    }
    if (!results) return;
    results.innerHTML = costingState.catalog.map((row, index) => `<button type="button" class="finance-catalog-option" onclick="costingSelectCatalog(${index})"><span><strong>${costingEscape(row.description || 'Inventory item')}</strong><br><small>${costingEscape(row.department || 'General')} &middot; ${costingNumber(row.availableQuantity)} available</small></span><small>Self</small></button>`).join('') || '<div class="finance-suggestion-empty">No inventory match. Add it as a custom item.</div>';
    results.classList.add('open');
  }, 180);
}

function costingNewLine(selected) {
  const category = String(
    document.getElementById('costingAddCategoryInput')?.value
    || costingState.addCategory
    || selected.department
    || 'General'
  ).trim() || 'General';
  const defaults = costingCategoryDefaults(category);
  const line = costingLineRecalculate({
    id: `costline_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    catalogKey: selected.catalogKey || '',
    sourceAssetIds: selected.sourceAssetIds || [],
    brand: selected.brand || '',
    model: selected.model || '',
    description: selected.description || 'Custom item',
    remarks: '',
    category,
    departmentCode: selected.departmentCode || '',
    quantity: Math.max(0, costingNumber(selected.quantityOverride, 1)),
    multiplier: defaults.multiplier,
    multiplierLabel: defaults.multiplierLabel,
    subprojectId: costingActiveSubprojectId(),
    quotationLineId: '',
    vendorName: selected.catalogKey ? 'Self' : '',
    vendorId: '',
    vendorType: 'vendor',
    itemCost: 0,
    targetMarginPercent: defaults.targetMarginPercent,
    salePrice: 0,
    isCustom: !selected.catalogKey
  }, 'margin-percent');
  costingApplyUnboundNamePolicy(line);
  const matchingLine = costingLines().find(
    row => costingLineSaleGroupKey(row) === costingLineSaleGroupKey(line)
  );
  if (matchingLine) {
    const divisor = Math.max(0, costingNumber(line.quantity))
      * Math.max(0, costingNumber(line.multiplier));
    line.salePrice = Math.round(
      costingLineUnitSale(matchingLine) * (divisor || 1) * 100
    ) / 100;
    costingLineRecalculate(line, 'sale');
  }
  return line;
}

function costingSelectCatalog(index) {
  const selected = costingState.catalog[index];
  if (!selected) return;
  if (selected.isContainer && Array.isArray(selected.containerItems)) {
    const groupId = `group_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const groupTitle = typeof financeContainerFamilyLabel === 'function'
      ? financeContainerFamilyLabel(selected.containerId || selected.description || 'Container')
      : (selected.description || selected.containerId || 'Container');
    selected.containerItems.forEach(item => costingLines().push({ ...costingNewLine({
      ...item,
      quantityOverride: item.containerQuantity || item.availableQuantity || 1
    }), groupId, groupTitle, groupDisplayFields: ['brand', 'model', 'description'], groupCustomText: false }));
  } else {
    costingLines().push(costingNewLine(selected));
  }
  costingState.addCategory = '';
  costingState.catalog = [];
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
}

function costingAddCustomItem() {
  const input = document.getElementById('costingAddItemInput');
  const description = String(input?.value || '').trim();
  if (!description) return input?.focus();
  costingLines().push(costingNewLine({ description }));
  costingState.addCategory = '';
  costingState.changeVersion += 1;
  costingQueueSave();
  costingRenderEditor();
}

function costingAddItemKeydown(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  if (costingState.catalog.length === 1) costingSelectCatalog(0);
  else costingAddCustomItem();
}

function costingQueueSave() {
  if (!costingState.current || costingState.current.status === 'converted') return;
  clearTimeout(costingState.saveTimer);
  const state = document.getElementById('costingSaveState');
  if (state) state.textContent = 'Unsaved changes';
  costingState.saveTimer = setTimeout(() => costingSave(false), 600);
}

async function costingSave(notify = false, conflictRetry = 0) {
  const current = costingState.current;
  if (!current || current.status === 'converted') return current;
  clearTimeout(costingState.saveTimer);
  costingState.saveTimer = null;
  const version = costingState.changeVersion;
  const localSnapshot = financeCloneDocument(current);
  const baseSnapshot = financeCloneDocument(costingState.baseDocument || current);
  const state = document.getElementById('costingSaveState');
  if (state) state.textContent = 'Saving...';
  const payload = {
    ...current,
    _baseDocument: baseSnapshot,
    quotationSyncMode: costingState.quotationSyncMode || undefined
  };
  const promise = apiCall(`/api/costings/${encodeURIComponent(current.id)}`, 'PUT', payload);
  costingState.activeSave = promise;
  try {
    const response = await promise;
    if (costingState.current?.id === current.id) {
      costingState.baseDocument = financeCloneDocument(response.data);
    }
    if (costingState.current?.id === current.id && version === costingState.changeVersion) {
      costingState.current = response.data;
    } else if (costingState.current?.id === current.id) {
      costingQueueSave();
    }
    const next = document.getElementById('costingSaveState');
    if (next) next.textContent = 'All changes saved';
    if (notify) showNotification('success', 'Costing saved');
    if (response.quotation?.status === 'draft') costingState.quotationSyncMode = '';
    return response.data;
  } catch (error) {
    if (
      error.payload?.code === 'document_version_conflict'
      && error.payload?.data
      && conflictRetry < 1
      && costingState.current?.id === current.id
    ) {
      const latest = error.payload.data;
      const newestLocal = costingState.changeVersion === version
        ? localSnapshot
        : financeCloneDocument(costingState.current);
      const mergedLocal = financeMergeDocumentConflict(
        baseSnapshot, newestLocal, latest
      );
      const decision = await showAppConfirm({
        title: 'Costing changed elsewhere',
        message: 'Another user changed the same costing detail. Keep your value, or use the latest saved value?',
        confirmText: 'Keep My Changes',
        confirmValue: 'keep-local',
        alternateText: 'Use Latest',
        alternateValue: 'use-latest',
        cancelText: 'Review First'
      });
      if (decision === 'keep-local') {
        mergedLocal.documentVersion = latest.documentVersion;
        costingState.baseDocument = financeCloneDocument(latest);
        costingState.current = mergedLocal;
        costingState.changeVersion += 1;
        costingRenderEditor();
        return costingSave(notify, conflictRetry + 1);
      }
      if (decision === 'use-latest') {
        costingState.baseDocument = financeCloneDocument(latest);
        costingState.current = latest;
        costingState.changeVersion += 1;
        costingRenderEditor();
        return latest;
      }
      if (state) state.textContent = 'Conflict needs review';
      return newestLocal;
    }
    if (error.payload?.code === 'quotation_revision_decision_required') {
      const quote = error.payload.quotation || {};
      const decision = await showAppConfirm({
        title: 'Update the sent quotation?',
        message: `${quote.number || 'The linked quotation'} is ${String(quote.status || 'not a draft').replace('-', ' ')}. Create a new draft revision, edit the existing sent revision directly, or keep the quotation and costing unchanged.`,
        confirmText: 'Create New Revision',
        confirmValue: 'new-revision',
        alternateText: 'Edit Existing Revision',
        alternateValue: 'edit-current',
        alternateClass: 'btn-warning',
        cancelText: 'No Changes',
        variant: 'warning'
      });
      if (!decision) {
        try {
          const refreshed = await apiCall(`/api/costings/${encodeURIComponent(current.id)}`);
          if (costingState.current?.id === current.id) {
            costingState.current = refreshed.data;
            costingState.baseDocument = financeCloneDocument(refreshed.data);
            costingState.changeVersion += 1;
            costingState.quotationSyncMode = '';
            costingRenderEditor();
          }
        } catch {}
        return costingState.current;
      }
      costingState.quotationSyncMode = decision;
      return costingSave(notify);
    }
    if (state) state.textContent = 'Save failed';
    if (notify) showNotification('error', error.message || 'Failed to save costing');
    throw error;
  } finally {
    if (costingState.activeSave === promise) costingState.activeSave = null;
  }
}

async function costingFlushSave() {
  if (costingState.saveTimer) await costingSave(false);
  if (costingState.activeSave) await costingState.activeSave.catch(() => {});
  if (costingState.saveTimer) await costingSave(false);
  return costingState.current;
}

async function costingSaveDraft() {
  try {
    await costingFlushSave();
    showNotification('success', 'Costing saved');
  } catch (error) {
    showNotification('error', error.message || 'Failed to save costing');
  }
}

async function costingExportPdf(button) {
  const current = costingState.current;
  if (!current) return;
  const originalLabel = button?.textContent || 'Export PDF';
  if (button) {
    button.disabled = true;
    button.textContent = 'Preparing PDF...';
  }
  try {
    const saved = await costingFlushSave();
    const cacheKey = saved?.updatedAt || Date.now();
    const pdfUrl = `/api/costings/${encodeURIComponent(current.id)}/pdf?v=${encodeURIComponent(cacheKey)}`;
    const opened = window.open(pdfUrl, '_blank', 'noopener');
    if (!opened) {
      showNotification('warning', 'Please allow pop-ups to preview the PDF');
    }
  } catch (error) {
    showNotification('error', error.message || 'Failed to export costing PDF');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

async function costingBackToList() {
  try { await costingFlushSave(); } catch {}
  costingState.current = null;
  if (typeof updateAppDetailHistory === 'function') updateAppDetailHistory('/costing');
  costingLoadList();
}

async function costingDelete() {
  const current = costingState.current;
  if (!current) return;
  const confirmed = await showAppConfirm({
    title: 'Delete costing?',
    message: `Delete the costing for ${current.projectName || 'this project'}?`,
    confirmText: 'Delete Costing',
    variant: 'danger'
  });
  if (!confirmed) return;
  try {
    await apiCall(`/api/costings/${encodeURIComponent(current.id)}`, 'DELETE');
    showNotification('success', 'Costing deleted');
    costingState.current = null;
    if (typeof updateAppDetailHistory === 'function') updateAppDetailHistory('/costing', true);
    costingLoadList();
  } catch (error) {
    showNotification('error', error.message || 'Failed to delete costing');
  }
}

async function costingMakeQuotation() {
  const current = costingState.current;
  if (!current) return;
  if (!String(current.projectName || '').trim()) {
    showNotification('error', 'Project Name is required');
    document.getElementById('costingProjectName')?.focus();
    return;
  }
  try {
    await costingFlushSave();
    const response = await apiCall(`/api/costings/${encodeURIComponent(current.id)}/convert-to-quotation`, 'POST', {});
    costingState.current = response.costing || costingState.current;
    costingState.baseDocument = financeCloneDocument(costingState.current);
    showNotification('success', `Quotation ${response.data.number} created`);
    showSection('quotations');
    if (typeof financeOpenDocument === 'function') financeOpenDocument(response.data.id);
  } catch (error) {
    showNotification('error', error.message || 'Failed to make quotation');
  }
}

async function costingOpenQuotation() {
  try { await costingFlushSave(); } catch { return; }
  const id = costingState.current?.convertedQuotationId || costingState.current?.sourceQuotationId;
  if (!id) return;
  showSection('quotations');
  if (typeof financeOpenDocument === 'function') financeOpenDocument(id);
}

document.addEventListener('click', event => {
  if (!event.target.closest('#costingContextMenu')) costingCloseContextMenu();
  if (!event.target.closest('#costingLineContextMenu')) costingCloseLineContextMenu();
});
