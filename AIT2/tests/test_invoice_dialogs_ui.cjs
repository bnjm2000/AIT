const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/js/invoices.js'), 'utf8');

function setup() {
  let resolveDialog;
  const notices = [];
  const dialog = () => new Promise(resolve => { resolveDialog = resolve; });
  const context = vm.createContext({
    Date, URLSearchParams,
    document: { addEventListener() {} },
    showAppConfirm: dialog,
    showAppPrompt: dialog,
    showNotification: (...args) => notices.push(args),
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run(`
    var dirtyCount = 0, renderCount = 0;
    invoiceMarkDirty = () => { dirtyCount++; };
    invoiceRenderEditor = () => { renderCount++; };
    invoiceUpdateInstallment = (index, key, value) => {
      invoiceState.current.plan.installments[index][key] = value;
      invoiceMarkDirty();
    };
    invoiceState.current = { quotation: { id: 'q1' }, plan: {
      payments: [
        { id: 'A', label: 'First receipt', amount: 100, date: '2026-09-05', invoiceId: 'inv1' },
        { id: 'B', label: 'Second receipt', amount: 200, date: '2026-09-05', invoiceId: 'inv2' }
      ],
      installments: [
        { id: 'A', dueDate: '2026-10-01', invoiceId: '', status: 'planned' },
        { id: 'B', dueDate: '2026-10-02', invoiceId: '', status: 'planned' }
      ]
    } };
  `);
  return { run, notices, confirm: value => resolveDialog(value) };
}

test('payment removal follows the confirmed receipt after a realtime insertion', async () => {
  const { run, confirm } = setup();
  const removal = run('invoiceRemovePayment(1)');
  run("invoiceState.current.plan.payments.unshift({ id: 'C', amount: 300 });");
  confirm(true);
  await removal;
  assert.equal(run("invoiceState.current.plan.payments.map(row => row.id).join(',')"), 'C,A');
  assert.equal(run('dirtyCount'), 1);
});

for (const [field, value] of [['label', 'Revised'], ['amount', 250], ['date', '2026-09-06'], ['invoiceId', 'inv3']]) {
  test(`payment removal stops when the confirmed receipt ${field} changes`, async () => {
    const { run, confirm, notices } = setup();
    const removal = run('invoiceRemovePayment(1)');
    run(`invoiceState.current.plan.payments[1][${JSON.stringify(field)}] = ${JSON.stringify(value)};`);
    confirm(true);
    await removal;
    assert.equal(run('invoiceState.current.plan.payments.length'), 2);
    assert.equal(run('dirtyCount'), 0);
    assert.equal(notices[0][0], 'warning');
  });
}

test('payment removal does not mutate a different active quotation', async () => {
  const { run, confirm } = setup();
  const removal = run('invoiceRemovePayment(1)');
  run("invoiceState.current.quotation.id = 'q2';");
  confirm(true);
  await removal;
  assert.equal(run('invoiceState.current.plan.payments.length'), 2);
  assert.equal(run('dirtyCount'), 0);
});

test('due-date confirmation follows its installment after a realtime insertion', async () => {
  const { run, confirm } = setup();
  const edit = run('invoiceEditDueDays(1)');
  run("invoiceState.current.plan.installments.unshift({ id: 'C', dueDate: '2026-11-01' });");
  confirm('14');
  await edit;
  assert.equal(run('invoiceState.current.plan.installments[2].dueDate'), run('invoiceDateFromToday(14)'));
  assert.equal(run('invoiceState.current.plan.installments[1].dueDate'), '2026-10-01');
  assert.equal(run('dirtyCount'), 1);
});

for (const [name, change] of [
  ['due date changes', "invoiceState.current.plan.installments[1].dueDate = '2026-12-01'"],
  ['installment becomes frozen', "Object.assign(invoiceState.current.plan.installments[1], { invoiceId: 'inv2', status: 'sent' })"],
  ['installment disappears', 'invoiceState.current.plan.installments.splice(1, 1)'],
]) {
  test(`due-date confirmation stops when the ${name}`, async () => {
    const { run, confirm, notices } = setup();
    const edit = run('invoiceEditDueDays(1)');
    run(change);
    confirm('14');
    await edit;
    assert.equal(run('dirtyCount'), 0);
    assert.equal(notices[0][0], 'warning');
  });
}

test('due-date confirmation does not mutate a different active quotation', async () => {
  const { run, confirm } = setup();
  const edit = run('invoiceEditDueDays(1)');
  run("invoiceState.current.quotation.id = 'q2';");
  confirm('14');
  await edit;
  assert.equal(run('invoiceState.current.plan.installments[1].dueDate'), '2026-10-02');
  assert.equal(run('dirtyCount'), 0);
});
