const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('static/js/finance.js', 'utf8');
const mainSearch = source.slice(
  source.indexOf('function financeRunCatalogSearch('),
  source.indexOf('function financeCatalogMatchesQuery(')
);
const groupSearch = source.slice(
  source.indexOf('function financeRunLineGroupCatalogSearch('),
  source.indexOf('function financeLineGroupResultKey(')
);

async function checkLatestOnly(code, stateName, searchName, queryField) {
  const timers = new Map();
  const requests = [];
  let nextTimer = 0;
  let renders = 0;
  const state = stateName === 'financeState'
    ? {
        catalogTimer: null, catalogRequestSeq: 0, catalogCache: {},
        catalogAbortController: null, catalogInFlight: false,
        catalogQueuedSearch: null, catalog: [], catalogQuery: ''
      }
    : {
        searchTimer: null, searchRequestSeq: 0,
        searchAbortController: null, searchInFlight: false,
        queuedSearch: null, results: []
      };
  const sandbox = {
    [stateName]: state,
    AbortController,
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    fetch: url => new Promise(resolve => requests.push({ url, resolve })),
    document: {
      getElementById: () => ({
        innerHTML: '', classList: { add() {}, remove() {}, toggle() {} }
      })
    },
    financeRenderCatalog: () => { renders += 1; },
    financeRenderLineGroupResults: () => { renders += 1; },
    financeGroupEquivalentContainers: rows => rows,
    financeSortCatalogSuggestions: rows => rows,
    financeCatalogMatchesQuery: () => true
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const search = sandbox[searchName];
  const runDebounce = () => {
    const [id, timer] = [...timers].find(([, value]) => value.delay === 300);
    assert.ok(timer, 'search should wait for a typing pause');
    timers.delete(id);
    timer.callback();
  };
  const finish = async (index, query) => {
    requests[index].resolve({
      ok: true,
      json: async () => ({ data: [{ description: query }] })
    });
    await new Promise(setImmediate);
  };

  search('sp');
  runDebounce();
  assert.equal(requests.length, 1);
  search('spi');
  runDebounce();
  search('spiider');
  runDebounce();
  assert.equal(requests.length, 1, 'only one request may be active');
  assert.equal(
    state[queryField][queryField === 'catalogQueuedSearch' ? 'clean' : 'query'],
    'spiider'
  );
  await finish(0, 'stale');
  assert.equal(requests.length, 2, 'only the newest pending query is sent');
  assert.match(requests[1].url, /query=spiider/);
  assert.equal(renders, 0, 'stale results must not be displayed');
  await finish(1, 'spiider');
  assert.equal(renders, 1);
  assert.equal(
    (state.catalog || state.results)[0].description,
    'spiider', JSON.stringify(state.catalog || state.results)
  );
}

(async () => {
  await checkLatestOnly(
    mainSearch, 'financeState', 'financeSearchCatalog',
    'catalogQueuedSearch'
  );
  await checkLatestOnly(
    groupSearch, 'financeLineGroupState',
    'financeSearchLineGroupCatalog', 'queuedSearch'
  );
  process.stdout.write('Quotation asset searches keep only the latest pending query.\n');
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
