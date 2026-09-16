const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const inventorySearchSource = fs.readFileSync(
  path.join(__dirname, '../static/js/inventory-export.js'), 'utf8'
);
const planSource = fs.readFileSync(
  path.join(__dirname, '../static/js/plan.js'), 'utf8'
);

function setup() {
  const results = { innerHTML: '' };
  const context = vm.createContext({
    Map,
    document: {
      getElementById(id) { return id === 'planAvailableResults' ? results : null; },
    },
    escapeHtml: value => String(value ?? ''),
    escapeHtmlAttr: value => String(value ?? ''),
    planEncode: value => encodeURIComponent(value),
    assetTagSearchText: () => '',
    normalizeDepartmentCode: value => value,
    compareByDisplayName: (left, right) => String(left).localeCompare(String(right)),
    buildEditAvailableAssetLookup: () => new Map(),
    buildContainerAvailableModelSummary: () => ({
      groups: [{ count: 2, brand: 'Robe', model: 'Spiider' }],
      usableCount: 2,
    }),
    editContainerSearchText: container => container.id.toLowerCase(),
    editContainerFamilyLabel: container => container.id,
    editContainerSummarySignature: () => 'same',
    modelAvailabilityReasonTooltip: () => '',
  });
  vm.runInContext(inventorySearchSource, context);
  vm.runInContext(planSource, context);
  context.planAvailableModelGroups = () => [{
    department: 'LX',
    brand: 'Robe',
    model: 'Spiider',
    description: 'LED Wash',
    count: 1,
    assets: [{ description: 'LED Wash' }],
  }];
  context.planAvailabilityFor = () => ({ available: 1, physical: 1 });
  context.planAvailabilityLabelHtml = () => '1 available';
  context.planDepartmentCodeBadgeHtml = () => '';
  context.planPageState.assets = [];
  context.planPageState.availability = [];
  context.planPageState.containers = [
    { id: 'Flight Case #01' },
    { id: 'Road Rack #02' },
  ];
  context.planPageState.department = 'ALL';
  context.planPageState.showContainers = true;
  return { context, results };
}

test('Plan combines brand, model and description words like Inventory', () => {
  const { context, results } = setup();
  context.planPageState.search = 'wash robe spiider';
  context.renderPlanAvailableResults();
  assert.match(results.innerHTML, /Robe Spiider/);

  context.planPageState.search = 'missing model + spiider wash';
  context.renderPlanAvailableResults();
  assert.match(results.innerHTML, /Robe Spiider/);

  context.planPageState.search = 'missing model';
  context.renderPlanAvailableResults();
  assert.doesNotMatch(results.innerHTML, /Robe Spiider/);
});

test('container prefix shows only matching containers, even when the toggle is off', () => {
  const { context, results } = setup();
  context.planPageState.showContainers = false;
  context.planPageState.search = 'container flight';
  context.renderPlanAvailableResults();
  assert.match(results.innerHTML, /Container: Flight Case #01/);
  assert.doesNotMatch(results.innerHTML, /Road Rack #02/);
  assert.doesNotMatch(results.innerHTML, /plan-item-name">Robe Spiider/);

  context.planPageState.search = 'container';
  context.renderPlanAvailableResults();
  assert.match(results.innerHTML, /Container: Flight Case #01/);
  assert.match(results.innerHTML, /Container: Road Rack #02/);
});
