const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const sharedSource = fs.readFileSync(
  path.join(__dirname, '../static/js/line-workspace.js'), 'utf8'
);
const financeSource = fs.readFileSync(
  path.join(__dirname, '../static/js/finance.js'), 'utf8'
);
const costingSource = fs.readFileSync(
  path.join(__dirname, '../static/js/costing.js'), 'utf8'
);

function setup() {
  const notices = [];
  const document = {
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() {
      return {
        classList: { add() {}, remove() {} },
        setAttribute() {},
        querySelector() { return null; },
        style: {},
      };
    },
    body: { appendChild() {} },
  };
  const context = vm.createContext({
    document,
    CSS: { escape: value => String(value) },
    clearTimeout,
    setTimeout,
    showbaseViewport: {
      toLayout: value => value,
      width: () => 1200,
      height: () => 800,
    },
    showNotification(type, message) { notices.push({ type, message }); },
  });
  context.window = context;
  vm.runInContext(sharedSource, context);
  vm.runInContext(financeSource, context);
  vm.runInContext(costingSource, context);
  vm.runInContext(`
    financeQueueSave = () => {};
    financeRenderEditor = () => {};
    costingQueueSave = () => {};
    costingRenderEditor = () => {};
    costingEqualiseSaleGroups = () => {};
  `, context);
  return { context, notices };
}

function value(context, expression) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));
}

test('sub-project tabs expose context actions and item drop targets', () => {
  const { context } = setup();
  const markup = vm.runInContext(`showbaseLineWorkspace.subprojectTabsMarkup({
    rows: [{ id: 'main', name: 'Main Room' }, { id: 'side', name: 'Side Room' }],
    activeId: 'main',
    allowItemDrop: true,
    handlerPrefix: 'finance'
  })`, context);
  assert.match(markup, /financeOpenSubprojectContextMenu\(event,'main'\)/);
  assert.match(markup, /financeSubprojectDrop\(event,'side'\)/);
  assert.match(markup, /Drop items here or right-click for sub-project actions/);
});

test('quotation sub-project duplication remaps room-owned records', () => {
  const { context } = setup();
  vm.runInContext(`
    financeState.current = {
      subprojects: [{ id: 'main', name: 'Ballroom' }, { id: 'side', name: 'Side Room' }],
      lineItems: [
        { id: 'line-a', subprojectId: 'main', groupId: 'group-a', groupLeader: true, department: 'Audio', systemName: 'Audio', days: 1, quantity: 1, unitPrice: 10 },
        { id: 'line-b', subprojectId: 'main', groupId: 'group-a', department: 'Audio', systemName: 'Audio', days: 1, quantity: 1, unitPrice: 0 },
        { id: 'line-side', subprojectId: 'side', department: 'Lighting', systemName: 'Lighting' }
      ],
      headerRows: [{ id: 'header-a', content: 'Package', subprojectId: 'main', beforeLineId: 'line-a' }],
      adjustments: [
        { id: 'adjust-a', scope: 'department', department: 'Audio', subprojectId: 'main', amount: -5 },
        { id: 'adjust-total', scope: 'total', amount: -10 }
      ]
    };
    financeState.activeSubprojectId = 'main';
    financeDuplicateSubproject('main');
  `, context);
  const document = value(context, 'financeState.current');
  const clone = document.subprojects[1];
  const clonedLines = document.lineItems.filter(line => line.subprojectId === clone.id);
  const clonedHeader = document.headerRows.find(row => row.subprojectId === clone.id);
  assert.equal(clone.name, 'Ballroom Copy');
  assert.equal(clonedLines.length, 2);
  assert.notEqual(clonedLines[0].id, 'line-a');
  assert.equal(clonedLines[0].groupId, clonedLines[1].groupId);
  assert.notEqual(clonedLines[0].groupId, 'group-a');
  assert.equal(clonedHeader.beforeLineId, clonedLines[0].id);
  assert.equal(document.adjustments.filter(row => row.subprojectId === clone.id).length, 1);
  assert.equal(document.adjustments.filter(row => row.scope === 'total').length, 1);
});

test('quotation lines can move to another sub-project as a whole group', () => {
  const { context } = setup();
  vm.runInContext(`
    financeState.current = {
      subprojects: [{ id: 'main', name: 'Main' }, { id: 'side', name: 'Side' }],
      lineItems: [
        { id: 'a', subprojectId: 'main', groupId: 'group-a', groupLeader: true, department: 'Audio', systemName: 'Audio' },
        { id: 'b', subprojectId: 'main', groupId: 'group-a', department: 'Audio', systemName: 'Audio' },
        { id: 'c', subprojectId: 'side', department: 'Lighting', systemName: 'Lighting' }
      ],
      headerRows: [],
      adjustments: []
    };
    financeState.activeSubprojectId = 'main';
    financeState.dragWholeLineGroup = true;
    financeState.dragLineIndexes = [0, 1];
    financeMoveLinesToSubproject([0, 1], 'side');
  `, context);
  const moved = value(context, "financeState.current.lineItems.filter(line => ['a', 'b'].includes(line.id))");
  assert.ok(moved.every(line => line.subprojectId === 'side'));
  assert.ok(moved.every(line => line.groupId === 'group-a'));
  assert.equal(vm.runInContext('financeState.activeSubprojectId', context), 'side');
});

test('costing sub-project duplication and cross-room move preserve costing data', () => {
  const { context } = setup();
  vm.runInContext(`
    costingState.current = {
      status: 'draft',
      subprojects: [{ id: 'main', name: 'Ballroom' }, { id: 'side', name: 'Side' }],
      lineItems: [
        { id: 'cost-a', quotationLineId: 'quote-a', subprojectId: 'main', groupId: 'group-cost', groupLeader: true, category: 'Audio', itemCost: 25 },
        { id: 'cost-b', quotationLineId: 'quote-b', subprojectId: 'main', groupId: 'group-cost', category: 'Audio', itemCost: 15 },
        { id: 'cost-side', subprojectId: 'side', category: 'Lighting', itemCost: 5 }
      ],
      categoryAdjustments: [{ category: 'Audio', subprojectId: 'main', amount: -3 }]
    };
    costingState.activeSubprojectId = 'main';
    costingDuplicateSubproject('main');
  `, context);
  let document = value(context, 'costingState.current');
  const clone = document.subprojects[1];
  const clonedLines = document.lineItems.filter(line => line.subprojectId === clone.id);
  assert.equal(clone.name, 'Ballroom Copy');
  assert.equal(clonedLines.length, 2);
  assert.ok(clonedLines.every(line => line.quotationLineId === ''));
  assert.equal(clonedLines[0].groupId, clonedLines[1].groupId);
  assert.notEqual(clonedLines[0].groupId, 'group-cost');
  assert.equal(document.categoryAdjustments.filter(row => row.subprojectId === clone.id).length, 1);

  vm.runInContext(`
    const cloneRoomId = costingState.current.subprojects[1].id;
    const sourceIndex = costingState.current.lineItems.findIndex(line => line.id === 'cost-side');
    costingState.dragLineIndexes = [sourceIndex];
    costingMoveLinesToSubproject([sourceIndex], cloneRoomId);
  `, context);
  document = value(context, 'costingState.current');
  assert.equal(
    document.lineItems.find(line => line.id === 'cost-side').subprojectId,
    clone.id
  );
  assert.equal(vm.runInContext('costingState.activeSubprojectId', context), clone.id);
});
