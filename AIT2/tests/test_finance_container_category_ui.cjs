const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/finance.js'), 'utf8');

function setup(categoryOverride = '') {
  const categoryInput = { value: categoryOverride };
  const groupCategoryInput = { value: 'Unknown' };
  const groupTitleInput = { value: '' };
  const context = vm.createContext({
    document: {
      addEventListener() {},
      getElementById(id) {
        return {
          financeAddDepartmentInput: categoryInput,
          financeLineGroupCategory: groupCategoryInput,
          financeLineGroupTitle: groupTitleInput,
        }[id] || null;
      },
    },
    showbaseLineWorkspace: { createSubprojectController() { return {}; } },
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    financeState.current = {
      id: 'quote-1',
      type: 'quotation',
      lineItems: [],
      subprojects: [{ id: 'main', name: 'Main Room' }]
    };
    financeState.activeSubprojectId = 'main';
  `, context);
  context.groupCategoryInput = groupCategoryInput;
  return context;
}

function container(items) {
  return {
    isContainer: true,
    containerId: 'BOX-1',
    department: 'Container',
    productCategory: 'Container',
    containerItems: items,
  };
}

function asset(department, category, quantity, description) {
  return {
    department: `${department} Department`,
    departmentCode: department.toUpperCase(),
    productCategory: category,
    containerQuantity: quantity,
    description,
    catalogKey: `${department}:${description}`,
  };
}

test('container group uses the category with the most assets, not the container category or most rows', () => {
  const context = setup();
  context.selectedContainer = container([
    asset('Lighting', 'Lighting System', 1, 'Lamp A'),
    asset('Lighting', 'Lighting System', 1, 'Lamp B'),
    asset('Audio', 'Audio System', 6, 'Speakers'),
  ]);

  const lines = vm.runInContext('financeAddContainerAsGroup(selectedContainer)', context);
  assert.equal(lines.length, 3);
  assert.ok(lines.every(line => line.systemName === 'Audio System'));
  assert.ok(lines.every(line => line.groupTitle === 'BOX-1'));
  assert.equal(lines[2].quantity, 6);
  assert.equal(lines[2].department, 'Audio Department');
});

test('container category follows an existing renamed category in this sub-project', () => {
  const context = setup();
  vm.runInContext(`financeState.current.lineItems.push({
    id: 'existing-audio', subprojectId: 'main',
    department: 'Audio Department', departmentCode: 'AUDIO',
    systemName: 'Sound'
  })`, context);
  context.selectedContainer = container([
    asset('Audio', 'Audio System', 4, 'Speakers'),
    asset('Lighting', 'Lighting System', 1, 'Lamp'),
  ]);

  const lines = vm.runInContext('financeAddContainerAsGroup(selectedContainer)', context);
  assert.ok(lines.every(line => line.systemName === 'Sound'));
});

test('a manually entered category still overrides the container majority', () => {
  const context = setup('Show Package');
  context.selectedContainer = container([
    asset('Audio', 'Audio System', 4, 'Speakers'),
    asset('Lighting', 'Lighting System', 1, 'Lamp'),
  ]);

  const lines = vm.runInContext('financeAddContainerAsGroup(selectedContainer)', context);
  assert.ok(lines.every(line => line.systemName === 'Show Package'));
});

test('adding a container from Browse products ignores category text left in the add row', async () => {
  const context = setup('Previous Category');
  context.selectedContainer = container([
    asset('Audio', 'Audio System', 4, 'Speakers'),
    asset('Lighting', 'Lighting System', 1, 'Lamp'),
  ]);
  context.apiCall = async () => ({ data: [context.selectedContainer] });
  context.showNotification = () => {};
  vm.runInContext(`
    financeState.rateCard = [{ isContainer: true, containerId: 'BOX-1', description: 'BOX-1' }];
    financeQueueSave = () => {};
    financeRenderEditor = () => {};
  `, context);

  await vm.runInContext('financeAddRateCardItemToQuotation(0)', context);
  const lines = vm.runInContext('financeState.current.lineItems', context);
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => line.systemName === 'Audio System'));
});

test('new quotation group adopts the first container majority unless its category was edited', () => {
  for (const [initialCategory, expectedCategory] of [
    ['Unknown', 'Audio System'],
    ['Manually Chosen', 'Manually Chosen'],
  ]) {
    const context = setup();
    context.groupCategoryInput.value = initialCategory;
    context.selectedContainer = container([
      asset('Audio', 'Audio System', 4, 'Speakers'),
      asset('Lighting', 'Lighting System', 1, 'Lamp'),
    ]);
    vm.runInContext(`
      financeLineGroupState.mode = 'finance';
      financeLineGroupState.category = 'Unknown';
      financeLineGroupState.results = [selectedContainer];
      financeLineGroupState.selected = [];
      financeLineGroupState.commercialHeader = null;
      financeRenderLineGroupSelection = () => {};
      financeAddLineGroupResult(0);
    `, context);
    assert.equal(context.groupCategoryInput.value, expectedCategory);
  }
});

test('equal asset quantities resolve to the first category consistently', () => {
  const context = setup();
  context.selectedContainer = container([
    asset('Video', 'Video System', 2, 'Screen'),
    asset('Audio', 'Audio System', 2, 'Speakers'),
  ]);

  assert.equal(vm.runInContext('financeContainerMajorityCategory(selectedContainer)', context), 'Video System');
});
