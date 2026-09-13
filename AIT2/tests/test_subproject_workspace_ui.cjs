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
const financeCss = fs.readFileSync(
  path.join(__dirname, '../static/css/finance.css'), 'utf8'
);
const costingSource = fs.readFileSync(
  path.join(__dirname, '../static/js/costing.js'), 'utf8'
);

function setup() {
  const notices = [];
  const queuedSaves = [];
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
    queuedSaves,
    CSS: { escape: value => String(value) },
    clearTimeout,
    setTimeout,
    showbaseViewport: {
      toLayout: value => value,
      width: () => 1200,
      height: () => 800,
    },
    escapeHtml: value => String(value),
    escapeHtmlAttr: value => String(value),
    showNotification(type, message) { notices.push({ type, message }); },
  });
  context.window = context;
  vm.runInContext(sharedSource, context);
  vm.runInContext(financeSource, context);
  vm.runInContext(costingSource, context);
  vm.runInContext(`
    financeQueueSave = options => {
      queuedSaves.push(options || {});
      financeSynchroniseLinkedSubprojects(
        financeState.current,
        options?.sourceSubprojectId || financeCurrentSubprojectId(financeState.current)
      );
    };
    financeRenderEditor = () => {};
    costingQueueSave = () => {};
    costingRenderEditor = () => {};
    costingEqualiseSaleGroups = () => {};
  `, context);
  return { context, notices, queuedSaves };
}

function value(context, expression) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));
}

test('sub-project tabs expose context actions and item drop targets', () => {
  const { context } = setup();
  const markup = vm.runInContext(`showbaseLineWorkspace.subprojectTabsMarkup({
    rows: [
      { id: 'main', name: 'Main Room', linkedGroupId: 'linked-1' },
      { id: 'side', name: 'Side Room', linkedGroupId: 'linked-1' }
    ],
    activeId: 'main',
    allowItemDrop: true,
    showLinkedStatus: true,
    handlerPrefix: 'finance'
  })`, context);
  assert.match(markup, /financeOpenSubprojectContextMenu\(event,'main'\)/);
  assert.match(markup, /financeSubprojectDrop\(event,'side'\)/);
  assert.match(markup, /Drop items here or right-click for sub-project actions/);
  assert.match(markup, /finance-subproject-tab active is-linked/);
  assert.match(markup, /Linked with Side Room/);
  assert.match(markup, /> Linked<\/span>/);
});

test('quotation sub-project tabs scroll inside the page without a visible scrollbar', () => {
  assert.match(financeCss, /\.finance-editor-layout\s*\{[^}]*max-width:\s*100%/s);
  assert.match(financeCss, /\.finance-lines-card\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
  assert.match(financeCss, /\.finance-subproject-tabs\s*\{[^}]*width:\s*100%[^}]*overflow-x:\s*auto[^}]*scrollbar-width:\s*none/s);
  assert.match(financeCss, /\.finance-subproject-tabs::\-webkit-scrollbar\s*\{[^}]*display:\s*none/s);
});

test('quotation sub-project duplication remaps room-owned records', () => {
  const { context, queuedSaves } = setup();
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
  assert.equal(document.subprojects[0].linkedGroupId, clone.linkedGroupId);
  assert.equal(clonedLines.length, 2);
  assert.notEqual(clonedLines[0].id, 'line-a');
  assert.equal(
    clonedLines[0].linkedItemId,
    document.lineItems.find(line => line.id === 'line-a').linkedItemId
  );
  assert.equal(clonedLines[0].groupId, clonedLines[1].groupId);
  assert.notEqual(clonedLines[0].groupId, 'group-a');
  assert.equal(clonedHeader.beforeLineId, clonedLines[0].id);
  assert.equal(document.adjustments.filter(row => row.subprojectId === clone.id).length, 1);
  assert.equal(document.adjustments.filter(row => row.scope === 'total').length, 1);
  assert.equal(queuedSaves.at(-1).immediate, true);
});

test('quotation sub-project links merge unique content, mirror edits, and can unlink one room', () => {
  const { context, queuedSaves } = setup();
  vm.runInContext(`
    financeState.current = {
      subprojects: [
        { id: 'main', name: 'Ballroom' },
        { id: 'side', name: 'Side Room' },
        { id: 'foyer', name: 'Foyer' }
      ],
      lineItems: [
        { id: 'shared-main', subprojectId: 'main', description: 'Speaker', department: 'Audio', systemName: 'Audio', days: 1, quantity: 1, unitPrice: 10 },
        { id: 'main-only', subprojectId: 'main', description: 'Console', department: 'Audio', systemName: 'Audio', days: 1, quantity: 1, unitPrice: 20 },
        { id: 'shared-side', subprojectId: 'side', description: 'Speaker', department: 'Audio', systemName: 'Audio', days: 1, quantity: 2, unitPrice: 15 },
        { id: 'side-only', subprojectId: 'side', description: 'Microphone', department: 'Audio', systemName: 'Audio', days: 1, quantity: 1, unitPrice: 5 },
        { id: 'foyer-only', subprojectId: 'foyer', description: 'Projector', department: 'Video', systemName: 'Video', days: 1, quantity: 1, unitPrice: 30 }
      ],
      headerRows: [
        { id: 'main-header', content: 'Main package', subprojectId: 'main', beforeLineId: 'shared-main' },
        { id: 'side-header', content: 'Speech package', subprojectId: 'side', beforeLineId: 'side-only' }
      ],
      adjustments: [
        { id: 'main-adjustment', scope: 'department', department: 'Audio', label: 'Main discount', subprojectId: 'main', amount: -5 },
        { id: 'side-adjustment', scope: 'department', department: 'Audio', label: 'Speech discount', subprojectId: 'side', amount: -2 }
      ]
    };
    financeState.activeSubprojectId = 'main';
  `, context);

  assert.match(
    vm.runInContext("financeSubprojectContextMenuMarkup('main')", context),
    /Link with Side Room/
  );
  assert.equal(vm.runInContext("financeLinkSubprojects('main', 'side')", context), true);
  assert.equal(queuedSaves.at(-1).immediate, true);
  assert.equal(vm.runInContext("financeLinkSubprojects('main', 'foyer')", context), true);

  let document = value(context, 'financeState.current');
  assert.equal(new Set(document.subprojects.map(row => row.linkedGroupId)).size, 1);
  for (const room of document.subprojects) {
    const descriptions = document.lineItems
      .filter(line => line.subprojectId === room.id)
      .map(line => line.description);
    assert.deepEqual(descriptions, ['Speaker', 'Console', 'Microphone', 'Projector']);
  }
  assert.equal(document.lineItems.find(line => line.id === 'shared-side').quantity, 1);
  assert.equal(document.lineItems.find(line => line.id === 'side-only').description, 'Microphone');
  assert.equal(document.headerRows.filter(row => row.subprojectId === 'main').length, 2);
  assert.equal(document.headerRows.filter(row => row.subprojectId === 'side').length, 2);
  assert.equal(document.adjustments.filter(row => row.subprojectId === 'foyer').length, 2);
  assert.match(
    vm.runInContext("financeSubprojectContextMenuMarkup('main')", context),
    /Unlink this sub-project/
  );

  vm.runInContext(`
    const mainConsoleIndex = financeState.current.lineItems.findIndex(
      line => line.subprojectId === 'main' && line.description === 'Console'
    );
    financeLineChange(mainConsoleIndex, 'quantity', '4');
  `, context);
  document = value(context, 'financeState.current');
  assert.equal(
    document.lineItems.find(line => line.subprojectId === 'side' && line.description === 'Console').quantity,
    4
  );
  assert.equal(
    document.lineItems.find(line => line.subprojectId === 'foyer' && line.description === 'Console').quantity,
    4
  );

  assert.equal(vm.runInContext("financeUnlinkSubproject('side')", context), true);
  assert.equal(queuedSaves.at(-1).immediate, true);
  vm.runInContext(`
    financeState.activeSubprojectId = 'main';
    const mainConsoleIndexAfterUnlink = financeState.current.lineItems.findIndex(
      line => line.subprojectId === 'main' && line.description === 'Console'
    );
    financeLineChange(mainConsoleIndexAfterUnlink, 'quantity', '6');
  `, context);
  document = value(context, 'financeState.current');
  assert.equal(document.subprojects.find(row => row.id === 'side').linkedGroupId, undefined);
  assert.equal(document.subprojects.find(row => row.id === 'main').linkedGroupId,
    document.subprojects.find(row => row.id === 'foyer').linkedGroupId);
  assert.equal(
    document.lineItems.find(line => line.subprojectId === 'foyer' && line.description === 'Console').quantity,
    6
  );
  assert.equal(
    document.lineItems.find(line => line.subprojectId === 'side' && line.description === 'Console').quantity,
    4
  );
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
