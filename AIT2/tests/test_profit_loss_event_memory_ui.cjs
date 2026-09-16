const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../static/js/app.js'), 'utf8');
const financeSource = fs.readFileSync(path.join(__dirname, '../static/js/finance.js'), 'utf8');
const appStart = appSource.indexOf('const WORKFLOW_EVENT_STORAGE_KEY =');
const appEnd = appSource.indexOf('\nfunction showSection(', appStart);
const financeStart = financeSource.indexOf('async function loadProfitLoss(');
const financeEnd = financeSource.indexOf('\nfunction profitLossOpenQuotation(', financeStart);
assert(appStart >= 0 && appEnd > appStart);
assert(financeStart >= 0 && financeEnd > financeStart);

function createPage() {
  const stored = new Map();
  const requests = [];
  const root = { innerHTML: '' };
  const context = vm.createContext({
    window: {
      localStorage: {
        getItem: key => stored.get(key) || null,
        setItem: (key, value) => stored.set(key, value),
      },
    },
    planPageState: { eventId: null, event: null },
    prepareNewPageState: { eventId: null, event: null },
    profitLossState: { events: [], eventId: null, data: null, loading: false },
    returnPageState: { eventId: null, event: null, loaded: false },
    ensureFinanceSections: () => {},
    profitLossRoot: () => root,
    financeLoadProgressiveEvents: async (state, preferredId) => {
      requests.push(`options:${preferredId}`);
      state.events = [{ id: 99 }, { id: 42 }];
    },
    apiCall: async url => {
      requests.push(url);
      return { data: { event: { id: Number(url.split('/').pop()) } } };
    },
    renderProfitLossPage: () => {},
    financeEscape: value => String(value),
    console,
  });
  vm.runInContext(appSource.slice(appStart, appEnd), context);
  vm.runInContext(financeSource.slice(financeStart, financeEnd), context);
  return { context, requests, stored };
}

test('P&L follows the shared event through navigation and refresh', async () => {
  const { context, requests } = createPage();
  context.workflowRememberEvent(42);
  context.workflowApplyRememberedEvent('profit-loss');
  await context.loadProfitLoss();
  assert.equal(context.profitLossState.eventId, 42);
  assert(requests.includes('/api/finance/profit-loss/42'));

  await context.selectProfitLossEvent(99);
  assert.equal(context.workflowRememberedEventId(), 99);
  context.workflowApplyRememberedEvent('plan');
  context.workflowApplyRememberedEvent('prepare-new');
  context.workflowApplyRememberedEvent('return');
  assert.equal(context.planPageState.eventId, 99);
  assert.equal(context.prepareNewPageState.eventId, 99);
  assert.equal(context.returnPageState.eventId, 99);

  context.profitLossState.eventId = null; // Simulate a browser refresh.
  context.workflowApplyRememberedEvent('profit-loss');
  await context.loadProfitLoss();
  assert.equal(context.profitLossState.eventId, 99);
  assert(requests.filter(url => url === '/api/finance/profit-loss/99').length >= 2);
});

test('P&L falls back when the remembered event is unavailable', async () => {
  const { context, requests } = createPage();
  context.workflowRememberEvent(7);
  context.workflowApplyRememberedEvent('profit-loss');
  await context.loadProfitLoss();
  assert.equal(context.profitLossState.eventId, 99);
  assert.equal(context.workflowRememberedEventId(), 99);
  assert(!requests.includes('/api/finance/profit-loss/7'));
});

test('background P&L refresh does not replace the active workflow event', async () => {
  const { context } = createPage();
  context.workflowRememberEvent(42);
  context.profitLossState.eventId = 99;
  await context.refreshProfitLossForRealtime(99);
  assert.equal(context.workflowRememberedEventId(), 42);
  context.workflowApplyRememberedEvent('profit-loss');
  assert.equal(context.profitLossState.eventId, 42);
});
