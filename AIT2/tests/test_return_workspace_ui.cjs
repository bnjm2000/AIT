const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../static/js/return.js'), 'utf8');

function workspace(overrides = {}) {
  const renders = [];
  const context = vm.createContext({
    events: [], console, clearTimeout,
    document: { getElementById: () => null },
    workflowRememberEvent() {}, updateOverdueCounter() {}, countOverdueEvents: () => 0,
    playWorkflowTone() {}, showNotification() {}, customAssetLabelFromId: id => id,
    ...overrides,
  });
  // Evaluate the entire feature, including its actual state declarations.
  vm.runInContext(source, context);
  context.renderReturnPage = () => renders.push(vm.runInContext('returnPageState.eventId', context));
  return { context, renders, run: code => vm.runInContext(code, context) };
}

test('out-of-order event responses cannot replace the latest selection', async () => {
  const requests = new Map();
  const { context, renders, run } = workspace({
    apiCall: url => new Promise(resolve => requests.set(url, resolve)),
  });
  const first = context.returnPageSelectEvent(41);
  const second = context.returnPageSelectEvent(42);
  await Promise.resolve();
  requests.get('/api/events/42?view=return')({ data: { id: 42 } });
  await second;
  requests.get('/api/events/41?view=return')({ data: { id: 41 } });
  await first;
  assert.equal(run('returnPageState.event.id'), 42);
  assert.deepEqual(renders, [42]);
});

test('return actions prevent duplicate submissions and restore controls after failure', async () => {
  const requests = [];
  let rejectRequest;
  let refreshes = 0;
  const { context, run } = workspace({
    apiCall: (...args) => {
      requests.push(args);
      return new Promise((_, reject) => { rejectRequest = reject; });
    },
  });
  context.returnPageRefreshSelected = async () => { refreshes += 1; };
  run('returnPageState.eventId = 41');
  const button = { disabled: false, isConnected: true };
  const action = context.returnPageReturnAsset(context.returnPageEncode("A'01"), button);
  await context.returnPageReturnAsset(context.returnPageEncode("A'01"), button);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], '/api/events/41/return');
  assert.equal(requests[0][2].assetId, "A'01");
  assert.equal(button.disabled, true);
  rejectRequest(new Error('conflict'));
  await action;
  assert.equal(button.disabled, false);
  assert.equal(run('returnPageState.pendingActions.size'), 0);
  assert.equal(refreshes, 1);
});

test('the scanner forwards its value to the selected Return workspace', async () => {
  const input = { value: '' };
  let scan;
  let submitted;
  const { context, run } = workspace({
    document: { getElementById: id => id === 'returnQuickAssetInput' ? input : null },
    openBarcodeScanner: options => { scan = options; },
  });
  context.scanForReturn();
  assert.equal(scan, undefined);
  run('returnPageState.eventId = 41');
  context.returnPageManualReturn = async () => { submitted = input.value; };
  context.scanForReturn();
  await scan.onScan('CASE-001');
  assert.equal(submitted, 'CASE-001');
});
