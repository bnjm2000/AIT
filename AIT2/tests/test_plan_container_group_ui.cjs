const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '../static/js/plan.js'),
  'utf8'
);
const prepareSource = fs.readFileSync(
  path.join(__dirname, '../static/js/prepare.js'),
  'utf8'
);

function setup() {
  const context = vm.createContext({
    normalizeDepartmentCode(value) {
      return String(value || 'UN').trim().toUpperCase();
    },
    getPreparedQuantity(group) {
      return Number(group?.preparedQuantity || 0);
    },
    compareByDisplayName(left, right) {
      return String(left || '').localeCompare(String(right || ''));
    },
    modelGroupSortName(group) {
      return `${group?.brand || ''} ${group?.model || ''}`;
    },
  });
  vm.runInContext(source, context);
  return context;
}

function groupedEvent() {
  return {
    containerGroups: [{
      id: 'case-group',
      containerId: 'CASE-1',
      title: 'CASE-1',
      quantity: 1,
      subprojectId: 'main',
      items: [{
        department: 'AX', brand: 'Brand', model: 'Speaker',
        description: 'Speaker', quantity: 2,
      }],
    }],
    modelGroups: {
      speaker: {
        department: 'AX', brand: 'Brand', model: 'Speaker',
        description: 'Speaker', requiredQuantity: 4,
        preparedQuantity: 3, preparedEverQuantity: 3,
        countablePreparedEverQuantity: 3,
        assignedQuantity: 3, returnedQuantity: 0,
        countableReturnedQuantity: 0, assignedAssets: [],
      },
    },
  };
}

test('matching prepared assets fill outside requirements before a container group', () => {
  const context = setup();
  context.eventData = groupedEvent();
  const result = vm.runInContext(`(() => {
    const state = { activeSubprojectId: '' };
    return {
      loose: eventUngroupedModelGroups(eventData, state),
      containers: eventContainerGroupModelGroups(eventData, state),
    };
  })()`, context);

  assert.equal(result.loose[0].requiredQuantity, 2);
  assert.equal(result.loose[0].preparedEverQuantity, 2);
  assert.equal(result.containers[0].modelGroups[0].requiredQuantity, 2);
  assert.equal(result.containers[0].modelGroups[0].preparedEverQuantity, 1);
});

test('container view toggle exposes the original individual model quantities', () => {
  const context = setup();
  context.eventData = groupedEvent();
  vm.runInContext(`
    planPageState.event = eventData;
    planPageState.showGroupedContainers = false;
  `, context);
  const groups = vm.runInContext('planModelGroups(eventData)', context);
  const containers = vm.runInContext('planContainerGroups(eventData)', context);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].requiredQuantity, 4);
  assert.equal(containers.length, 0);
});

test('prepare workspace exposes the same grouped or individual container toggle', () => {
  assert.match(prepareSource, /onchange="prepareNewToggleContainerGrouping\(this\.checked\)"/);
  assert.match(prepareSource, /function prepareNewToggleContainerGrouping\(grouped\)/);
  assert.match(prepareSource, /prepareNewPageState\.showGroupedContainers \? 'Grouped' : 'Individual'/);
});
