const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function setup() {
  const context = vm.createContext({
    document: { addEventListener() {} }, window: { addEventListener() {} },
  });
  for (const file of ['workforce-admin.js', 'workforce-schedule.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js', file), 'utf8'), context);
  }
  vm.runInContext(`
    workforcePageState.data = { departments: [{code:'AU', name:'Audio'}], assignments: [] };
    wfEscape = value => String(value ?? '');
    wfStatusMenu = () => '';
  `, context);
  return context;
}

test('department claims display category and date in chronological order, missing dates last', () => {
  const context = setup();
  const html = vm.runInContext(`wfSubmissionRowsMarkup([
    {id:'late', originalName:'Late receipt', claimDate:'2026-09-05', category:'Transport'},
    {id:'unknown', originalName:'Unknown receipt', category:'Meals'},
    {id:'early', originalName:'Early receipt', claimDate:'2026-09-02', category:'Meals'}
  ], 'worker', 'claim', '')`, context);
  assert.ok(html.indexOf('Early receipt') < html.indexOf('Late receipt'));
  assert.ok(html.indexOf('Late receipt') < html.indexOf('Unknown receipt'));
  assert.doesNotMatch(html, /Claim date:/);
  assert.match(html, /2 September 2026/);
  assert.match(html, /Meals/);
  assert.match(html, /Transport/);
  assert.match(html, /Not provided/);
});

test('schedule rates are clickable for the specific assignment date and show full department name', () => {
  const context = setup();
  vm.runInContext(`
    workforceScheduleState.showRates = true;
    wfScheduleSubject = () => ({name:'Crew', id:'worker'});
    wfConflictTooltipText = () => '';
    wfScheduleRoomSelectHtml = () => '';
  `, context);
  const html = vm.runInContext(`wfScheduleStaffCard({id:'a1', department:'AU', dailyRate:280, roleName:'Engineer'}, '2026-09-05')`, context);
  assert.match(html, /openWorkforceScheduleRateEditor\(event,'a1','2026-09-05'\)/);
  assert.match(html, />Audio<\/button>/);
  assert.match(html, /280\.00/);
});

test('Transport category appears automatically only when the event has bookings', () => {
  const context = setup();
  assert.equal(vm.runInContext('wfCrewTransportCategoryHtml()', context), '');
  vm.runInContext(`
    workforcePageState.data.transportCompanies = [{company:'Example Transport', cost:1250, estimatedCost:1250,
      bookings:[{id:'trip1', departDate:'2026-09-05'}, {id:'trip2', departDate:'2026-09-06'}]}];
    workforcePageState.data.totals = {transport:1250};
    wfRoomBadge = () => '';
  `, context);
  const html = vm.runInContext('wfCrewTransportCategoryHtml()', context);
  assert.match(html, /Transport/);
  assert.match(html, /trip1/);
  assert.match(html, /1,250\.00/);
  assert.equal((html.match(/class="wf-worker wf-vendor wf-transport-company"/g) || []).length, 1);
  assert.equal((html.match(/type="file"/g) || []).length, 1);
  assert.match(html, /openWorkforceTransportBooking\('trip2'\)/);
});
