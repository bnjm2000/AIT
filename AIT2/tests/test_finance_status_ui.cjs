const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/finance.js'), 'utf8');

function setup() {
  const calls = [];
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById() { return null; } },
    showbaseLineWorkspace: { createSubprojectController() { return {}; } },
    clearTimeout,
    apiCall: async (url, method, payload) => {
      calls.push({ url, method, payload });
      return { data: { id: 'quote-1', revision: 1, ...payload } };
    },
    showNotification() {},
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    financeRoot = () => null;
    financeRenderEditor = () => {};
    financeState.current = { id: 'quote-1', status: 'expired', documentVersion: 4 };
    financeState.baseDocument = financeCloneDocument(financeState.current);
    financeSaveCurrent = async () => { throw new Error('Unnecessary content save'); };
  `, context);
  return { context, calls };
}

for (const status of ['accepted', 'cancelled', 'sent', 'draft']) {
  test(`expired editor changes directly to ${status} without saving content`, async () => {
    const { context, calls } = setup();
    await vm.runInContext(`financeCommitStatus('quote-1', '${status}', {})`, context);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.status, status);
    assert.equal(calls[0].payload.documentVersion, 4);
    assert.deepEqual(Object.keys(calls[0].payload).sort(), ['documentVersion', 'status']);
  });
}

test('pending content edits are saved before changing status', async () => {
  const { context, calls } = setup();
  vm.runInContext(`
    financeState.current.notes = 'Edited detail';
    financeSaveCurrent = async () => {
      financeState.current.documentVersion = 5;
      financeState.baseDocument = financeCloneDocument(financeState.current);
      return financeState.current;
    };
  `, context);
  await vm.runInContext("financeCommitStatus('quote-1', 'accepted', {})", context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.documentVersion, 5);
});

test('unresolved save conflict prevents status update', async () => {
  const { context, calls } = setup();
  vm.runInContext(`
    financeState.current.notes = 'Conflicting detail';
    financeSaveCurrent = async () => null;
  `, context);
  await vm.runInContext("financeCommitStatus('quote-1', 'accepted', {})", context);
  assert.equal(calls.length, 0);
});

test('resending an expired quote defaults to today instead of its expired sent date', async () => {
  const { context } = setup();
  vm.runInContext(`
    const inputs = {};
    document.querySelectorAll = () => [];
    document.getElementById = id => inputs[id] ||= {};
    financeEnsureSentModal = () => {};
    financeSetSentValidityUnit = () => {};
    openModal = () => {};
    financeTodayIso = () => '2026-09-04';
    financeState.current.sentAt = '2026-01-01T12:00:00';
  `, context);
  await vm.runInContext("financeRequestStatus('quote-1', 'sent', 'editor')", context);
  assert.equal(vm.runInContext('inputs.financeSentDate.value', context), '2026-09-04');
});
