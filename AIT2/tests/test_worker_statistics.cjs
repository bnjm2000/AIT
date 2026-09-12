const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const context = vm.createContext({ Intl, Date });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/worker-statistics.js'), 'utf8'), context);
const stats = vm.runInContext('WorkerStatistics', context);
const year = { period: 'year', year: '2026' };
const row = (id, amount, adminStatus = 'Approved', extra = {}) => ({ id, amount, adminStatus, submittedAt: '2026-09-08T09:00:00+08:00', ...extra });
const event = (id, invoices = [], claims = [], extra = {}) => ({
  id, subjectId: 'person', subjectType: 'worker', startDate: '2026/09/01',
  submissions: { invoices, claims }, ...extra
});

test('combines companies without grouping earnings by company; keeps reimbursements separate', () => {
  const companies = [
    { code: 'A', events: [event(1, [row('i1', 150), row('i2', 200, 'Paid')], [row('c1', 22.35, 'Approved', { category: 'Meal' })])] },
    { code: 'B', events: [event(1, [row('i1', 300, 'Paid', { paymentConfirmedAt: '2026-09-10' })], [row('c1', 15.20, 'Paid', { category: 'Meal' })])] }
  ];
  const model = stats.build(companies, year);
  assert.equal(model.invoice, 65000);
  assert.equal(model.claim, 3755);
  assert.equal(model.summary.received.cents, 30000);
  assert.equal(model.summary.paid.cents, 21520);
  assert.equal(model.summary.approved.cents, 17235);
  assert.equal(model.eventCount, 2);
  assert.equal(model.buckets[8].invoice, 65000);
  assert.equal(model.categories[0].cents, 3755);
  assert.equal(model.rows.length, 5);
  assert.equal(model.companies, undefined);
});

test('review, denied, and incomplete amounts do not inflate approved earnings', () => {
  const model = stats.build([{ code: 'A', events: [event(1, [
    row('review', 100, 'Pending Review'), row('denied', 250, 'Denied'),
    row('missing', null, 'Pending Review', { needsDetails: true }),
    row('blank', '', 'Pending Review'), row('invalid', 'bad', 'Approved'),
    row('negative', -10, 'Approved'), row('decimal', 0.29), row('zero', 0)
  ])] }], year);
  assert.equal(model.invoice, 29);
  assert.equal(model.summary.review.cents, 10000);
  assert.equal(model.summary.denied.cents, 25000);
  assert.equal(model.summary.details.count, 1);
  assert.equal(model.unknownAmounts, 4);
  assert.equal(model.rows.length, 8);
});

test('uses Singapore submission dates, calendar event dates and leap-year daily buckets', () => {
  const model = stats.build([{ code: 'A', events: [event(1, [
    row('inside', 100, 'Paid', { submittedAt: '2024-02-29T15:59:59Z' }),
    row('march', 500, 'Paid', { submittedAt: '2024-02-29T16:00:00Z' }),
    row('unknown', 700, 'Paid', { submittedAt: 'not a date' })
  ], [], { startDate: '20240229' })] }], { period: 'month', month: '2024-02' });
  assert.equal(model.buckets.length, 29);
  assert.equal(model.invoice, 10000);
  assert.equal(model.eventCount, 1);
  assert.equal(model.buckets[28].events, 1);
  assert.equal(model.undatedFiles, 1);
  assert.equal(stats.dateKey('2026/02/30'), '');
  assert.equal(stats.dateKey('2026-12-31T23:00:00'), '2026-12-31');
});

test('personal totals exclude vendor records and repeated event payloads', () => {
  const personal = event(1, [row('personal', 120)]);
  const model = stats.build([{ code: 'A', events: [
    personal, personal, event(2, [row('vendor', 12000)], [], { subjectType: 'vendor' })
  ] }], year);
  assert.equal(model.invoice, 12000);
  assert.equal(model.eventCount, 1);
  assert.equal(model.rows.length, 1);
  assert.equal(model.vendorExcluded, true);
});

test('selection filters work activity independently of submission dates and retains historical years', () => {
  const companies = [{ code: 'A', events: [event(1, [row('i', 100)], [], { startDate: '2023/02/01' })] }];
  const model = stats.build(companies, year);
  assert.equal(model.eventCount, 0);
  assert.equal(model.invoice, 10000);
  assert.ok(stats.years(companies).includes(2023));
  assert.ok(stats.years(companies).includes(2026));
  assert.equal(stats.build(companies, { period: 'month', month: '' }), null);
});

test('renders readable empty data and escapes category text without exposing company names', () => {
  const root = { innerHTML: '', querySelector: () => null };
  stats.render(root, [], year);
  assert.match(root.innerHTML, /A fresh page for this period/);
  assert.doesNotMatch(root.innerHTML, /NaN|Infinity/);
  stats.render(root, [{ code: 'A', name: 'Private Company', events: [event(1, [], [
    row('c', 10, 'Approved', { category: '<img src=x onerror=alert(1)>' })
  ])] }], year);
  assert.match(root.innerHTML, /&lt;img/);
  assert.doesNotMatch(root.innerHTML, /<img|Private Company/);
  assert.match(root.innerHTML, /View exact figures/);
});

test('status details reconcile with chart counts and preserve file identity across companies', () => {
  const companies = ['A', 'B'].map(code => ({ code, name: `Company ${code}`, events: [event(1, [
    row('shared-id', 100, 'Pending Review', { originalName: `${code}.pdf`, fileUrl: `/api/worker/submissions/shared-id/file?token=${code}` }),
    row('outside', 900, 'Pending Review', { submittedAt: '2025-09-08' }),
    row('denied', 25, 'Denied', { denialReason: 'Incorrect date', fileUrl: 'javascript:alert(1)' })
  ], [row('claim', null, 'Pending Review', { needsDetails: true })], { name: 'Audio event' })] }));
  const model = stats.build(companies, year);
  for (const [state, total] of Object.entries(model.summary)) {
    const matching = model.rows.filter(row => row.state === state);
    assert.equal(matching.length, total.count);
    assert.equal(matching.reduce((sum, row) => sum + row.cents, 0), total.cents);
  }
  const matching = model.rows.filter(row => row.state === 'review');
  assert.equal(matching.length, 2);
  assert.equal(matching[0].companyName, 'Company A');
  assert.equal(matching[1].filename, 'B.pdf');
  assert.equal(matching[1].fileUrl, '/api/worker/submissions/shared-id/file?token=B');
  assert.equal(matching[1].eventName, 'Audio event');
  assert.equal(model.rows.find(row => row.state === 'denied').denialReason, 'Incorrect date');
  assert.equal(model.rows.find(row => row.state === 'denied').fileUrl, '');
  assert.equal(model.rows.find(row => row.state === 'details').known, false);
});
