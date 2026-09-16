const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/finance.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../static/css/finance.css'), 'utf8');

function setup({ linked = false, reject = false } = {}) {
  const calls = [];
  const updates = [];
  const notices = [];
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById() { return null; } },
    showbaseLineWorkspace: { createSubprojectController() { return {}; } },
    clearTimeout,
    escapeHtml: value => String(value),
    escapeHtmlAttr: value => String(value),
    showAppConfirm: async options => {
      calls.push({ confirm: options });
      return true;
    },
    apiCall: async (url, method, payload) => {
      calls.push({ url, method, payload });
      if (reject) throw new Error('Location is required');
      return {
        eventId: 42,
        data: { documentVersion: 3, status: 'draft' }
      };
    },
    registerCreatedEventInClient: async () => ({ name: 'Event', state: 'New' }),
    showNotification: (type, message) => notices.push({ type, message }),
  });
  vm.runInContext(source, context);
  context.financeUpdateListRow = row => updates.push(row);
  vm.runInContext(`financeState.documents = [{
    id: 'quote-1', projectName: 'Event', documentVersion: 2,
    status: 'draft', eventId: ${linked ? 42 : 'null'}
  }]`, context);
  return { context, calls, updates, notices };
}

test('unlinked quotation summary offers compact Link and Create actions', () => {
  const { context } = setup();
  const markup = vm.runInContext(
    'financePairedEventStatus(financeState.documents[0])', context
  );
  assert.match(markup, />Link<\/button>/);
  assert.match(markup, />Create<\/button>/);
  assert.match(markup, /financeCreateEventFromList\(event,'quote-1'\)/);
  assert.match(styles, /\.finance-event-cell-actions\s*\{[^}]*inline-flex/s);
  assert.match(source, /id="financeCreateEventButton"[^>]*>Create<\/button>/);
});

test('creating from the quotation summary links the event without changing status', async () => {
  const { context, calls, updates, notices } = setup();
  let propagationStopped = false;
  context.clickEvent = { stopPropagation() { propagationStopped = true; } };
  await vm.runInContext(
    "financeCreateEventFromList(clickEvent, 'quote-1')", context
  );
  assert.equal(propagationStopped, true);
  const request = calls.find(call => call.url);
  assert.equal(request.url, '/api/quotations/quote-1/create-event');
  assert.equal(request.method, 'POST');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].eventId, 42);
  assert.equal(updates[0].status, 'draft');
  assert.equal(notices[0].type, 'success');
});

test('linked quotations hide Create and incomplete event details show the server error', async () => {
  const linked = setup({ linked: true });
  const markup = vm.runInContext(
    'financePairedEventStatus(financeState.documents[0])', linked.context
  );
  assert.doesNotMatch(markup, />Create<\/button>/);
  await vm.runInContext(
    "financeCreateEventFromList(null, 'quote-1')", linked.context
  );
  assert.equal(linked.calls.length, 0);

  const incomplete = setup({ reject: true });
  await vm.runInContext(
    "financeCreateEventFromList(null, 'quote-1')", incomplete.context
  );
  assert.equal(incomplete.updates.length, 0);
  assert.deepEqual(incomplete.notices, [
    { type: 'error', message: 'Location is required' }
  ]);
  assert.equal(
    vm.runInContext("financeState.eventCreatingIds.has('quote-1')", incomplete.context),
    false
  );
});

test('event pairing card has concise text and adjacent linked-event actions', () => {
  assert.match(
    source,
    /<p class="finance-side-note">Pair this quotation to an existing event\.<\/p>/
  );
  assert.doesNotMatch(source, /Accepted paired quotations will not create another event/);
  assert.match(source, /finance-event-linked-actions/);
  assert.match(source, /onclick="financeUnpairEvent\(\)">Unpair event<\/button>/);
  assert.match(source, /onclick="financeGoToLinkedEventPlan\(\)"[^>]*>Go to Plan<\/button>/);
  assert.match(source, /Plan requires admin access/);
  assert.match(styles, /\.finance-event-linked-actions\s*\{[^}]*display:\s*flex/s);
});

test('Go to Plan saves quotation edits and opens its linked event for admins', async () => {
  const { context, notices } = setup({ linked: true });
  const calls = [];
  context.isAdminUser = () => true;
  context.financeFlushPendingSave = async () => {
    calls.push('save');
    return { eventId: 42 };
  };
  context.openEventPlanning = async id => calls.push(`plan:${id}`);
  await vm.runInContext('financeGoToLinkedEventPlan()', context);
  assert.deepEqual(calls, ['save', 'plan:42']);
  assert.equal(notices.length, 0);
});

test('Go to Plan does not navigate when the user lacks Plan access or the link is gone', async () => {
  const { context } = setup({ linked: true });
  let opened = false;
  context.openEventPlanning = async () => { opened = true; };
  context.isAdminUser = () => false;
  await vm.runInContext('financeGoToLinkedEventPlan()', context);
  assert.equal(opened, false);

  context.isAdminUser = () => true;
  context.financeFlushPendingSave = async () => null;
  await vm.runInContext('financeGoToLinkedEventPlan()', context);
  assert.equal(opened, false);
});
