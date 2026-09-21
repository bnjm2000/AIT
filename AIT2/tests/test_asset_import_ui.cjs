const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../static/js/asset-import.js'), 'utf8');
const shell = fs.readFileSync(path.join(__dirname, '../static/js/app.js'), 'utf8');
const sharedHelpers = [...shell.matchAll(/^function (?:positionalAssetSerialList|normalizeAddAssetLookup)\([^]*?^}/gm)]
  .map(match => match[0]).join('\n');

function workspace(overrides = {}) {
  const context = vm.createContext({
    assets: [], departments: { AX: { code: 'AX', name: 'Audio' } },
    document: { getElementById: () => null }, clearTimeout,
    showNotification() {}, ...overrides,
  });
  vm.runInContext(sharedHelpers, context);
  vm.runInContext(source, context);
  vm.runInContext("assetImportState.rows = [{ brand: 'Test', model: 'Unit', department: 'AX', quantity: 1 }]", context);
  return { context, run: code => vm.runInContext(code, context) };
}

test('a late preview cannot replace the latest edited rows and signed plan', async () => {
  const requests = [];
  const { context, run } = workspace({
    apiCall: () => new Promise(resolve => requests.push(resolve)),
  });
  const first = context.refreshAssetImportPlan();
  run('assetImportState.rows[0].quantity = 2');
  const second = context.refreshAssetImportPlan();
  requests[1]({ data: { rows: [{ quantity: 2 }], planToken: 'new-plan' } });
  assert.equal(await second, true);
  requests[0]({ data: { rows: [{ quantity: 1 }], planToken: 'old-plan' } });
  assert.equal(await first, false);
  assert.equal(run('assetImportState.rows[0].quantity'), 2);
  assert.equal(run('assetImportState.planToken'), 'new-plan');
  assert.equal(run('assetImportState.planning'), false);
});

test('a stale import refreshes the review and requires another confirmation before saving', async () => {
  const submitted = [];
  const closed = [];
  let inventoryRefreshes = 0;
  const { context, run } = workspace({
    closeModal: id => closed.push(id),
    loadInventory: async () => { inventoryRefreshes += 1; },
    apiCall: async (url, method, payload) => {
      if (url.endsWith('import-plan')) {
        return { data: { rows: [], planToken: submitted.length ? 'reviewed-plan' : 'first-plan' } };
      }
      submitted.push(payload);
      if (submitted.length === 1) {
        throw { payload: { code: 'asset_import_plan_stale', data: {
          rows: [{ brand: 'Test', model: 'Unit', department: 'AX', quantity: 1, assetIdsPreview: ['NEW#02'] }],
          planToken: 'refreshed-plan', inventoryRevision: 'new-revision',
        } } };
      }
      return { data: { inventoryRecordsCreated: 1 } };
    },
  });
  await context.confirmAssetImport();
  assert.equal(submitted.length, 1);
  assert.equal(run('assetImportState.rows[0].assetIdsPreview[0]'), 'NEW#02');
  assert.equal(run('assetImportState.planToken'), 'refreshed-plan');
  assert.equal(run('assetImportState.submitting'), false);
  assert.equal(closed.length, 0);
  assert.equal(inventoryRefreshes, 0);
  await context.confirmAssetImport();
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].planToken, 'reviewed-plan');
  assert.deepEqual(closed, ['assetImportModal']);
  assert.equal(inventoryRefreshes, 1);
  assert.equal(run('assetImportState.rows.length'), 0);
});
