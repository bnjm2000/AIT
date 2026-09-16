const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '../static/js/plan.js'), 'utf8'
);

test('Plan quotation picker shows status badges and filters the server results', async () => {
  const requests = [];
  const elements = {
    planQuotationPickerFilters: { innerHTML: '', scrollLeft: 0 },
    planQuotationPickerResults: { innerHTML: '' },
    planQuotationPickerMore: { hidden: true, disabled: false, style: {}, textContent: '' },
  };
  const context = vm.createContext({
    Map,
    URLSearchParams,
    clearTimeout,
    document: { getElementById: id => elements[id] || null },
    escapeHtml: value => String(value ?? ''),
    escapeHtmlAttr: value => String(value ?? ''),
    escapeJs: value => String(value ?? ''),
    showNotification() {},
    async apiCall(url) {
      requests.push(url);
      const status = new URL(`http://localhost${url}`).searchParams.get('status');
      const rows = [
        { id: 'draft-1', number: 'QT-1', projectName: 'Draft Show', clientName: 'Alpha', status: 'draft', documentVersion: 1 },
        { id: 'sent-1', number: 'QT-2', projectName: 'Sent Show', clientName: 'Beta', status: 'sent', documentVersion: 1 },
      ];
      return {
        data: status === 'all' ? rows : rows.filter(row => row.status === status),
        meta: {
          nextOffset: status === 'all' ? 2 : 1,
          hasMore: false,
          statusTotal: 2,
          statusCounts: { draft: 1, sent: 1 },
        },
      };
    },
  });
  vm.runInContext(source, context);
  context.planQuotationPickerState.eventId = 42;
  context.planQuotationPickerState.query = 'Show';

  await context.planLoadQuotationOptions();
  assert.match(requests[0], /query=Show/);
  assert.match(requests[0], /status=all/);
  assert.match(elements.planQuotationPickerFilters.innerHTML, /All<span class="plan-event-chooser-count">2/);
  assert.match(elements.planQuotationPickerFilters.innerHTML, /Draft<span class="plan-event-chooser-count">1/);
  assert.match(elements.planQuotationPickerFilters.innerHTML, /Sent<span class="plan-event-chooser-count">1/);
  assert.match(elements.planQuotationPickerResults.innerHTML, /data-status="draft"/);
  assert.match(elements.planQuotationPickerResults.innerHTML, /data-status="sent"/);

  await context.planSetQuotationPickerStatus('sent');
  assert.match(requests[1], /status=sent/);
  assert.doesNotMatch(elements.planQuotationPickerResults.innerHTML, /QT-1/);
  assert.match(elements.planQuotationPickerResults.innerHTML, /QT-2/);
  assert.match(elements.planQuotationPickerFilters.innerHTML, /aria-pressed="true"[\s\S]*?Sent/);
});
