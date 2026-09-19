const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/finance.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../static/css/finance.css'), 'utf8');

function setup(quantity = '1') {
  const quantityInput = { value: quantity };
  const results = { innerHTML: '' };
  const elements = {
    financeRateCardResults: results,
    financeRateCardAddButton: { hidden: false },
    financeRateCardForm: { hidden: true },
  };
  const context = vm.createContext({
    document: {
      addEventListener() {},
      getElementById(id) {
        if (id.startsWith('financeRateCardQuantity-')) return quantityInput;
        return elements[id] || null;
      },
      querySelectorAll() { return []; },
    },
    showbaseLineWorkspace: { createSubprojectController() { return {}; } },
    escapeHtml: value => String(value),
    escapeHtmlAttr: value => String(value),
    showNotification() {},
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    financeState.current = {
      id: 'quote-1', type: 'quotation', lineItems: [], adjustments: [],
      subprojects: [{ id: 'main', name: 'Main Room' }]
    };
    financeState.activeSubprojectId = 'main';
    financeState.rateCardTarget = 'quotation';
    financeState.rateCardTab = 'assets';
    financeQueueSave = () => {};
    financeRenderEditor = () => {};
  `, context);
  return { context, quantityInput, results };
}

test('Browse products shows a quantity input for each quotation product', () => {
  const { context, results } = setup();
  vm.runInContext(`financeState.rateCard = [{
    description: 'Speaker', department: 'Audio Department',
    productCategory: 'Audio System', unitPrice: 25, uom: 'units'
  }]; financeRenderRateCard();`, context);

  assert.match(results.innerHTML, /class="finance-rate-card-quantity"/);
  assert.match(results.innerHTML, /id="financeRateCardQuantity-0"/);
  assert.match(results.innerHTML, /min="1" step="1" value="1"/);
  assert.match(styles, /\.finance-rate-card-row\.has-quantity/);
});

test('Browse products quantity is applied to a normal quotation line', async () => {
  const { context } = setup('4');
  vm.runInContext(`financeState.rateCard = [{
    description: 'Speaker', department: 'Audio Department',
    productCategory: 'Audio System', unitPrice: 25, uom: 'units'
  }]`, context);

  await vm.runInContext('financeAddRateCardItemToQuotation(0)', context);
  const line = vm.runInContext('financeState.current.lineItems[0]', context);
  assert.equal(line.quantity, 4);
  assert.equal(line.total, 100);
});

test('Browse products quantity is applied as the container group quantity', async () => {
  const { context } = setup('3');
  context.apiCall = async () => ({ data: [{
    isContainer: true,
    containerId: 'BOX-1',
    department: 'Container',
    productCategory: 'Container',
    containerItems: [
      {
        description: 'Speaker', department: 'Audio Department',
        departmentCode: 'AUDIO', productCategory: 'Audio System',
        catalogKey: 'audio:speaker', containerQuantity: 2, unitPrice: 10
      },
      {
        description: 'Stand', department: 'Audio Department',
        departmentCode: 'AUDIO', productCategory: 'Audio System',
        catalogKey: 'audio:stand', containerQuantity: 1, unitPrice: 5
      }
    ]
  }] });
  vm.runInContext(`financeState.rateCard = [{
    isContainer: true, containerId: 'BOX-1', description: 'BOX-1'
  }]`, context);

  await vm.runInContext('financeAddRateCardItemToQuotation(0)', context);
  const lines = vm.runInContext('financeState.current.lineItems', context);
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => line.quantity === 3));
  assert.ok(lines.every(line => line.groupHeaderQuantity === 3));
  assert.deepEqual(Array.from(lines, line => line.groupItemQuantity), [2, 1]);
  assert.equal(lines[0].groupLeader, true);
  assert.equal(lines[0].uom, 'sets');
  assert.equal(lines[0].total, 75);
});

test('invalid Browse products quantities fall back to one', () => {
  const { context, quantityInput } = setup('0');
  assert.equal(vm.runInContext('financeRateCardQuantity(0)', context), 1);
  quantityInput.value = 'not-a-number';
  assert.equal(vm.runInContext('financeRateCardQuantity(0)', context), 1);
});
