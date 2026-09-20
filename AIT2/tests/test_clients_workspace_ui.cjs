const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../static/js/clients.js'), 'utf8');

function workspace(overrides = {}) {
  const root = { innerHTML: '' };
  const context = vm.createContext({
    document: { getElementById: id => id === 'clients-page-root' ? root : null },
    financeState: {}, invoiceState: {}, showNotification() {},
    ...overrides,
  });
  vm.runInContext(source, context);
  context.clientDirectoryRender = () => {};
  return { context, run: code => vm.runInContext(code, context) };
}

test('loading clients refreshes independent document caches and filtered edits keep their row identity', async () => {
  const rows = [{ name: 'First', company: 'One' }, { name: 'Second', company: 'Two' }];
  const { context, run } = workspace({ apiCall: async () => ({ data: rows }) });
  await context.loadClientsPage();
  context.clientDirectorySetQuery('two');
  const filtered = context.clientDirectoryFilteredRows();
  assert.equal(filtered.length, 1);
  context.clientDirectoryStartEdit(filtered[0].index);
  assert.equal(run('clientDirectoryState.editingName'), 'Second');
  run("clientDirectoryState.draft.company = 'Draft'");
  assert.equal(rows[1].company, 'Two');
  context.financeState.clients[1].company = 'Quotation';
  assert.equal(context.invoiceState.clients[1].company, 'Two');
  assert.equal(rows[1].company, 'Two');
});

test('renaming uses the original client URL, blocks repeat saves, and refreshes both document caches', async () => {
  const calls = [];
  const renamed = { name: 'New Name', company: 'Updated' };
  let finishSave;
  const { context, run } = workspace({
    FormData: class { entries() { return Object.entries(renamed); } },
    apiCall: (url, method, payload) => {
      calls.push({ url, method, payload });
      return method === 'PUT'
        ? new Promise(resolve => { finishSave = resolve; })
        : Promise.resolve({ data: [renamed] });
    },
  });
  run("clientDirectoryState.editingName = 'Old & Name'");
  const event = { preventDefault() {}, currentTarget: { reportValidity: () => true } };
  const saving = context.clientDirectorySave(event);
  await context.clientDirectorySave(event);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/clients/Old%20%26%20Name');
  assert.equal(calls[0].payload.name, 'New Name');
  finishSave({ data: renamed });
  await saving;
  assert.equal(calls[1].url, '/api/clients');
  assert.equal(run('clientDirectoryState.editingName'), 'New Name');
  assert.equal(run('clientDirectoryState.saving'), false);
  assert.equal(context.financeState.clients[0].name, 'New Name');
  assert.equal(context.invoiceState.clients[0].name, 'New Name');
});
