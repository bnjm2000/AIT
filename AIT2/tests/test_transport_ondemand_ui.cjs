const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function setup() {
  const elements = new Map();
  const element = (id, values = {}) => {
    if (elements.has(id) && Object.keys(values).length === 0) {
      return elements.get(id);
    }
    const row = {
      id, value: '', checked: false, hidden: false, required: false,
      disabled: false, textContent: '', dataset: {},
      classList: { toggle() {} },
      ...values,
    };
    elements.set(id, row);
    return row;
  };
  const document = {
    addEventListener() {},
    createElement: () => ({ textContent: '', innerHTML: '' }),
    getElementById: id => elements.get(id) || null,
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    document,
    window: { addEventListener() {} },
    escapeHtml: value => String(value),
    FormData: class {},
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../static/js/workforce-admin.js'), 'utf8'),
    context,
  );
  return { context, element, run: code => vm.runInContext(code, context) };
}

test('profile type switches requirements from a vehicle to a provider', () => {
  const { element, run } = setup();
  [
    'wfProfileType',
    'wfProfileTypeVehicle',
    'wfProfileTypeOnDemand',
    'wfProfileVehicleType',
    'wfProfileCompany',
    'wfProfileVehicleNumberField',
    'wfProfileVehicleTypeLabel',
    'wfProfileCompanyLabel',
    'wfProfileTypeHelp',
  ].forEach(id => element(id));

  run("setTransportProfileType('on_demand')");
  assert.equal(element('wfProfileType').value, 'on_demand');
  assert.equal(element('wfProfileVehicleType').required, false);
  assert.equal(element('wfProfileCompany').required, true);
  assert.equal(element('wfProfileVehicleNumberField').hidden, true);
  assert.equal(element('wfProfileCompanyLabel').textContent, 'Provider name *');
  assert.match(element('wfProfileTypeHelp').textContent, /Lalamove or GoGoX/);
});

test('saving an on-demand provider creates one booking request per vehicle', async () => {
  const { context, element, run } = setup();
  [
    ['wfTransportTripType', { value: 'depart' }],
    ['wfOnDemandVehicleType', { value: '10ft Lorry' }],
    ['wfOnDemandQuantity', { value: '3' }],
    ['wfTransportBookingSubmit'],
    ['wfTransportSubproject', { value: 'stage' }],
    ['wfTransportDriver'],
    ['wfTransportDriverContact'],
    ['wfLocationFrom', { value: 'Warehouse' }],
    ['wfLocationFromAddress', { value: '1 Test Road' }],
    ['wfLocationTo', { value: 'Venue' }],
    ['wfLocationToAddress', { value: '2 Test Road' }],
    ['wfSaveBookingLocations', { checked: true }],
    ['wfDepartDate', { value: '2026-07-10' }],
    ['wfDepartTime', { value: '08:30' }],
    ['wfVehicleUseEndDate'],
    ['wfVehicleUseEndTime'],
    ['wfTransportCost', { value: '75' }],
  ].forEach(([id, values]) => element(id, values));

  context.requests = [];
  run(`
    workforcePageState.eventId = 143;
    workforcePageState.editingTransportId = null;
    workforcePageState.data = {
      transportBookings: [],
      transportVendors: [{id: 'lalamove', profileType: 'on_demand', company: 'Lalamove'}]
    };
    workforcePageState.transportVehicleSelections = {
      fleet: new Set(),
      external: new Set(['lalamove'])
    };
    workforcePageState.transportDriverDetails = new Map();
    apiCall = async (url, method, payload) => {
      requests.push({url, method, payload});
      return {data: workforcePageState.data};
    };
    closeWorkforceModal = () => {};
    renderWorkforcePage = () => {};
    showNotification = () => {};
    wfError = () => {};
  `);
  await vm.runInContext('saveTransportBooking({preventDefault() {}})', context);

  assert.equal(context.requests.length, 3);
  for (const request of context.requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.payload.vendorId, 'lalamove');
    assert.equal(request.payload.vehicleType, '10ft Lorry');
    assert.equal(request.payload.driver, '');
    assert.equal(request.payload.driverContact, '');
  }
});
