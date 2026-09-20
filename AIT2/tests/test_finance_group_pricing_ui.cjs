const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/finance.js'), 'utf8');

function groupLines() {
  const shared = {
    groupId: 'audio-kit',
    groupTitle: 'Audio kit',
    groupDisplayFields: ['description'],
    groupCustomText: false,
    groupItemDays: 2,
    groupItemUom: 'units',
    groupItemDiscountPercent: 0,
    groupItemTotalMode: 'calculated',
    groupItemCommercialStored: true,
    groupPricingMode: 'items',
    department: 'Audio Department',
    systemName: 'Audio',
    subprojectId: 'main',
    days: 2,
    quantity: 2,
    uom: 'lot',
    unitPrice: 55,
    discountPercent: 0,
    totalMode: 'amount',
  };
  return [
    {
      ...shared,
      id: 'speaker',
      description: 'Speaker',
      groupLeader: true,
      groupHeaderQuantity: 2,
      groupItemQuantity: 1,
      groupItemUnitPrice: 25,
      groupItemTotal: 50,
      groupItemPriceContribution: 25,
      total: 220,
    },
    {
      ...shared,
      id: 'stand',
      description: 'Speaker stand',
      groupLeader: false,
      groupHeaderQuantity: 2,
      groupItemQuantity: 1,
      groupItemUnitPrice: 30,
      groupItemTotal: 60,
      groupItemPriceContribution: 30,
      total: 0,
    },
  ];
}

function setup({ apiResponse = {} } = {}) {
  const apiCalls = [];
  const elements = {
    financeLineGroupTitle: { value: 'Remembered kit' },
    financeLineGroupCategory: { value: 'Audio' },
    financeLineGroupQuantity: { value: '1' },
    financeLineGroupCustomText: { value: '' },
  };
  const context = vm.createContext({
    document: {
      addEventListener() {},
      getElementById(id) { return elements[id] || null; },
      querySelectorAll() { return [{ value: 'description' }]; },
      createElement() { return { textContent: '', innerHTML: '' }; },
    },
    showbaseLineWorkspace: {
      createSubprojectController() { return {}; },
      categoryHeaderRowMarkup({ content }) { return `<tr><td>${content}</td></tr>`; },
      categoryToggleMarkup() { return ''; },
    },
    clearTimeout() {},
    setTimeout() { return 1; },
    apiCall: async url => {
      apiCalls.push(url);
      return { data: apiResponse };
    },
    closeModal() {},
    showNotification() {},
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    financeQueueSave = () => {};
    financeRenderEditor = () => {};
    financeState.current = {
      id: 'quote-1',
      type: 'quotation',
      lineItems: ${JSON.stringify(groupLines())},
      subprojects: [{ id: 'main', name: 'Main Room' }],
      adjustments: [],
      headerRows: [],
      taxRate: 0
    };
    financeState.activeSubprojectId = 'main';
  `, context);
  return { context, apiCalls };
}

test('manual group total greys item pricing until an item price is edited', () => {
  const { context } = setup();

  vm.runInContext("financeSetLineTotal(0, '300')", context);
  assert.equal(vm.runInContext('financeState.current.lineItems[0].total', context), 300);
  assert.equal(vm.runInContext('financeState.current.lineItems[0].unitPrice', context), 75);
  assert.equal(vm.runInContext('financeState.current.lineItems[1].groupPricingMode', context), 'total');

  vm.runInContext("financeGroupItemQuantityChange(1, '2')", context);
  assert.equal(vm.runInContext('financeState.current.lineItems[0].total', context), 300);

  const overriddenMarkup = vm.runInContext('financeRenderLineGroups()', context);
  assert.match(overriddenMarkup, /Manual total/);
  assert.match(overriddenMarkup, /finance-group-child-pricing is-inactive/);
  assert.match(overriddenMarkup, /aria-label="Item unit price"/);
  assert.match(overriddenMarkup, /aria-label="Item amount per group"/);

  vm.runInContext("financeGroupItemUnitPriceChange('1', '40')", context);
  assert.equal(vm.runInContext('financeState.current.lineItems[0].groupPricingMode', context), 'items');
  assert.equal(vm.runInContext('financeState.current.lineItems[0].unitPrice', context), 105);
  assert.equal(vm.runInContext('financeState.current.lineItems[0].total', context), 420);
});

test('editing an item amount recalculates the group total', () => {
  const { context } = setup();
  vm.runInContext("financeGroupItemAmountChange('1', '50')", context);

  assert.equal(vm.runInContext('financeState.current.lineItems[1].groupItemPriceContribution', context), 50);
  assert.equal(vm.runInContext('financeState.current.lineItems[0].unitPrice', context), 75);
  assert.equal(vm.runInContext('financeState.current.lineItems[0].total', context), 300);
});

test('a remembered group price starts a newly added group in manual-total mode', async () => {
  const { context, apiCalls } = setup({
    apiResponse: {
      remembered: true,
      unitPrice: 175,
      discountPercent: 0,
      uom: 'lot',
    },
  });
  vm.runInContext(`
    financeState.current.lineItems = [];
    financeLineGroupState.mode = 'finance';
    financeLineGroupState.groupId = 'remembered-kit';
    financeLineGroupState.subprojectId = 'main';
    financeLineGroupState.commercialHeader = null;
    financeLineGroupState.selected = [
      { key: 'speaker', catalog: { description: 'Speaker', department: 'Audio Department', unitPrice: 25, quantityOverride: 1 } },
      { key: 'stand', catalog: { description: 'Stand', department: 'Audio Department', unitPrice: 30, quantityOverride: 1 } }
    ];
  `, context);

  await vm.runInContext('financeSaveLineGroup()', context);

  assert.match(apiCalls[0], /group-price-suggestion\?title=Remembered%20kit/);
  assert.equal(vm.runInContext('financeState.current.lineItems[0].unitPrice', context), 175);
  assert.equal(vm.runInContext('financeState.current.lineItems[0].groupPricingMode', context), 'total');
  assert.equal(vm.runInContext('financeState.current.lineItems[1].groupItemUnitPrice', context), 30);
});

test('a quotation group can be saved without assets or custom text', async () => {
  const { context, apiCalls } = setup();
  vm.runInContext(`
    financeState.current.lineItems = [];
    financeLineGroupState.mode = 'finance';
    financeLineGroupState.groupId = 'empty-kit';
    financeLineGroupState.subprojectId = 'main';
    financeLineGroupState.commercialHeader = null;
    financeLineGroupState.selected = [];
  `, context);

  await vm.runInContext('financeSaveLineGroup()', context);

  assert.match(apiCalls[0], /group-price-suggestion\?title=Remembered%20kit/);
  const line = JSON.parse(vm.runInContext(
    'JSON.stringify(financeState.current.lineItems[0])', context
  ));
  assert.equal(line.groupId, 'empty-kit');
  assert.equal(line.groupTitle, 'Remembered kit');
  assert.equal(line.groupPlaceholder, true);
  assert.equal(line.groupLeader, true);
  assert.equal(line.groupItemQuantity, 0);
  assert.equal(line.description, '');
  assert.equal(line.systemName, 'Audio');
  assert.equal(line.uom, 'sets');

  const markup = vm.runInContext('financeRenderLineGroups()', context);
  assert.match(markup, /finance-line-group-header/);
  assert.doesNotMatch(markup, /finance-group-child-row/);
});
