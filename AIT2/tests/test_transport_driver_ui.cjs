const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function classList() {
  const names = new Set();
  return {
    add: name => names.add(name),
    remove: name => names.delete(name),
    contains: name => names.has(name),
    toggle(name, force) {
      if (force) names.add(name);
      else names.delete(name);
    },
  };
}

function setup() {
  const nodes = new Map();
  const document = {
    body: { style: {} },
    addEventListener() {},
    getElementById: id => nodes.get(id) || null,
    querySelectorAll: selector => selector === '.wf-modal.open'
      ? [...nodes.values()].filter(row => row.classList?.contains('open'))
      : [],
    querySelector: selector => document.querySelectorAll(selector)[0] || null,
  };
  const context = vm.createContext({
    document,
    window: { addEventListener() {} },
    escapeHtml: value => String(value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]),
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../static/js/workforce-admin.js'), 'utf8'),
    context,
  );
  return { context, nodes, run: source => vm.runInContext(source, context) };
}

function driverCombo(nodes, key = '') {
  const results = { innerHTML: '', classList: classList() };
  const input = {
    value: '', attributes: {}, focused: false,
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
    closest: selector => selector === '.wf-driver-combobox' ? root : null,
  };
  const phone = { value: '', dataset: { driverKey: key } };
  const row = { querySelector: selector => selector === '[data-driver-contact]' ? phone : null };
  const root = {
    dataset: { driverKey: key },
    querySelector(selector) {
      if (selector === '.wf-driver-suggestions') return results;
      if (selector === 'input[role="combobox"]') return input;
      return null;
    },
    closest: selector => selector === '.wf-booking-driver-row' ? row : null,
  };
  if (!key) nodes.set('wfTransportDriverContact', phone);
  return { root, input, phone, results };
}

test('driver suggestions use active app-user data and selection fills the phone', () => {
  const { nodes, run } = setup();
  const combo = driverCombo(nodes);
  const option = {
    dataset: { username: 'taylor' },
    closest: selector => selector === '.wf-driver-combobox' ? combo.root : null,
  };
  run(`
    workforcePageState.data = {appUsers: [
      {username: 'taylor', name: 'Taylor Fulltime', phone: '91239876'},
      {username: 'alex', name: 'Alex Driver', phone: '80001111'}
    ]};
    workforcePageState.transportVehicleSelections = {
      fleet: new Set(['van-1']), external: new Set()
    };
    workforcePageState.transportDriverDetails = new Map();
  `);
  combo.input.value = 'tay';
  run('wfShowTransportDriverSuggestions')(combo.input);
  assert.match(combo.results.innerHTML, /Taylor Fulltime/);
  assert.doesNotMatch(combo.results.innerHTML, /Alex Driver/);
  assert.equal(combo.input.attributes['aria-expanded'], 'true');

  run('wfChooseTransportDriver')(option);
  assert.equal(combo.input.value, 'Taylor Fulltime');
  assert.equal(combo.phone.value, '91239876');
  assert.equal(combo.input.attributes['aria-expanded'], 'false');
  assert.equal(run("workforcePageState.transportDriverDetails.get('fleet:van-1').contact"), '91239876');
});

test('each selected vehicle can choose a different app-user driver', () => {
  const { nodes, run } = setup();
  const key = encodeURIComponent('fleet:van-2');
  const combo = driverCombo(nodes, key);
  const option = {
    dataset: { username: 'alex' },
    closest: selector => selector === '.wf-driver-combobox' ? combo.root : null,
  };
  run(`
    workforcePageState.data = {appUsers: [
      {username: 'alex', name: 'Alex Driver', phone: '80001111'}
    ]};
    workforcePageState.transportVehicleSelections = {
      fleet: new Set(['van-1', 'van-2']), external: new Set()
    };
    workforcePageState.transportDriverDetails = new Map();
  `);
  run('wfChooseTransportDriver')(option);
  assert.equal(combo.input.value, 'Alex Driver');
  assert.equal(combo.phone.value, '80001111');
  assert.equal(run("workforcePageState.transportDriverDetails.get('fleet:van-2').driver"), 'Alex Driver');
  assert.equal(run("workforcePageState.transportDriverDetails.get('fleet:van-2').contact"), '80001111');
});

test('multi-vehicle rows each render a driver picker', () => {
  const { nodes, run } = setup();
  const rows = { innerHTML: '', hidden: true };
  const single = { hidden: false };
  nodes.set('wfBookingDrivers', rows);
  nodes.set('wfSingleDriverFields', single);
  run(`
    workforcePageState.data = {vehicles: [
      {id: 'van-1', registrationNumber: 'SGA 1111'},
      {id: 'van-2', registrationNumber: 'SGA 2222'}
    ]};
    workforcePageState.transportVehicleSelections = {
      fleet: new Set(['van-1', 'van-2']), external: new Set()
    };
    workforcePageState.transportDriverDetails = new Map();
  `);
  run('renderTransportVehicleDrivers()');
  assert.equal(rows.hidden, false);
  assert.equal(single.hidden, true);
  assert.match(rows.innerHTML, /wfTransportDriverSuggestions-0/);
  assert.match(rows.innerHTML, /wfTransportDriverSuggestions-1/);
  assert.match(rows.innerHTML, /wfTransportDriverInput\(this\)/);
});

test('transport profile opens above the booking and returns to it on close', () => {
  const { nodes, run } = setup();
  const modal = () => ({
    classList: classList(),
    style: {},
    setAttribute() {},
  });
  const booking = modal();
  const profile = modal();
  nodes.set('wfTransportBookingModal', booking);
  nodes.set('wfTransportProfileModal', profile);
  run('ensureWorkforceModals = () => {}');
  run("openWorkforceModal('wfTransportBookingModal')");
  run("openWorkforceModal('wfTransportProfileModal')");
  assert.equal(profile.style.zIndex, '2001');
  assert.equal(booking.classList.contains('open'), true);
  run("closeWorkforceModal('wfTransportProfileModal')");
  assert.equal(profile.style.zIndex, '');
  assert.equal(booking.classList.contains('open'), true);
});
