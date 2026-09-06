const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/invoices.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const calls = [], timers = new Map(), nodes = {}, notices = [];
  let timerId = 0;
  const context = vm.createContext({
    URLSearchParams, Date, console,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    document: {
      activeElement: null,
      addEventListener() {},
      getElementById(id) { return nodes[id] || null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    window: { crypto: { randomUUID: () => String(++timerId) } },
    showNotification: (...args) => notices.push(args),
    showAppConfirm: async () => 'use-latest',
    apiCall: async (url, method, payload) => {
      calls.push({ url, method, payload });
      return { data: { quotation: { id: 'q1', totals: { total: 1000 } }, plan: { ...payload, documentVersion: 2 } } };
    },
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    invoiceRenderEditor = () => { renderCount++; };
    var renderCount = 0;
    invoiceState.current = {
      quotation: { id: 'q1', status: 'accepted', totals: { total: 1000, netSubtotal: 1000 }, taxRate: 0 },
      plan: { id: 'p1', documentVersion: 1, installments: [], payments: [], invoiceDetails: {} }
    };
    invoiceState.basePlan = invoiceClone(invoiceState.current.plan);
  `, context);
  const run = code => vm.runInContext(code, context);
  return { context, calls, timers, nodes, notices, run };
}

test('amount/percentage conversion preserves a discounted installment', () => {
  const { run } = setup();
  run(`invoiceState.current.plan.invoiceDiscountValue = 20;
    invoiceState.current.plan.installments = [{ id: 'i1', mode: 'amount', value: 400, amount: 400 }];
    invoiceUpdateInstallment(0, 'mode', 'percentage');`);
  assert.equal(run('invoiceState.current.plan.installments[0].value'), 50);
  assert.equal(run('invoiceLocalSummary(invoiceState.current.plan, invoiceState.current.quotation).planned'), 400);
});

test('entering a payment amount enables its receipt without a page render', () => {
  const { context, run } = setup();
  const receipt = { disabled: true };
  context.document.querySelectorAll = selector => selector.includes('receipt-button') ? [receipt] : [];
  run(`invoiceState.current.plan.payments = [{ id: 'pay1', amount: 0 }]; invoiceUpdatePayment(0, 'amount', 25);`);
  assert.equal(receipt.disabled, false);
  assert.equal(run('renderCount'), 0);
});

test('silent autosave updates saved state and leaves the editor intact', async () => {
  const { nodes, run } = setup();
  nodes.invoiceSaveState = {};
  run('invoiceMarkDirty()');
  await run('invoiceSavePlan({ silent: true })');
  assert.equal(nodes.invoiceSaveState.textContent, 'All changes saved');
  assert.equal(run('invoiceState.dirty'), false);
  assert.equal(run('renderCount'), 0);
});

test('navigation waits for an active save even when no dirty flag remains', async () => {
  const { context, run } = setup();
  const pending = deferred();
  context.pending = pending.promise;
  run('invoiceState.activeSave = pending; invoiceState.dirty = false;');
  let completed = false;
  const result = run('invoiceFlushPendingSave()').then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  pending.resolve({});
  await result;
  assert.equal(completed, true);
});

test('edits made during a save are included before navigation completes', async () => {
  const { context, run, calls } = setup();
  const pending = deferred();
  context.apiCall = async (url, method, payload) => {
    calls.push(payload);
    if (calls.length === 1) return pending.promise;
    return { data: { quotation: { id: 'q1' }, plan: { ...payload, documentVersion: 3 } } };
  };
  run("invoiceState.dirty = true; invoiceState.current.plan.strategyLabel = 'First';");
  const first = run('invoiceSavePlan({ silent: true })');
  run("invoiceUpdatePlanField('strategyLabel', 'Second')");
  const flush = run('invoiceFlushPendingSave()');
  pending.resolve({ data: { quotation: { id: 'q1' }, plan: { ...calls[0], documentVersion: 2 } } });
  await first;
  assert.equal(await flush, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].strategyLabel, 'Second');
});

test('realtime changes to another invoice never close the active editor', async () => {
  const { run } = setup();
  run('loadInvoices = () => { throw new Error("Editor was replaced"); };');
  await run("invoiceHandleRealtimeChanges([{ quotationId: 'q2' }])");
  assert.equal(run('invoiceState.current.quotation.id'), 'q1');
});

test('realtime changes preserve unsaved local values and the conflict base', async () => {
  const { context, run } = setup();
  run("invoiceState.current.plan.strategyLabel = 'My edit'; invoiceState.dirty = true;");
  context.apiCall = async () => ({ data: { quotation: { id: 'q1' }, plan: { documentVersion: 2, strategyLabel: 'Their edit' } } });
  await run("invoiceHandleRealtimeChanges([{ quotationId: 'q1' }])");
  assert.equal(run('invoiceState.current.plan.strategyLabel'), 'My edit');
  assert.equal(run('invoiceState.basePlan.documentVersion'), 1);
  assert.equal(run('renderCount'), 0);
});

test('late realtime response cannot replace a different active plan', async () => {
  const { context, run } = setup();
  const pending = deferred();
  context.apiCall = () => pending.promise;
  const refresh = run("invoiceHandleRealtimeChanges([{ quotationId: 'q1' }])");
  run("invoiceState.current.quotation.id = 'q2'");
  pending.resolve({ data: { quotation: { id: 'q1' }, plan: {} } });
  await refresh;
  assert.equal(run('invoiceState.current.quotation.id'), 'q2');
});

test('status actions prefer the current plan to stale directory data', () => {
  const { run } = setup();
  run(`invoiceState.issuedInvoices = [{ id: 'inv1', documentVersion: 1, invoiceAmount: 100 }];
    invoiceState.current.plan.installments = [{ invoiceId: 'inv1', invoiceDocumentVersion: 5, amount: 80 }];`);
  assert.equal(run("invoiceFindDocument('inv1').documentVersion"), 5);
  assert.equal(run("invoiceFindDocument('inv1').invoiceAmount"), 80);
});

test('void and zero-value invoices do not show a phantom balance', () => {
  const { run } = setup();
  assert.equal(run("invoiceIssuedAmountDue({ status: 'void', invoiceAmount: 100 })"), 0);
  assert.equal(run('invoiceIssuedAmountDue({ invoiceAmount: 0, totals: { total: 1000 } })'), 0);
});

test('a voided installment does not consume the replacement preset balance', () => {
  const { run } = setup();
  run(`invoiceState.current.plan.installments = [{ invoiceId: 'inv1', amount: 1000, status: 'void' }];
    invoiceApplyPreset('full');`);
  assert.equal(run('invoiceState.current.plan.installments.length'), 2);
  assert.equal(run('invoiceState.current.plan.installments[1].amount'), 1000);
});

test('opening a quotation waits for invoice saving and stops on failure', async () => {
  const { run } = setup();
  run(`invoiceFlushPendingSave = async () => false;
    showSection = () => { throw new Error('Navigated with unsaved invoice'); };
    financeOpenDocument = () => { throw new Error('Opened quotation too early'); };`);
  await run("invoiceOpenQuotation('q1')");
});

test('a single outstanding invoice is selected for a new manual receipt', () => {
  const { run } = setup();
  run(`invoiceState.current.plan.installments = [{ invoiceId: 'inv1', amount: 100, status: 'sent' }];
    invoiceAddPayment();`);
  assert.equal(run('invoiceState.current.plan.payments[0].invoiceId'), 'inv1');
});

test('navigation honors an unresolved in-flight save conflict', async () => {
  const { context, run } = setup();
  context.pending = Promise.resolve(null);
  run(`invoiceState.activeSave = pending; invoiceState.dirty = true;
    invoiceSavePlan = () => { throw new Error('Repeated unresolved save'); };`);
  assert.equal(await run('invoiceFlushPendingSave()'), false);
});

test('older realtime responses cannot replace a newer queued update', async () => {
  const { context, run } = setup();
  run(`invoiceState.dirty = true;
    invoiceState.pendingRealtime = { quotation: { id: 'q1' }, plan: { documentVersion: 5 } };`);
  context.apiCall = async () => ({ data: { quotation: { id: 'q1' }, plan: { documentVersion: 4 } } });
  await run("invoiceHandleRealtimeChanges([{ quotationId: 'q1' }])");
  await run('invoiceReloadCurrentPlan()');
  assert.equal(run('invoiceState.pendingRealtime.plan.documentVersion'), 5);
});

test('receipt edits update billing history without replacing the editor', () => {
  const { context, nodes, run } = setup();
  context.financeEscape = value => String(value ?? '');
  nodes.invoiceBillingHistory = { innerHTML: '' };
  run(`invoiceState.current.plan.payments = [{ id: 'pay1', date: '2026-09-05', amount: 0 }];
    invoiceUpdatePayment(0, 'amount', 125);`);
  assert.match(nodes.invoiceBillingHistory.innerHTML, /\$125\.00/);
  assert.equal(run('renderCount'), 0);
});

test('background refresh retains all loaded list pages within the API page limit', async () => {
  const { context, calls, nodes, run } = setup();
  nodes['invoices-page-root'] = { querySelector: () => ({}) };
  run(`invoiceState.current = null; invoiceState.view = 'issued';
    invoiceState.issuedInvoices = Array.from({ length: 120 }, (_, id) => ({ id }));
    invoiceLoadPlanTemplates = async () => []; invoiceRenderList = () => {};`);
  context.apiCall = async url => {
    const params = new URLSearchParams(url.split('?')[1]);
    const offset = Number(params.get('offset')), limit = Number(params.get('limit'));
    calls.push({ offset, limit });
    return { data: Array.from({ length: limit }, (_, index) => ({ id: offset + index })),
      meta: { total: 150, hasMore: true, nextOffset: offset + limit } };
  };
  await run("loadInvoices('', { preservePosition: true })");
  assert.deepEqual(calls, [{ offset: 0, limit: 100 }, { offset: 100, limit: 20 }]);
  assert.equal(run('invoiceState.issuedInvoices.length'), 120);
  assert.equal(run('invoiceState.listMeta.nextOffset'), 120);
});

test('failed list refresh retains the current search and rows', async () => {
  const { context, nodes, notices, run } = setup();
  nodes['invoices-page-root'] = { innerHTML: 'Existing list', querySelector: () => ({}) };
  run(`invoiceState.current = null; invoiceLoadPlanTemplates = async () => [];`);
  context.apiCall = async () => { throw new Error('Network unavailable'); };
  await run("loadInvoices('Existing search', { preservePosition: true })");
  assert.equal(nodes['invoices-page-root'].innerHTML, 'Existing list');
  assert.equal(notices[0][1], 'Network unavailable');
});

test('draft PDF preview waits for all pending saves', async () => {
  const { context, run } = setup();
  const pending = deferred();
  const preview = { location: { href: '' }, close() {} };
  context.window.open = () => preview;
  context.pending = pending.promise;
  run(`invoiceState.current.plan.installments = [{ invoiceId: 'inv1', status: 'draft' }];
    invoiceState.activeSave = pending; invoiceFlushPendingSave = () => pending;`);
  const opening = run("invoiceOpenPdf('inv1', 0)");
  assert.equal(preview.location.href, '');
  pending.resolve(true);
  await opening;
  assert.equal(preview.location.href, '/api/invoices/inv1/pdf');
});

test('keyboard status menu opens above a low trigger and stays inside the viewport', () => {
  const { context, nodes, run } = setup();
  const attributes = {};
  let focused = false;
  const portal = { dataset: {}, style: {}, offsetWidth: 165, offsetHeight: 200,
    classList: { add() {} }, querySelector: () => ({ focus() { focused = true; } }) };
  const trigger = { setAttribute: (key, value) => { attributes[key] = value; },
    getBoundingClientRect: () => ({ left: 330, top: 600, bottom: 630 }) };
  nodes['menu-one'] = { closest: () => ({}), previousElementSibling: trigger, cloneNode: () => portal };
  context.document.body = { appendChild() {} };
  context.showbaseViewport = { rect: rect => rect, width: () => 375, height: () => 640 };
  run("invoiceToggleStatusMenu('menu-one', { detail: 0, stopPropagation() {} })");
  assert.equal(portal.style.top, '395px');
  assert.equal(portal.style.left, '202px');
  assert.equal(portal.style.maxHeight, '200px');
  assert.equal(attributes['aria-expanded'], 'true');
  assert.equal(attributes['aria-controls'], 'menu-one-portal');
  assert.equal(focused, true);
});

test('reviewing a conflict retains the original base and local edit', async () => {
  const { context, run } = setup();
  run("invoiceState.current.plan.strategyLabel = 'Local'; invoiceMarkDirty();");
  context.apiCall = async () => {
    const error = new Error('Conflict');
    error.payload = { code: 'document_version_conflict', data: {
      quotation: { id: 'q1' }, plan: { documentVersion: 2, strategyLabel: 'Remote' }
    } };
    throw error;
  };
  context.showAppConfirm = async () => false;
  assert.equal(await run('invoiceSavePlan({ silent: true })'), null);
  assert.equal(run('invoiceState.basePlan.documentVersion'), 1);
  assert.equal(run('invoiceState.current.plan.strategyLabel'), 'Local');
  assert.equal(run('invoiceState.pendingRealtime.plan.documentVersion'), 2);
  assert.equal(run('invoiceState.dirty'), true);
});

test('successful remote merge updates visible editor fields', async () => {
  const { context, run } = setup();
  run("invoiceState.current.plan.strategyLabel = 'Local'; invoiceMarkDirty();");
  context.apiCall = async (url, method, payload) => ({ data: {
    quotation: { id: 'q1' }, plan: { ...payload, documentVersion: 2,
      invoiceDetails: { reference: 'Remote PO' } }
  } });
  await run('invoiceSavePlan({ silent: true })');
  assert.equal(run('invoiceState.current.plan.invoiceDetails.reference'), 'Remote PO');
  assert.equal(run('renderCount'), 1);
});

test('background refresh waits while an enhanced invoice dropdown is open', async () => {
  const { context, nodes, run } = setup();
  nodes['invoices-page-root'] = { querySelector: () => ({}), contains: () => false };
  context.apiCall = async () => ({ data: {
    quotation: { id: 'q1' }, plan: { documentVersion: 2 }
  } });
  await run("invoiceHandleRealtimeChanges([{ quotationId: 'q1' }])");
  assert.equal(run('invoiceState.pendingRealtime.plan.documentVersion'), 2);
  assert.equal(run('renderCount'), 0);
});

test('issuing uses the confirmed reference after a realtime plan replacement', async () => {
  const { context, calls, run } = setup();
  context.financeEscape = value => String(value ?? '');
  run(`invoiceState.current.nextInvoiceNumber = 'INV-1';
    invoiceState.current.plan.installments = [{ id: 'i1', mode: 'amount', value: 100, amount: 100 }];`);
  context.showAppForm = async () => {
    run(`invoiceAdoptPlan({ quotation: invoiceState.current.quotation,
      plan: { ...invoiceState.current.plan, documentVersion: 2, invoiceDetails: { reference: 'Remote' } } });`);
    return { invoiceNumber: 'INV-1', reference: 'Confirmed' };
  };
  context.apiCall = async (url, method, payload) => {
    calls.push({ method, payload });
    if (method === 'PUT') return { data: { quotation: { id: 'q1' }, plan: { ...payload, documentVersion: 3 } } };
    return { data: { number: 'INV-1' }, plan: {
      quotation: { id: 'q1' }, plan: { documentVersion: 4, installments: [], payments: [] }
    } };
  };
  await run('invoiceIssueInstallment(0)');
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].payload.invoiceDetails.reference, 'Confirmed');
  assert.equal(calls[1].method, 'POST');
});

test('an invoice issue response does not erase edits made while issuing', async () => {
  const { context, run } = setup();
  context.showAppForm = async () => ({ invoiceNumber: 'INV-1', reference: '' });
  run(`invoiceState.current.plan.installments = [{ id: 'i1', mode: 'amount', value: 100, amount: 100 }];`);
  context.apiCall = async () => {
    run("invoiceUpdatePlanField('strategyLabel', 'Typed while issuing')");
    return { data: { number: 'INV-1' }, plan: {
      quotation: { id: 'q1' }, plan: { documentVersion: 2 }
    } };
  };
  await run('invoiceIssueInstallment(0)');
  assert.equal(run('invoiceState.current.plan.strategyLabel'), 'Typed while issuing');
  assert.equal(run('invoiceState.pendingRealtime.plan.documentVersion'), 2);
});
