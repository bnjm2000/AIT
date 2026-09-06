const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function setup(bookings = []) {
  const root = { innerHTML: '', querySelectorAll: () => [] };
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById: id => id === 'transport-page-root' ? root : null },
    window: { addEventListener() {} },
    escapeHtml: value => String(value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/workforce-admin.js'), 'utf8'), context);
  context.fixture = {
    event: { startDate: '10/07/2026', endDate: '12/07/2026', startDateValue: '2026-07-10', endDateValue: '2026-07-12' },
    subprojects: [{ id: 'stage', name: 'Main Stage' }],
    transportBookings: bookings,
  };
  vm.runInContext(`workforcePageState.data = fixture; wfManpowerEventPickerHtml = () => '';`, context);
  return { context, root, run: code => vm.runInContext(code, context) };
}

const trip = (id, overrides = {}) => ({
  id, vehicleType: '14ft Lorry', vehicleNumber: `TEST-${id}`, sourceType: 'external',
  departDate: '2026-07-10', departTime: '09:00', cost: 150, subprojectId: 'stage',
  locationFrom: 'Warehouse', locationFromAddress: '1 Example Road',
  locationTo: 'Convention Centre', locationToAddress: '2 Example Avenue',
  driver: 'Sample Driver', driverContact: '9000 1122', ...overrides,
});

test('same-time vehicles remain separate bookings with accurate type and trip totals', () => {
  const { run, root } = setup([
    trip('van', { vehicleType: 'Passenger Van', departTime: '9:00' }),
    trip('lorry2', { vehicleType: ' 14ft   lorry ' }), trip('lorry1'),
    trip('late', { departTime: '15:00', vehicleNumber: 'TEST-lorry1' }),
  ]);
  const day = run('wfTransportSchedule(fixture.transportBookings)[0]');
  assert.equal(day.vehicleCount, 3);
  assert.equal(day.entries.length, 4);
  assert.equal(day.slots[0].time, '09:00');
  assert.equal(day.slots[0].entries.length, 3);
  assert.equal(day.types[0].count, 2);
  assert.equal(day.types[1].count, 1);
  assert.equal(day.cost, 600);
  run('renderTransportPage()');
  assert.equal((root.innerHTML.match(/data-transport-booking-id=/g) || []).length, 4);
  assert.match(root.innerHTML, /3 vehicles · 4 trips/);
});

test('date and time sorting handles older dates and puts missing or invalid dates last', () => {
  const { run } = setup([
    trip('unknown', { departDate: '' }), trip('late', { departDate: '2026-07-12' }),
    trip('early', { departDate: '20260709' }), trip('time-tbc', { departTime: '' }),
    trip('morning', { departTime: '8:30' }), trip('invalid', { departDate: '2026-02-30' }),
  ]);
  const days = run('wfTransportSchedule(fixture.transportBookings)');
  assert.deepEqual(Array.from(days, day => day.date), ['2026-07-09', '2026-07-10', '2026-07-12', '']);
  assert.equal(days[1].slots[0].time, '08:30');
  assert.equal(days[1].slots[1].time, '');
  assert.equal(days[3].entries.length, 2);
  assert.equal(run("wfTransportTimeKey('24:00')"), '');
});

test('event day labels use the API date values before, during and after the event', () => {
  const { run } = setup();
  assert.equal(run("wfTransportEventDayLabel('2026-07-09', fixture.event)"), '1 day before event');
  assert.equal(run("wfTransportEventDayLabel('2026-07-11', fixture.event)"), 'Event day 2');
  assert.equal(run("wfTransportEventDayLabel('2026-07-14', fixture.event)"), '2 days after event');
  assert.equal(run("wfTransportEventDayLabel('', fixture.event)"), '');
});

test('legacy two-way booking has one editable block, both routes, return-day entry and both trip costs', () => {
  const { run, root } = setup([trip('round-trip', {
    twoWay: true, returnDate: '2026-07-12', returnTime: '22:00',
  })]);
  const days = run('wfTransportSchedule(fixture.transportBookings)');
  assert.equal(days.length, 2);
  assert.equal(days[1].entries[0].isReturnLeg, true);
  assert.equal(days[1].cost, 150);
  run('renderTransportPage()');
  assert.equal((root.innerHTML.match(/data-transport-booking-id=/g) || []).length, 1);
  assert.equal((root.innerHTML.match(/Edit booking/g) || []).length, 1);
  assert.match(root.innerHTML, /wfFocusTransportBooking\('round-trip'\)/);
  assert.match(root.innerHTML, /\$300\.00/);
  const reverse = run("wfTransportTripCard(fixture.transportBookings[0], 'return')");
  assert.ok(reverse.indexOf('Convention Centre') < reverse.indexOf('Warehouse'));
  assert.match(reverse, /22:00/);
});

test('separate return bookings keep their own route and cost; unnamed vehicles are not collapsed by vendor', () => {
  const { run } = setup([
    trip('return1', { tripType: 'return', vehicleNumber: '', vendorId: 'type-profile' }),
    trip('return2', { tripType: 'return', vehicleNumber: '', vendorId: 'type-profile' }),
  ]);
  const day = run('wfTransportSchedule(fixture.transportBookings)[0]');
  assert.equal(day.vehicleCount, 2);
  assert.equal(day.types[0].count, 2);
  assert.equal(day.cost, 300);
  const html = run('wfTransportCard(fixture.transportBookings[0])');
  assert.ok(html.indexOf('Warehouse') < html.indexOf('Convention Centre'));
  assert.match(html, />Return<\/span>/);
});

test('booking details include single subproject, driver, phone, addresses and escaped user text', () => {
  const { run } = setup([trip('details', { vehicleType: '<Lorry>', company: 'Example & Co' })]);
  const html = run('wfTransportCard(fixture.transportBookings[0])');
  for (const value of ['Main Stage', 'Sample Driver', '+65 9000 1122', '1 Example Road', '2 Example Avenue', '$150.00']) {
    assert.ok(html.includes(value), `Missing booking detail: ${value}`);
  }
  assert.match(html, /href="tel:\+6590001122"/);
  assert.match(html, /&lt;Lorry&gt;/);
  assert.match(html, /Example &amp; Co/);
  assert.match(html, /uploadTransportInvoice\('details',this\)/);
  assert.match(html, /deleteTransportBooking\('details'\)/);
  assert.match(html, /^<details /);
  assert.doesNotMatch(html, /^<details [^>]*\bopen\b/);
  const summary = html.split('</summary>')[0];
  assert.doesNotMatch(summary, /Sample Driver|9000 1122|1 Example Road/);
  assert.match(summary, /Main Stage/);
  const fleet = run("wfTransportCard({...fixture.transportBookings[0], sourceType: 'fleet', useEndDate: '2026-07-11', useEndTime: '12:00'})");
  assert.match(fleet, /Vehicle reserved until/);
  assert.doesNotMatch(fleet, /type="file"/);
});

test('empty event offers a booking action and no misleading schedule', () => {
  const { run, root } = setup();
  run('renderTransportPage()');
  assert.match(root.innerHTML, /No transport booked yet/);
  assert.match(root.innerHTML, /onclick="openTransportBooking\(\)"/);
  assert.doesNotMatch(root.innerHTML, /class="wf-transport-day"/);
});

test('data refresh preserves expanded bookings and leaves other bookings collapsed', () => {
  const { run, root } = setup([trip('open'), trip('closed')]);
  const rendered = ['open', 'closed'].map(id => ({ dataset: { transportBookingId: id } }));
  root.querySelectorAll = selector => selector.endsWith('[open]') ? [rendered[0]] : rendered;
  run('renderTransportPage()');
  assert.equal(rendered[0].open, true);
  assert.equal(rendered[1].open, false);
});

test('return-leg link expands and focuses the matching booking', () => {
  const { run, root } = setup();
  let focused = false;
  let scrolled = false;
  const target = { dataset: { transportBookingId: 'round-trip' }, open: false,
    scrollIntoView() { scrolled = true; }, querySelector: () => ({ focus() { focused = true; } }) };
  root.querySelectorAll = () => [target];
  run("wfFocusTransportBooking('round-trip')");
  assert.equal(target.open, true);
  assert.equal(focused, true);
  assert.equal(scrolled, true);
});
