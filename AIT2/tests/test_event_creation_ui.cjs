const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'static', 'js', 'app.js'),
  'utf8',
);
const start = source.indexOf('function eventCreationRequestId()');
const end = source.indexOf('// Form handlers', start);
const creationSource = source.slice(start, end);

function makeContext(apiCall) {
  const submitButton = {
    dataset: {},
    disabled: false,
    textContent: 'Create Event',
  };
  const form = {
    dataset: {},
    attributes: {},
    resetCount: 0,
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    querySelector: () => submitButton,
    reset() { this.resetCount += 1; },
  };
  const values = {
    eventName: { value: 'Launch' },
    eventLocation: { value: 'Expo' },
    eventStartDate: { value: '2026-10-01' },
    eventEndDate: { value: '2026-10-01' },
    eventTag: { value: 'events' },
    'dashboard-section': { classList: { contains: () => false } },
    'events-section': { classList: { contains: () => false } },
  };
  const context = vm.createContext({
    form,
    submitButton,
    capturedPayloads: [],
    document: { getElementById: id => values[id] },
    globalThis: {},
    addEventAssignedUsers: new Set(['alice']),
    isAdminUser: () => true,
    showNotification() {},
    apiCall: async (...args) => apiCall(context, ...args),
    registerCreatedEventInClient: async () => {},
    closeModal() {},
    loadDashboard() {},
    loadAllEvents() {},
    setAddEventTag() {},
    resetAddEventAssignees() {},
    console,
  });
  vm.runInContext(creationSource, context);
  return { context, form, submitButton, values };
}

test('double submit sends one request and shows a creating state', async () => {
  let resolveRequest;
  let callCount = 0;
  const setup = makeContext(async (context, endpoint, method, payload) => {
    callCount += 1;
    context.capturedPayloads.push({ endpoint, method, payload });
    return new Promise(resolve => { resolveRequest = resolve; });
  });

  const first = vm.runInContext('submitAddEventForm(form)', setup.context);
  const second = vm.runInContext('submitAddEventForm(form)', setup.context);

  assert.equal(callCount, 1);
  assert.equal(setup.submitButton.disabled, true);
  assert.equal(setup.submitButton.textContent, 'Creating...');
  assert.equal(setup.form.attributes['aria-busy'], 'true');
  assert.ok(setup.context.capturedPayloads[0].payload.clientRequestId);

  resolveRequest({ eventId: 7 });
  await Promise.all([first, second]);

  assert.equal(setup.submitButton.disabled, false);
  assert.equal(setup.submitButton.textContent, 'Create Event');
  assert.equal(setup.form.resetCount, 1);
});

test('an unchanged retry reuses its request ID', async () => {
  const requestIds = [];
  let attempt = 0;
  const setup = makeContext(async (_context, _endpoint, _method, payload) => {
    requestIds.push(payload.clientRequestId);
    attempt += 1;
    if (attempt === 1) throw new Error('response lost');
    return { eventId: 7, reused: true };
  });

  await vm.runInContext('submitAddEventForm(form)', setup.context);
  await vm.runInContext('submitAddEventForm(form)', setup.context);

  assert.equal(requestIds.length, 2);
  assert.equal(requestIds[0], requestIds[1]);
});
