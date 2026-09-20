const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'static', 'js', 'events-overview.js'),
  'utf8',
);
const start = source.indexOf('async function loadAllEvents(');
const end = source.indexOf('window.__preparePendingActions', start);
const loaderSource = source.slice(start, end);

function makeOverview(responses) {
  const requests = [];
  const renders = [];
  const buttons = ['All', 'Active'].map(eventState => ({
    dataset: { eventState },
    active: eventState === 'Active',
    classList: {
      toggle(_name, active) { this.owner.active = active; },
    },
  }));
  buttons.forEach(button => { button.classList.owner = button; });

  const context = vm.createContext({
    document: { querySelectorAll: () => buttons },
    ensureAllEventsViewTabs() {},
    getActiveAllEventsTab: () => 'card',
    getActiveSectionId: () => 'events',
    requestedAllEventsScope: () => 'active',
    apiCall: async url => {
      requests.push(url);
      return responses.shift();
    },
    updateOverdueCounter() {},
    countOverdueEvents: () => 0,
    renderAllEventsList: rows => renders.push(rows.map(row => row.id)),
    showAllEventsProgress() {},
    loadStatsCards: async () => {},
    console,
  });
  vm.runInContext(`
    let __allEventsLoadVersion = 0;
    let __allEventsProgressiveLoading = false;
    let events = [];
    let allEventsStateFilter = 'Active';
    let allEventsLoadedScope = 'none';
    let allEventsOverviewStateCounts = null;
    let allEventsOverviewStateCountsByTag = null;
    const EVENT_OVERVIEW_PAGE_SIZE = 500;
    ${loaderSource}
  `, context);
  return { context, requests, renders, buttons };
}

test('zero active events switch to All before rendering cards', async () => {
  const overview = makeOverview([
    { data: [], meta: { total: 0, hasMore: false, stateCounts: { Closed: 2 } } },
    { data: [{ id: 1 }, { id: 2 }], meta: { total: 2, hasMore: false, stateCounts: { Closed: 2 } } },
  ]);

  await vm.runInContext('loadAllEvents()', overview.context);

  assert.equal(overview.requests.length, 2);
  assert.match(overview.requests[0], /scope=active/);
  assert.match(overview.requests[1], /scope=all/);
  assert.equal(JSON.stringify(overview.renders), JSON.stringify([[1, 2]]));
  assert.equal(vm.runInContext('allEventsStateFilter', overview.context), 'All');
  assert.equal(vm.runInContext('allEventsLoadedScope', overview.context), 'all');
  assert.equal(overview.buttons[0].active, true);
  assert.equal(overview.buttons[1].active, false);
});

test('active events stay on Active and do not fetch All', async () => {
  const overview = makeOverview([
    { data: [{ id: 1 }], meta: { total: 1, hasMore: false, stateCounts: { Ongoing: 1 } } },
  ]);

  await vm.runInContext('loadAllEvents()', overview.context);

  assert.equal(overview.requests.length, 1);
  assert.match(overview.requests[0], /scope=active/);
  assert.equal(JSON.stringify(overview.renders), JSON.stringify([[1]]));
  assert.equal(vm.runInContext('allEventsStateFilter', overview.context), 'Active');
});
