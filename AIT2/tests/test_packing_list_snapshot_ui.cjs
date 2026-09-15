const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function setup() {
  const context = vm.createContext({
    parseCustomAsset: () => null,
    normalizeDepartmentCode: value => value,
    inventoryDepartmentLabel: value => value,
    modelGroupSortName: group => `${group.brand} ${group.model}`,
    customAssetDisplayName: custom => custom?.name || '',
    customAssetDetailText: () => '',
    escapeHtml: value => String(value),
    pdfInlineBadgeHtml: label => `<span>${label}</span>`,
    eventSubprojectModelGroups: event => Object.values(event.modelGroups || {}),
    eventSubprojectGroupKey: value => [
      value.departmentCode || value.department || 'UN',
      value.brand || '',
      value.model || '',
      value.description || ''
    ].join('|')
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../static/js/packing-list.js'), 'utf8'),
    context
  );
  return code => vm.runInContext(code, context);
}

test('packing-list snapshot keeps a returned extra in historical export totals', () => {
  const run = setup();
  run(`fixture = {
    totalAssets: 1, totalPrepared: 1, totalReturned: 1,
    totalExtraAssets: 0, totalExtraPrepared: 1,
    actuallyPrepared: [], returnedItems: ['A-001', 'A-002'], extraAssets: ['A-002'],
    assetsByDepartment: { AX: [
      { id: 'A-001', brand: 'Test', model: 'Speaker', description: 'Speaker', department: 'AX', status: 'returned', isDegraded: true },
      { id: 'A-002', brand: 'Test', model: 'Speaker', description: 'Speaker', department: 'AX', status: 'returned', isExtra: true }
    ] },
    modelGroups: { speaker: {
      department: 'AX', brand: 'Test', model: 'Speaker', description: 'Speaker',
      requiredQuantity: 1, preparedEverQuantity: 2, countablePreparedQuantity: 0,
      countableReturnedQuantity: 1, countablePreparedEverQuantity: 1,
      extraPreparedQuantity: 0, extraPreparedEverQuantity: 1,
      assignedAssets: [
        { id: 'A-001', status: 'returned', isDegraded: true },
        { id: 'A-002', status: 'returned', isExtra: true }
      ]
    } },
    preparedItems: []
  }; snapshot = buildPackingListSnapshot(fixture);`);

  assert.equal(run('snapshot.totals.prepared'), 1);
  assert.equal(run('snapshot.totals.extras'), 1);
  assert.equal(run('snapshot.rows[0].extraPrepared'), 1);
  assert.equal(run('snapshot.rows[0].assets[0].isDegraded'), true);
  assert.equal(run('snapshot.extras[0].status'), 'returned');
  assert.match(run('packingListTableHead()'), />Extra</);
  assert.match(run("packingListModelRowHtml(snapshot.rows[0], '')"), />1<\/td>/);
});
