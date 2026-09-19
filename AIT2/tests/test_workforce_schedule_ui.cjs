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

test('P&L invoice and claim review links open the department view before the dialog', () => {
  const context = setup();
  const result = vm.runInContext(`
    isAdminUser = () => true;
    resetWorkforceScheduleFilters = () => {};
    workflowRememberEvent = id => { capturedRememberedEvent = id; };
    showSection = (section, options) => {
      capturedSection = section;
      capturedSectionEvent = options.eventId;
    };
    openEventWorkforceReview(42, 'submission-7');
    ({
      eventId: workforcePageState.eventId,
      viewMode: workforcePageState.viewMode,
      focusTarget: workforcePageState.focusTarget,
      rememberedEvent: capturedRememberedEvent,
      section: capturedSection,
      sectionEvent: capturedSectionEvent,
    });
  `, context);

  assert.equal(result.eventId, 42);
  assert.equal(result.viewMode, 'assignments');
  assert.equal(result.focusTarget, 'review-claim:submission-7');
  assert.equal(result.rememberedEvent, 42);
  assert.equal(result.section, 'workforce');
  assert.equal(result.sectionEvent, 42);
});

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

test('legacy Transport claims use the Crew Transport review option and badge', () => {
  const context = setup();
  const badge = vm.runInContext("wfClaimCategoryBadge({ category: 'Transport' })", context);
  const review = vm.runInContext("wfReviewClaimCategoryFields({ category: 'Transport' }, false)", context);
  assert.match(badge, />Crew Transport<\/span>/);
  assert.match(review, /<option value="Crew Transport" selected>/);
  assert.doesNotMatch(review, /<option value="Transport"/);
  assert.match(review, /<option value="Equipment Transport"/);
  assert.doesNotMatch(review, /<option value="Parking"/);
  const orderedCategories = ['Meal', 'Crew Transport', 'Equipment Transport', 'Purchase', 'Other'];
  for (let index = 1; index < orderedCategories.length; index += 1) {
    assert.ok(review.indexOf(`>${orderedCategories[index - 1]}</option>`) < review.indexOf(`>${orderedCategories[index]}</option>`));
  }
});

test('crew and vendor submissions reuse the worker portal status and progress treatment', () => {
  const context = setup();
  const source = fs.readFileSync(path.join(__dirname, '../static/js/workforce-admin.js'), 'utf8');
  const start = source.indexOf('function wfStatusMenu(');
  const end = source.indexOf('\nfunction wfClaimTotalMarkup(', start);
  vm.runInContext(source.slice(start, end), context);

  const queued = vm.runInContext("wfStatusMenu({id:'queued', processingState:'Queued'})", context);
  assert.match(queued, /class="upload-status"/);
  assert.match(queued, /class="wf-status-button status-badge status-queued"/);
  assert.match(queued, /class="upload-progress-track processing"/);
  assert.match(queued, />Waiting</);

  const processing = vm.runInContext("wfStatusMenu({id:'processing', processingState:'Processing'})", context);
  assert.match(processing, /status-processing/);
  assert.match(processing, />Analysing</);

  const approved = vm.runInContext("wfStatusMenu({id:'approved', status:'Approved'})", context);
  assert.match(approved, /class="wf-status-button status-badge status-approved"/);
});

test('invoice due dates appear for admins with countdown and upload-age fallback', () => {
  const context = setup();
  vm.runInContext(`
    wfTodayDayNumber = () => Date.UTC(2026, 8, 19) / 86400000;
  `, context);

  const crewRow = vm.runInContext(`wfSubmissionRow({
    id:'invoice-1', originalName:'invoice.pdf', amount:250, dueDate:'2026-10-01'
  }, 'invoice')`, context);
  assert.match(crewRow, /\$250\.00/);
  assert.match(crewRow, /Due 1 October 2026/);

  const dueTiming = vm.runInContext(`wfDocumentTimingMarkup({
    dueDate:'2026-10-01', submittedAt:'2026-09-10T10:00:00+08:00'
  })`, context);
  assert.match(dueTiming, /Due 1 October 2026/);
  assert.match(dueTiming, /12 days left/);

  const ageTiming = vm.runInContext(`wfDocumentTimingMarkup({
    submittedAt:'2026-09-10T10:00:00+08:00'
  })`, context);
  assert.match(ageTiming, /9 days since uploaded/);

  const crewAge = vm.runInContext(`wfSubmissionRow({
    id:'invoice-2', originalName:'no-due-date.pdf', amount:100,
    submittedAt:'2026-09-10T10:00:00+08:00'
  }, 'invoice')`, context);
  assert.match(crewAge, /9 days since uploaded/);

  const overdueTiming = vm.runInContext(`wfDocumentTimingMarkup({
    dueDate:'2026-09-17', submittedAt:'2026-09-01T10:00:00+08:00'
  })`, context);
  assert.match(overdueTiming, /2 days overdue/);

  const review = vm.runInContext(`wfReviewExpectedAmountHtml({
    amount:250, expectedAmount:250, dueDate:'2026-10-01',
    dueDateSource:'30 days from invoice date', expectedAmountBreakdown:[]
  })`, context);
  assert.match(review, /Invoice due date/);
  assert.match(review, /1 October 2026/);
  assert.match(review, /30 days from invoice date/);
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

test('day rate arrows change the exact rate by ten dollars without losing cents', () => {
  const context = setup();
  const inserted = [];
  const input = { value: '280.25', focus() {} };
  context.document.body = { insertAdjacentHTML(_position, html) { inserted.push(html); } };
  context.document.getElementById = id => id === 'wfScheduleRateInput' ? input : null;
  context.document.querySelectorAll = () => [];
  vm.runInContext(`
    wfScheduleRows = () => [{id:'a1', subjectType:'worker', dailyRate:280.25}];
    wfScheduleSubject = () => ({name:'Crew'});
    wfScheduleDateLabel = () => '5 September 2026';
    positionWorkforceScheduleTagMenu = () => {};
  `, context);

  vm.runInContext(`openWorkforceScheduleRateEditor({
    preventDefault() {}, stopPropagation() {}, currentTarget: {}
  }, 'a1', '2026-09-05')`, context);
  assert.match(inserted[0], /id="wfScheduleRateInput"[^>]*step="0\.01"/);
  assert.match(inserted[0], /Increase rate by \$10/);
  assert.match(inserted[0], /Decrease rate by \$10/);

  vm.runInContext('adjustWorkforceScheduleRate(1)', context);
  assert.equal(input.value, '290.25');
  vm.runInContext('adjustWorkforceScheduleRate(-1)', context);
  assert.equal(input.value, '280.25');
  input.value = '5.5';
  vm.runInContext('adjustWorkforceScheduleRate(-1)', context);
  assert.equal(input.value, '0');

  input.value = '35.01';
  let prevented = false;
  context.rateKeyEvent = { key: 'ArrowUp', preventDefault() { prevented = true; } };
  vm.runInContext('handleWorkforceScheduleRateArrow(rateKeyEvent)', context);
  assert.equal(prevented, true);
  assert.equal(input.value, '45.01');
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
