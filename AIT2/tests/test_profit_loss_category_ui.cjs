const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../static/js/finance.js'), 'utf8');
const start = source.indexOf('function profitLossExpenseChartSegments(');
const end = source.indexOf('\nfunction profitLossExpenseChartBands(', start);
assert(start >= 0 && end > start);
const context = vm.createContext({});
context.financeNumber = value => Number(value) || 0;
vm.runInContext(source.slice(start, end), context);
const bandStart = source.indexOf('function profitLossExpenseChartBands(');
const bandEnd = source.indexOf('\nfunction profitLossHighlightExpenseSlices(', bandStart);
assert(bandStart >= 0 && bandEnd > bandStart);
vm.runInContext(source.slice(bandStart, bandEnd), context);
const noteStart = source.indexOf('function profitLossOtherExpenseNote(');
const noteEnd = source.indexOf('\nfunction profitLossRenderCensored(', noteStart);
assert(noteStart >= 0 && noteEnd > noteStart);
context.financeSgd = value => `$${Number(value).toFixed(2)}`;
vm.runInContext(source.slice(noteStart, noteEnd), context);
const statusStart = source.indexOf('function profitLossExpenseProcessingMarkup(');
const statusEnd = source.indexOf('\nfunction profitLossOpenClaimReview(', statusStart);
assert(statusStart >= 0 && statusEnd > statusStart);
context.financeEscape = value => String(value ?? '');
context.financeEscapeAttr = value => String(value ?? '');
vm.runInContext(source.slice(statusStart, statusEnd), context);
const uploadStatusStart = source.indexOf('function profitLossUploadStateLabel(');
const uploadStatusEnd = source.indexOf('\nfunction profitLossPendingExpenseRowsMarkup(', uploadStatusStart);
assert(uploadStatusStart >= 0 && uploadStatusEnd > uploadStatusStart);
vm.runInContext(source.slice(uploadStatusStart, uploadStatusEnd), context);

const segments = [
  { key: 'crew-transport', group: 'crew-transport', label: 'Crew Transport' },
  { key: 'meals', group: 'meal', label: 'Meals' },
  { key: 'equipment-transport', group: 'equipment-transport', label: 'Equipment Transport' },
  { key: 'transport', group: 'transport', label: 'Transport' },
  { key: 'other-purchase', group: 'other', label: 'Purchase' },
  { key: 'other-other', group: 'other', label: 'Other' },
];

test('added expenses and claims highlight the same category slice', () => {
  for (const [categoryKey, categoryLabel, key] of [
    ['crew-transport', 'Crew Transport', 'crew-transport'],
    ['meal', 'Meal', 'meals'],
    ['equipment-transport', 'Equipment Transport', 'equipment-transport'],
    ['transport', 'Transport', 'transport'],
    ['purchase', 'Purchase', 'other-purchase'],
    ['other', 'Other', 'other-other'],
  ]) {
    for (const source of ['manual', 'worker-claim', 'transport-claim']) {
      const matches = context.profitLossExpenseChartSegments(
        { source, categoryKey, categoryLabel }, segments
      );
      assert.deepEqual(matches.map(row => row.key), [key], `${source} ${categoryLabel}`);
    }
  }
});

test('transport invoice stays linked to the Transport slice', () => {
  const matches = context.profitLossExpenseChartSegments(
    { source: 'transport-invoice', categoryKey: 'transport', categoryLabel: 'Transport' },
    segments
  );
  assert.deepEqual(matches.map(row => row.key), ['transport']);
});

test('split invoice badge sizes department colours by allocated amount', () => {
  const departmentSegments = [
    { key: 'manpower-ax', group: 'manpower', department: 'AX', colour: '#ff0000' },
    { key: 'manpower-lx', group: 'manpower', department: 'LX', colour: '#0000ff' },
  ];
  const expense = {
    source: 'worker-invoice',
    categoryKey: 'manpower',
    department: 'AX, LX',
    departmentAllocations: [
      { department: 'AX', amount: 300 },
      { department: 'LX', amount: 100 },
    ],
  };
  const bands = context.profitLossExpenseChartBands(expense, departmentSegments);
  assert.deepEqual(
    JSON.parse(JSON.stringify(bands)),
    [
      { colour: '#ff0000', amount: 300 },
      { colour: '#0000ff', amount: 100 },
    ],
  );
  assert.equal(
    context.profitLossExpenseCategoryBackground(bands),
    'linear-gradient(90deg, #ff0000 0%, #ff0000 75%, #0000ff 75%, #0000ff 100%)',
  );
});

test('split invoice badge keeps equal colour widths when allocation amounts are absent', () => {
  const bands = context.profitLossExpenseChartBands({
    source: 'worker-invoice', categoryKey: 'manpower', department: 'AX, LX',
  }, [
    { key: 'manpower-ax', group: 'manpower', department: 'AX', colour: '#ff0000' },
    { key: 'manpower-lx', group: 'manpower', department: 'LX', colour: '#0000ff' },
  ]);
  assert.equal(
    context.profitLossExpenseCategoryBackground(bands),
    'linear-gradient(90deg, #ff0000 0%, #ff0000 50%, #0000ff 50%, #0000ff 100%)',
  );
});

test('Other Expenses note names cost categories, not their submission sources', () => {
  assert.equal(context.profitLossOtherExpenseNote([
    { label: 'Purchase', amount: 30 },
    { label: 'Meal', amount: 13 },
    { label: 'Crew Transport', amount: 0 },
  ]), 'Purchase $30.00 · Meal $13.00');
  assert.equal(context.profitLossOtherExpenseNote([]), 'No other expenses');
});

test('P&L submission rows reuse worker portal badges and processing bars', () => {
  const queued = context.profitLossExpenseProcessingMarkup({
    source: 'worker-invoice', processingState: 'Queued', status: 'Pending Review',
  });
  assert.match(queued, /class="pnl-submission-status upload-status"/);
  assert.match(queued, /class="status-badge status-queued"/);
  assert.match(queued, /class="upload-progress-track processing"/);
  assert.match(queued, />Waiting</);

  const approved = context.profitLossExpenseProcessingMarkup({
    source: 'worker-claim', status: 'Approved',
  });
  assert.match(approved, /class="status-badge status-approved"/);

  const confirmed = context.profitLossExpenseProcessingMarkup({
    source: 'worker-claim', status: 'Paid', paymentConfirmedAt: '2026-09-19T10:00:00+08:00',
  });
  assert.match(confirmed, /status-payment-confirmed/);
  assert.match(confirmed, />Payment Confirmed</);

  const uploading = context.profitLossPendingExpenseStatusMarkup({
    status: 'uploading', progress: 42,
  });
  assert.match(uploading, /status-uploading/);
  assert.match(uploading, /style="width:42%"/);
  assert.match(uploading, />42%</);
});
