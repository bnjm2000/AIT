const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/finance.js'), 'utf8');

function setup() {
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById() { return null; } },
    showbaseLineWorkspace: { createSubprojectController() { return {}; } },
    clearTimeout() {},
    setTimeout() { return 1; },
    showNotification() {},
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    financeEscape = value => String(value == null ? '' : value);
    financeEscapeAttr = value => String(value == null ? '' : value);
    financeQueueSave = () => {};
    financeRenderEditor = () => {};
    financeRefreshEventCreationControls = () => {};
    financeState.current = {
      setupDate: '2026-10-01',
      setupTime: '09:30',
      additionalSetups: [{ id: 'setup-2', date: '2026-10-02', time: '' }]
    };
  `, context);
  return context;
}

test('primary schedule row has a clear action for its date and time', () => {
  const context = setup();
  const markup = vm.runInContext("financeSchedulePair('Set-up', 'setup')", context);

  assert.match(markup, /onclick="financeClearSchedulePair\('setup'\)"/);
  assert.match(markup, /aria-label="Clear Set-up date and time"/);

  vm.runInContext("financeClearSchedulePair('setup')", context);
  assert.equal(vm.runInContext('financeState.current.setupDate', context), '');
  assert.equal(vm.runInContext('financeState.current.setupTime', context), '');
});

test('standard schedule times can toggle TBC and return to a clock time', () => {
  const context = setup();

  vm.runInContext("financeToggleScheduleTimeTbc('setup')", context);
  assert.equal(vm.runInContext('financeState.current.setupTime', context), 'TBC');
  const selectedMarkup = vm.runInContext("financeSchedulePair('Set-up', 'setup')", context);
  assert.match(selectedMarkup, /finance-schedule-tbc selected/);
  assert.match(selectedMarkup, /aria-pressed="true"/);

  vm.runInContext("financeScheduleTimeChange('setup', '13:45')", context);
  assert.equal(vm.runInContext('financeState.current.setupTime', context), '13:45');

  vm.runInContext("financeToggleAdditionalScheduleTimeTbc('setup', 0)", context);
  assert.equal(vm.runInContext('financeState.current.additionalSetups[0].time', context), 'TBC');
  const additionalMarkup = vm.runInContext(
    "financeAdditionalSchedulePair('setup', financeState.current.additionalSetups[0], 0)",
    context,
  );
  assert.match(additionalMarkup, /finance-schedule-tbc selected/);
  assert.match(additionalMarkup, /financeToggleAdditionalScheduleTimeTbc\('setup',0\)/);
});
