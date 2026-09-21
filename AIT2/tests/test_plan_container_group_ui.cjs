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

function setup(localStorage = null) {
  const context = vm.createContext({
    ...(localStorage ? { window: { localStorage } } : {}),
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
  vm.runInContext(prepareSource, context);
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

test('grouped view preference survives a fresh page runtime', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const first = setup(storage);
  vm.runInContext('eventSaveContainerGroupingPreference(false)', first);
  const restarted = setup(storage);
  assert.equal(vm.runInContext('planPageState.showGroupedContainers', restarted), false);
  assert.equal(vm.runInContext('prepareNewPageState.showGroupedContainers', restarted), false);
});

test('individual view separates loose and container requirements', () => {
  const context = setup();
  context.eventData = groupedEvent();
  vm.runInContext(`
    planPageState.event = eventData;
    planPageState.showGroupedContainers = false;
  `, context);
  const groups = vm.runInContext('planModelGroups(eventData)', context);
  const containers = vm.runInContext('planContainerGroups(eventData)', context);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].requiredQuantity, 2);
  assert.equal(groups[1].requiredQuantity, 2);
  assert.equal(groups[1]._containerGroupId, 'case-group');
  assert.equal(groups[1]._containerItemQuantity, 2);
  assert.equal(containers.length, 0);
});

test('container group is placed under its dominant asset department', () => {
  const context = setup();
  context.container = {
    items: [
      { department: 'LX', quantity: 1 },
      { department: 'AX', quantity: 4 },
      { department: 'LX', quantity: 2 },
    ],
  };

  const department = vm.runInContext(
    'eventContainerGroupDepartment(container)',
    context
  );

  assert.equal(department, 'AX');
});

test('plan and prepare reuse the sidebar Containers icon', () => {
  assert.match(source, /navWireIconSvg\('containers'\)/);
  assert.match(prepareSource, /navWireIconSvg\('containers'\)/);
  assert.doesNotMatch(source, /plan-container-icon[^\n]*&#9638;/);
  assert.doesNotMatch(prepareSource, /prepare-container-icon[^\n]*&#9638;/);
});

test('prepare individual view also separates container children from loose requirements', () => {
  const context = setup();
  context.eventData = groupedEvent();
  vm.runInContext(`
    prepareNewPageState.event = eventData;
    prepareNewPageState.showGroupedContainers = false;
  `, context);
  const groups = vm.runInContext('prepareNewUngroupedModelGroups(eventData)', context);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].requiredQuantity, 2);
  assert.equal(groups[1]._containerGroupId, 'case-group');
});

test('plan container group exposes separate break and remove actions', () => {
  assert.match(source, /planBreakContainerGroup/);
  assert.match(source, /planRemoveContainerGroup/);
  assert.match(source, /container-groups\/\$\{encodeURIComponent\(groupId\)\}`,[\s\S]*?'DELETE'/);
});

test('plan container child actions target item or entire group', () => {
  assert.match(source, /function planSetContainerItemQuantity/);
  assert.match(source, /function planRemoveContainerItem/);
  assert.match(source, /alternateText: 'Remove Group'/);
});

test('prepare workspace exposes the same grouped or individual container toggle', () => {
  assert.match(prepareSource, /onchange="prepareNewToggleContainerGrouping\(this\.checked\)"/);
  assert.match(prepareSource, /function prepareNewToggleContainerGrouping\(grouped\)/);
  assert.match(prepareSource, /prepareNewPageState\.showGroupedContainers \? 'Grouped' : 'Individual'/);
});

test('prepare container rows offer preparation but no plan-editing actions', () => {
  const childSection = prepareSource.split('function prepareNewModelSection(group)', 2)[1]
    .split('function prepareNewDirectAssetCard(', 1)[0];
  const groupSection = prepareSource.split('function prepareNewContainerSection(container)', 2)[1]
    .split('function renderPrepareNewAssignment(', 1)[0];
  assert.match(childSection, /prepareNewPrepareAll/);
  assert.match(childSection, /prepareNewPrepareQty/);
  assert.doesNotMatch(childSection, /Edit qty|Remove container item|prepareNewEditContainerItem|prepareNewRemoveContainerItem/);
  assert.doesNotMatch(groupSection, /Break group|Remove|prepareNewBreakContainerGroup|prepareNewRemoveContainerGroup/);
});
