const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function setup() {
  const context = vm.createContext({
    normalizeDepartmentCode: value => value,
    normalizeCustomType: value => value,
    eventDeliveredVendorKeys: () => new Set(),
    eventCustomAssetIsDelivered: (event, asset) => !!asset.delivered,
    getCustomAssetsFromEvent: event => event.customAssets || [],
    customAssetDisplayName: custom => custom.name,
    escapeHtml: value => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    escapeHtmlAttr: value => String(value),
    getPreparedQuantity: group => Number(group?.preparedQuantity || 0),
    getExtraPreparedQuantity: group => Number(group?.extraPreparedQuantity || 0),
    eventSubprojectDragPayload: () => '',
  });
  for (const file of ['plan.js', 'prepare.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js', file), 'utf8'), context);
  }
  vm.runInContext('eventSubprojectModelGroups = () => [];', context);
  const asset = (id, quantity, name = '63A 3P cable - 30m') => ({
    id, parsedCustom: { type: 'MISC', department: 'ELEC', name, quantity },
  });
  context.fixture = {
    customAssets: [asset('prepared', 1), asset('pending', 2)],
    actuallyPrepared: ['prepared'], returnedItems: [],
    subprojects: [
      { id: 'gallery', items: [{ isCustom: true, department: 'ELEC', description: '63A 3P cable - 30m', assetRefs: ['pending'] }] },
      { id: 'rotunda', items: [{ isCustom: true, department: 'ELEC', description: '63A 3P cable - 30m', assetRefs: ['prepared'] }] },
    ],
  };
  const run = code => vm.runInContext(code, context);
  run("prepareNewPageState.event = fixture; prepareNewPageState.activeSubprojectId = 'rotunda';");
  return { context, run };
}

test('a prepared room cannot complete an event with another room pending', () => {
  const { run } = setup();
  assert.equal(run('prepareNewTotals().prepared'), 1);
  assert.equal(run('prepareNewTotals().required'), 1);
  assert.equal(run('prepareNewEventTotals().prepared'), 1);
  assert.equal(run('prepareNewEventTotals().required'), 3);
  assert.equal(run('prepareNewIsComplete()'), false);
  assert.match(run('renderPrepareNewOverallProgressCard()'), /1 \/ 3/);
  run("fixture.actuallyPrepared.push('pending')");
  assert.equal(run('prepareNewIsComplete()'), true);
});

test('grouped custom quantities count prepared members independently of ordering', () => {
  const { run } = setup();
  run('fixture.customAssets.reverse()');
  assert.equal(run('prepareNewEventTotals().prepared'), 1);
  run("fixture.returnedItems.push('pending')");
  assert.equal(run('prepareNewEventTotals().prepared'), 3);
  run('fixture.customAssets[0].delivered = true');
  assert.equal(run('prepareNewEventTotals().required'), 1);
  assert.equal(run('prepareNewEventTotals().prepared'), 1);
});

test('unlinked mismatched custom items remain visible through the all-room warning', () => {
  const { run } = setup();
  run("fixture.subprojects[0].items[0].assetRefs = []; fixture.subprojects[0].items[0].description = '63A 3P cable - 20m'; fixture.customAssets[1].parsedCustom.name += '<test>'");
  assert.equal(run('prepareNewIsComplete()'), false);
  const html = run('prepareNewUnassignedWarning()');
  assert.match(html, /Items not assigned to a room/);
  assert.match(html, /2 × 63A 3P cable - 30m&lt;test&gt;/);
  assert.match(html, /View all rooms/);
  run("fixture.subprojects[0].items[0].assetRefs = ['pending']");
  assert.equal(run('prepareNewUnassignedWarning()'), '');
});

test('rounding cannot show 100 percent while any unit is outstanding', () => {
  const { run } = setup();
  run('fixture.customAssets[0].parsedCustom.quantity = 999; fixture.customAssets[1].parsedCustom.quantity = 1');
  const html = run('renderPrepareNewOverallProgressCard()');
  assert.match(html, /pending">99%/);
  assert.equal(run('prepareNewIsComplete()'), false);
});

test('returned extras remain visible in prepare totals and model rows', () => {
  const { run } = setup();
  run(`
    fixture.customAssets = [];
    fixture.modelGroups = { speaker: {
      department: 'AX', brand: 'Test', model: 'Speaker', description: 'Speaker',
      requiredQuantity: 1, preparedQuantity: 0, preparedEverQuantity: 2,
      countablePreparedQuantity: 0, countablePreparedEverQuantity: 1,
      extraPreparedQuantity: 0, extraPreparedEverQuantity: 1,
      assignedAssets: [], isBulkQuantity: true
    } };
    eventSubprojectModelGroups = event => Object.values(event.modelGroups || {});
  `);
  assert.equal(run('prepareNewEventTotals().extra'), 1);
  assert.match(run('renderPrepareNewOverallProgressCard()'), /1 extra item prepared/);
  assert.match(run('prepareNewModelSection(fixture.modelGroups.speaker)'), /1 spare/);
});

test('completed model rows do not offer another prepare quantity action', () => {
  const { run } = setup();
  run(`
    fixture.modelGroups = { speaker: {
      department: 'AX', brand: 'Test', model: 'Speaker', description: 'Speaker',
      requiredQuantity: 1, preparedQuantity: 1, preparedEverQuantity: 1,
      countablePreparedQuantity: 1, countablePreparedEverQuantity: 1,
      assignedAssets: [], isBulkQuantity: false
    } };
    eventSubprojectModelGroups = event => Object.values(event.modelGroups || {});
  `);
  assert.doesNotMatch(
    run('prepareNewModelSection(fixture.modelGroups.speaker)'),
    />Prepare qty<\/button>/
  );
});

test('assigned assets retain their degraded badge alongside prepared or extra status', () => {
  const { run } = setup();
  run('prepareNewPageState.eventId = 42; fixture.returnedItems = []');
  const prepared = run("prepareNewAssetCard({ id: 'A#01', status: 'prepared', isDegraded: true }, { assigned: true })");
  assert.match(prepared, /prepare-new-asset-card assigned[^\"]*degraded/);
  assert.match(prepared, /prepare-new-status-degraded[^>]*>Degraded<\/span>/);
  assert.match(prepared, />Unassign<\/button>/);
  const extra = run("prepareNewAssetCard({ id: 'A#02', status: 'prepared', isDegraded: true }, { assigned: true, extra: true })");
  assert.match(extra, /prepare-new-status-degraded[^>]*>Degraded<\/span>/);
  assert.match(extra, /prepare-new-status-extra[^>]*>Extra<\/span>/);
  const direct = run("prepareNewDirectAssetCard({ id: 'A#03', status: 'packed', isDegraded: true })");
  assert.match(direct, /prepare-new-asset-card assigned degraded/);
  assert.match(direct, /prepare-new-status-degraded[^>]*>Degraded<\/span>/);
});

test('Quick-add starts off, can be enabled, and resets on entering Prepare', () => {
  const source = fs.readFileSync(path.join(__dirname, '../static/js/app.js'), 'utf8');
  const quickAddSource = source.slice(
    source.indexOf('var prepareQuickAddEnabled = false;'),
    source.indexOf('function ensurePrepareQuickAddToggleStyles()')
  );
  const context = vm.createContext({
    document: { getElementById: () => null },
    localStorage: { getItem: () => 'true' }
  });
  vm.runInContext(quickAddSource, context);
  assert.equal(vm.runInContext('getPrepareQuickAddEnabled()', context), false);
  vm.runInContext('setPrepareQuickAddEnabled(true)', context);
  assert.equal(vm.runInContext('getPrepareQuickAddEnabled()', context), true);
  assert.match(fs.readFileSync(path.join(__dirname, '../static/js/prepare.js'), 'utf8'),
    /async function loadPrepareNewPage\(\) \{[\s\S]*?setPrepareQuickAddEnabled\(false\);/);
});

test('Events uses warehouse preparation counts and retains the old-payload fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '../static/js/events-overview.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function eventOverviewProgress('),
    source.indexOf('function eventDepartmentProgress(')), context);
  const progress = context.eventOverviewProgress({ state: 'Preparing', assetCount: 395,
    preparedCount: 374, preparationCount: 374, preparationTotal: 376 });
  assert.equal(progress.done, 374);
  assert.equal(progress.total, 376);
  assert.equal(context.eventOverviewProgress({ state: 'Preparing', assetCount: 3, preparedCount: 2 }).total, 3);
  assert.equal(context.eventOverviewProgress({ state: 'Preparing', assetCount: 3, preparedCount: 2,
    preparationCount: 0, preparationTotal: 0 }).total, 0);
  const ongoing = context.eventOverviewProgress({ state: 'Ongoing', assetCount: 393,
    preparedCount: 374, preparationCount: 374, preparationTotal: 374,
    returnableCount: 383, returnableTotalCount: 383 });
  assert.deepEqual({ done: ongoing.done, total: ongoing.total, label: ongoing.label },
    { done: 374, total: 374, label: 'Prepared' });
});

test('an ongoing event shows last day as card copy instead of a separate state', () => {
  const source = fs.readFileSync(path.join(__dirname, '../static/js/events-overview.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function parseEventOverviewDate('),
    source.indexOf('function eventTagBadgeHtml(')), context);
  vm.runInContext(source.slice(source.indexOf('function eventOverviewNotice('),
    source.indexOf('function getEventPrimaryAction(')), context);

  const now = new Date();
  const endDate = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')].join('-');
  const event = { state: 'Ongoing', endDate };

  assert.equal(context.isEventLastDay(event, now), true);
  assert.equal(context.eventOverviewNotice(event, { done: 1, total: 1 }), 'In progress. Last day');
  assert.equal(context.isEventLastDay({ ...event, isLastDay: false }, now), false);
  assert.equal(event.state, 'Ongoing');
});
