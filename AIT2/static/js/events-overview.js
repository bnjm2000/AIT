// Event overview, event-page lists, and prepare-page realtime controls.

function ensureEventListViewStyles() {
  if (document.getElementById('event-list-view-styles')) return;
  const style = document.createElement('style');
  style.id = 'event-list-view-styles';
  style.textContent = `
    .event-view-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 16px;
      background: #fff;
      border: 1px solid #edf0f5;
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.04);
    }
    .event-view-toggle { display: flex; gap: 6px; flex-wrap: wrap; }
    .event-view-toggle .btn.active { background: #764ba2; color: white; }
    .event-list-table-wrap { overflow: auto; border: 1px solid #dfe8e4; border-radius: 8px; background: white; box-shadow:0 3px 12px rgba(15,23,42,.045); }
    .event-list-table { width: 100%; min-width: 820px; border-collapse: separate; border-spacing: 0; margin: 0; color:#263b35; font-size:10px; }
    .event-list-table th { position:sticky;top:0;z-index:3;background:#f2f7f5;color:#60736d;font-size:9px;font-weight:800;letter-spacing:.02em;text-transform:uppercase;padding:7px 9px;border-bottom:1px solid #dfe8e4;text-align:left;white-space:nowrap; }
    .event-list-table td { padding:6px 9px;border-bottom:2px solid #e8efec;vertical-align:middle;line-height:1.25; }
    .event-list-table tbody tr { --event-state:#64748b;--event-soft:#f8fafc;background:#fff;transition:background .14s ease; }
    .event-list-table tbody tr:hover { background:color-mix(in srgb,var(--event-soft) 68%,white); }
    .event-list-table tbody tr:last-child td { border-bottom:0; }
    .event-list-table tbody tr td:first-child { border-left:3px solid var(--event-state); }
    .event-list-id { color:var(--event-state);white-space:nowrap; }
    .event-list-title { min-width:180px;max-width:310px;color:#1f352f;font-weight:750; }
    .event-list-location { margin-top:1px!important;color:#71817c!important;font-size:9px!important;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
    .event-list-table .event-assignee-summary { margin-top:2px;gap:4px;font-size:9px;line-height:1.15; }
    .event-list-table .event-assignee-summary span { font-size:8px; }
    .event-list-table :is(.event-type-badge,.event-state) { padding:3px 6px;border-radius:4px;font-size:8px; }
    .event-progress-track { background:#e4ece9;border-radius:999px;height:4px;width:88px;overflow:hidden;margin-top:3px; }
    .event-progress-bar { background: var(--event-state, #16a34a); height: 100%; transition: width .2s ease; }
    .event-list-actions-cell { width:1%;white-space:nowrap; }
    .event-list-table .event-card-controls { gap:4px; }
    .event-list-table .event-primary-action { min-height:29px;padding:5px 9px;border-radius:5px;font-size:9px; }
    .event-list-table .event-overflow-button { width:29px;min-height:29px;border-radius:5px;font-size:14px; }
    .event-list-table .event-card-menu { max-height:min(430px,calc(var(--scaled-dvh, 100dvh) - 20px));overflow-y:auto;z-index:2000; }
    .event-list-type-state { display:grid;justify-items:start;gap:4px; }
    .event-workflow-icon-strip { display:flex;align-items:center;gap:4px;min-width:0; }
    .event-workflow-icon-button {
      --workflow-icon-color:#64748b;
      display:inline-grid;
      place-items:center;
      flex:0 0 28px;
      width:28px;
      height:28px;
      padding:0;
      border:1px solid color-mix(in srgb,var(--workflow-icon-color) 32%,#d8e0e8);
      border-radius:7px;
      background:color-mix(in srgb,var(--workflow-icon-color) 7%,#fff);
      color:var(--workflow-icon-color);
      cursor:pointer;
      transition:transform .14s ease,background .14s ease,border-color .14s ease;
    }
    .event-workflow-icon-button:hover,.event-workflow-icon-button:focus-visible {
      border-color:var(--workflow-icon-color);
      background:color-mix(in srgb,var(--workflow-icon-color) 13%,#fff);
      transform:translateY(-1px);
      outline:none;
    }
    .event-workflow-icon-button.status-green { --workflow-icon-color:#15803d; }
    .event-workflow-icon-button.status-orange { --workflow-icon-color:#d97706; }
    .event-workflow-icon-button.status-red { --workflow-icon-color:#dc2626; }
    .event-workflow-icon-button.status-blue { --workflow-icon-color:#2563eb; }
    .event-workflow-icon-button svg { width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round; }
    .event-workflow-icon-button .event-finance-symbol { font-size:16px;font-weight:800;line-height:1; }
    .event-list-workflow-cell { width:1%;white-space:nowrap; }
    .event-list-workflow-cell .event-workflow-icon-button { flex-basis:25px;width:25px;height:25px;border-radius:6px; }
    .event-list-workflow-cell .event-workflow-icon-button svg { width:14px;height:14px; }
    .event-list-workflow-cell .event-workflow-icon-button .event-finance-symbol { font-size:14px; }
    #return-section :is(.event-card, .event-state, .event-list-table tr):is(.state-new, .state-added) {
      --event-state: #ec407a;
      --event-soft: #fff0f5;
    }
    #return-section :is(.event-card, .event-state, .event-list-table tr).state-planning {
      --event-state: #6d28d9;
      --event-soft: #f3efff;
    }
    #return-section :is(.event-card, .event-state, .event-list-table tr).state-preparing {
      --event-state: #0877e8;
      --event-soft: #edf6ff;
    }
    #return-section :is(.event-card, .event-state, .event-list-table tr).state-ready {
      --event-state: #16a34a;
      --event-soft: #edf9f0;
    }
    #return-section :is(.event-card, .event-state, .event-list-table tr).state-ongoing {
      --event-state: #0b97a4;
      --event-soft: #edfafa;
    }
    #return-section :is(.event-card, .event-state, .event-list-table tr).state-returning {
      --event-state: #f97316;
      --event-soft: #fff5ea;
    }
    #return-section :is(.event-card, .event-state, .event-list-table tr).state-overdue {
      --event-state: #ef3340;
      --event-soft: #fff0f1;
    }
    #return-section :is(.event-card, .event-state, .event-list-table tr).state-closed {
      --event-state: #64748b;
      --event-soft: #f1f5f9;
    }
    #return-section .event-card {
      border: 1px solid #e5e7eb;
      border-left: 5px solid var(--event-state, #64748b);
      background: var(--event-soft, #f1f5f9);
      color: #111827;
    }
    #return-section .event-state {
      background: var(--event-soft, #f1f5f9);
      color: var(--event-state, #64748b);
    }
    #return-section .event-card-progress-bar {
      background: var(--event-state, #16a34a) !important;
    }
    .events-workflow-card { container-type: inline-size; }
    .event-workflow-progress { min-width: 0; gap: 8px; }
    .event-progress-summary { flex-basis: 82px; min-width: 0; }
    .event-progress-value { font-size: .95rem; white-space: nowrap; }
    .event-department-progress { min-width: 0; overflow: hidden; }
    .event-department-row {
      grid-template-columns: minmax(0, 42px) minmax(18px, 1fr) max-content;
      column-gap: 2px;
      min-width: 0;
      width: 100%;
    }
    .event-department-row > span:first-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .event-department-track { width: 100%; min-width: 0; }
    .event-department-row > span:last-child { white-space: nowrap; }
    @container (max-width: 360px) {
      .event-workflow-progress {
        align-items: flex-start;
        flex-wrap: wrap;
        row-gap: 10px;
      }
      .event-department-progress {
        flex: 1 1 100%;
        width: 100%;
      }
    }
  `;
  document.head.appendChild(style);
}

function getEventSortMode(scope) {
  const idMap = {
    all: 'allEventsSortSelect',
    prepare: 'prepareEventsSortSelect',
    return: 'returnEventsSortSelect'
  };
  return document.getElementById(idMap[scope])?.value || 'startDate';
}


function sortEventsForView(list, scope = 'all') {
  const mode = getEventSortMode(scope);
  const arr = [...(list || [])];
  if (mode === 'eventId') {
    return arr.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  }
  return sortEventsStartDateFutureTop(arr);
}

function eventDateRangeText(event) {
  const start = parseEventOverviewDate(event.startDate);
  const end = parseEventOverviewDate(event.endDate);
  if (!start || !end) {
    return event.startDate === event.endDate
      ? formatDate(event.startDate)
      : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;
  }

  const startDay = start.getDate();
  const endDay = end.getDate();
  const startYear = start.getFullYear();
  const endYear = end.getFullYear();
  const sameDay = startYear === endYear
    && start.getMonth() === end.getMonth()
    && startDay === endDay;
  const sameMonth = startYear === endYear && start.getMonth() === end.getMonth();
  const shortMonth = date => date.toLocaleDateString('en-GB', { month: 'short' });
  const longMonth = date => date.toLocaleDateString('en-GB', { month: 'long' });

  if (sameDay) return `${startDay} ${shortMonth(start)} ${startYear}`;
  if (sameMonth) return `${startDay} - ${endDay} ${shortMonth(end)} ${endYear}`;
  if (startYear === endYear) {
    return `${startDay} ${longMonth(start)} - ${endDay} ${longMonth(end)} ${endYear}`;
  }
  return `${startDay} ${longMonth(start)} ${startYear} - ${endDay} ${longMonth(end)} ${endYear}`;
}

function eventLocationIconHtml() {
  return `
    <svg class="event-location-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 21s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12Z"></path>
      <circle cx="12" cy="9" r="2.3"></circle>
    </svg>
  `;
}

function parseEventOverviewDate(value) {
  const text = String(value || '').trim();
  const parts = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (parts) {
    const parsed = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 12, 0, 0, 0);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isEventLastDay(event, today = new Date()) {
  if (event?.state !== 'Ongoing') return false;
  if (typeof event.isLastDay === 'boolean') return event.isLastDay;
  const end = parseEventOverviewDate(event.endDate);
  if (!end || !Number.isFinite(today?.getTime?.())) return false;
  return end.getFullYear() === today.getFullYear()
    && end.getMonth() === today.getMonth()
    && end.getDate() === today.getDate();
}

function eventTagBadgeHtml(event) {
  const type = overviewEventType(event);
  return `<span class="event-type-badge ${type === 'dry hire' ? 'dry-hire' : ''}">${type === 'dry hire' ? 'Dry Hire' : 'Events'}</span>`;
}

function getEventWorkflowPalette(state) {
  const palettes = {
    New: { main: '#ec407a', soft: '#fff0f5' },
    Planning: { main: '#6d28d9', soft: '#f3efff' },
    Preparing: { main: '#0877e8', soft: '#edf6ff' },
    Ready: { main: '#16a34a', soft: '#edf9f0' },
    Ongoing: { main: '#0b97a4', soft: '#edfafa' },
    Returning: { main: '#f97316', soft: '#fff5ea' },
    'Pending Closure': { main: '#334155', soft: '#e2e8f0' },
    Overdue: { main: '#ef3340', soft: '#fff0f1' },
    Closed: { main: '#64748b', soft: '#f1f5f9' }
  };
  return palettes[state] || palettes.Closed;
}

function eventStateBadgeHtml(event, displayState = null) {
  const state = displayState || event.state || '';
  const palette = getEventWorkflowPalette(state);
  return `<span class="event-state ${getEventStateClass(state)}" style="background:${palette.soft};color:${palette.main};">${escapeHtml(eventStateDisplayLabel(state))}</span>`;
}

function renderProgressCell(done, total) {
  const safeTotal = Math.max(Number(total || 0), 0);
  const safeDone = Math.max(Number(done || 0), 0);
  const pct = safeTotal > 0 ? Math.min(100, Math.round((safeDone / safeTotal) * 100)) : 0;
  return `
    <div style="white-space:nowrap;">${safeDone}/${safeTotal}</div>
    <div class="event-progress-track"><div class="event-progress-bar" style="width:${pct}%;"></div></div>
  `;
}

let allEventsStateFilter = 'Active';
let allEventsTypeFilter = 'all';
let eventOverviewDocumentHandlersBound = false;

function overviewDisplayState(event) {
  return eventStateDisplayLabel(event?.state || 'New');
}

function overviewEventType(event) {
  return String(event?.tag || 'events').toLowerCase() === 'dry hire' ? 'dry hire' : 'events';
}

function ensureAllEventsViewTabs() {
  ensureEventListViewStyles();
  if (eventOverviewDocumentHandlersBound) return;
  eventOverviewDocumentHandlersBound = true;

  document.addEventListener('click', event => {
    if (!event.target.closest('.event-card-controls')) {
      closeEventCardMenus();
    }
    if (!event.target.closest('.event-type-filter')) {
      document.getElementById('eventTypeFilterMenu')?.classList.remove('open');
      document.getElementById('eventTypeFilterButton')?.setAttribute('aria-expanded', 'false');
    }
  });

  setAllEventsOverviewView(localStorage.getItem('allEventsOverviewView') || 'card', false);
}

function getActiveAllEventsTab() {
  return document.querySelector('.events-view-toggle [data-events-view].active')?.dataset.eventsView
    || localStorage.getItem('allEventsOverviewView')
    || 'card';
}

function setAllEventsOverviewView(view, shouldRender = true) {
  const validView = ['card', 'event-list', 'calendar'].includes(view) ? view : 'card';
  const previousView = getActiveAllEventsTab();
  localStorage.setItem('allEventsOverviewView', validView);

  document.querySelectorAll('.events-view-toggle [data-events-view]').forEach(button => {
    const active = button.dataset.eventsView === validView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  const idMap = {
    card: 'all-events-list-view',
    'event-list': 'all-events-table-view',
    calendar: 'all-events-calendar-view'
  };
  Object.entries(idMap).forEach(([key, id]) => {
    const content = document.getElementById(id);
    if (!content) return;
    const active = key === validView;
    content.classList.toggle('active', active);
    content.style.display = active ? 'block' : 'none';
  });

  if (!shouldRender) return;
  if (validView === 'calendar') {
    __allEventsLoadVersion += 1;
    __allEventsProgressiveLoading = false;
    loadCalendarView();
  } else if (previousView === 'calendar') {
    loadAllEvents();
  } else {
    renderAllEventsList(events);
  }
}

function switchAllEventsTab(tabName) {
  setAllEventsOverviewView(tabName === 'list' ? 'card' : tabName);
}

function toggleEventTypeFilterMenu(event) {
  event?.stopPropagation();
  const menu = document.getElementById('eventTypeFilterMenu');
  const button = document.getElementById('eventTypeFilterButton');
  if (!menu || !button) return;
  const open = !menu.classList.contains('open');
  menu.classList.toggle('open', open);
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function setEventTypeFilter(type) {
  allEventsTypeFilter = ['events', 'dry hire'].includes(type) ? type : 'all';
  const labels = { all: 'Filters', events: 'Events', 'dry hire': 'Dry Hire' };
  const label = document.getElementById('eventTypeFilterLabel');
  if (label) label.textContent = labels[allEventsTypeFilter];

  document.querySelectorAll('#eventTypeFilterMenu [data-event-type]').forEach(button => {
    button.setAttribute('aria-checked', button.dataset.eventType === allEventsTypeFilter ? 'true' : 'false');
  });
  document.getElementById('eventTypeFilterMenu')?.classList.remove('open');
  document.getElementById('eventTypeFilterButton')?.setAttribute('aria-expanded', 'false');
  updateEventStateFilterCounts(events);
  renderAllEventsList(events);
}

function setEventStateFilter(state) {
  allEventsStateFilter = state || 'All';
  document.querySelectorAll('#eventsStateFilters [data-event-state]').forEach(button => {
    button.classList.toggle('active', button.dataset.eventState === allEventsStateFilter);
  });
  renderAllEventsList(events);
}

function eventMatchesOverviewStateFilter(event, stateFilter = allEventsStateFilter) {
  if (!stateFilter || stateFilter === 'All') return true;
  const displayState = overviewDisplayState(event);
  if (stateFilter === 'Active') return !['Closed', 'Pending Closure'].includes(displayState);
  return displayState === stateFilter;
}

function updateEventStateFilterCounts(list, preferCalendarTotals = false) {
  const useCalendarTotals = (
    preferCalendarTotals
    && calendarStateCounts
    && typeof calendarStateCounts === 'object'
  );
  if (useCalendarTotals) {
    const sourceCounts = allEventsTypeFilter === 'all'
      ? calendarStateCounts
      : (calendarStateCountsByTag?.[allEventsTypeFilter] || {});
    const counts = { ...sourceCounts };
    counts.All = Object.values(sourceCounts).reduce((sum, value) => sum + Number(value || 0), 0);
    counts.Active = Math.max(
      0,
      counts.All - Number(sourceCounts.Closed || 0) - Number(sourceCounts['Pending Closure'] || 0),
    );
    document.querySelectorAll('#eventsStateFilters [data-event-state]').forEach(button => {
      const state = button.dataset.eventState;
      const count = Number(counts[state] || 0);
      const span = button.querySelector('span');
      if (span) span.textContent = String(count);
      button.hidden = state !== 'All' && count === 0;
    });
    if (allEventsStateFilter !== 'All' && !Number(counts[allEventsStateFilter] || 0)) {
      allEventsStateFilter = 'All';
      document.querySelectorAll('#eventsStateFilters [data-event-state]').forEach(button => {
        button.classList.toggle('active', button.dataset.eventState === 'All');
      });
    }
    return;
  }
  const source = (list || []).filter(event => {
    if (allEventsTypeFilter === 'all') return true;
    return overviewEventType(event) === allEventsTypeFilter;
  });
  const counts = {
    All: source.length,
    Active: source.filter(event => eventMatchesOverviewStateFilter(event, 'Active')).length
  };
  source.forEach(event => {
    const state = overviewDisplayState(event);
    counts[state] = (counts[state] || 0) + 1;
  });
  document.querySelectorAll('#eventsStateFilters [data-event-state]').forEach(button => {
    const state = button.dataset.eventState;
    const count = counts[state] || 0;
    const span = button.querySelector('span');
    if (span) span.textContent = String(count);
    button.hidden = state !== 'All' && count === 0;
  });
  if (
    !__allEventsProgressiveLoading &&
    allEventsStateFilter !== 'All' &&
    (counts[allEventsStateFilter] || 0) === 0
  ) {
    allEventsStateFilter = 'All';
    document.querySelectorAll('#eventsStateFilters [data-event-state]').forEach(button => {
      button.classList.toggle('active', button.dataset.eventState === 'All');
    });
  }
}

function filterEventsBySearch(list) {
  const searchTerm = document.getElementById('event-search')?.value.toLowerCase().trim() || '';
  return (list || []).filter(event => {
    const tag = overviewEventType(event);
    if (allEventsTypeFilter !== 'all' && tag !== allEventsTypeFilter) return false;
    if (!eventMatchesOverviewStateFilter(event)) return false;
    if (!searchTerm) return true;
    return (`${event.id} ${event.name || ''} ${event.location || ''} ${event.state || ''} ${event.tag || ''} ${event.startDate || ''} ${event.endDate || ''}`)
      .toLowerCase()
      .includes(searchTerm);
  });
}

function getFilteredEventsForOverview(list) {
  return sortEventsForView(filterEventsBySearch(list || []), 'all');
}

function eventOverviewProgress(event) {
  const state = event.state || 'New';
  if (['Returning', 'Overdue', 'Pending Closure', 'Closed'].includes(state)) {
    if (state === 'Closed' && event.forceStateOverride) {
      const done = Math.max(0, Number(event.returnedCount || 0));
      const total = Math.max(done, Number(event.returnableTotalCount || event.assetCount || 0));
      return { done, total, label: 'Returned' };
    }

    const physicalTotal = Number(event.returnableTotalCount);
    if (Number.isFinite(physicalTotal) && physicalTotal >= 0) {
      const total = Math.max(0, physicalTotal);
      return { done: getEventPhysicallyReturnedCount(event), total, label: 'Returned' };
    }

    const done = Math.max(0, Number(event.returnedCount || 0));
    const total = Math.max(done, Number(event.assetCount || 0));
    return { done, total, label: 'Returned' };
  }
  if (state === 'Ongoing') {
    // Keep the event-card progress tied to preparation requirements. Physical
    // returnables include prepared extras, while assetCount also includes
    // vendor-delivered loans; combining those values produces misleading
    // percentages such as 383/393 for a fully prepared event.
    const prepared = Math.max(0, Number(event.preparationCount ?? event.preparedCount ?? 0));
    const required = Math.max(0, Number(event.preparationTotal ?? event.assetCount ?? 0));
    return { done: prepared, total: required, label: 'Prepared' };
  }
  if (state === 'New') {
    return { done: 0, total: Math.max(0, Number(event.assetCount || 0)), label: 'Items added', added: true };
  }
  return {
    done: Math.max(0, Number(event.preparationCount ?? event.preparedCount ?? 0)),
    total: Math.max(0, Number(event.preparationTotal ?? event.assetCount ?? 0)),
    label: state === 'Planning' ? 'Planned' : 'Packed'
  };
}

function eventDepartmentProgress(event) {
  if (Array.isArray(event.departmentProgress) && event.departmentProgress.length) {
    return event.departmentProgress;
  }

  const phaseUsesReturns = ['Returning', 'Overdue', 'Pending Closure', 'Closed'].includes(event.state);
  const phaseUsesOut = event.state === 'Ongoing';
  const totals = new Map();

  const addProgress = (department, done, total) => {
    const code = normalizeDepartmentCode(department || 'UN');
    const current = totals.get(code) || { code, done: 0, total: 0 };
    current.done += Math.max(0, Number(done || 0));
    current.total += Math.max(0, Number(total || 0));
    totals.set(code, current);
  };

  Object.values(event.modelGroups || {}).forEach(group => {
    const code = normalizeDepartmentCode(group.department || 'UN');
    const required = Math.max(0, Number(group.requiredQuantity || 0));
    const prepared = Math.max(0, Number(group.countablePreparedQuantity ?? getCountablePreparedQuantity(group) ?? 0));
    const returned = Math.max(0, Number(group.countableReturnedQuantity || 0));
    addProgress(code, phaseUsesReturns ? returned : (phaseUsesOut ? Math.max(prepared - returned, 0) : prepared), required);
  });

  const returnedRefs = new Set(event.returnedItems || []);
  const preparedRefs = new Set([
    ...(event.actuallyPrepared || []),
    ...(event.returnableRefs || [])
  ]);
  const collectedRefs = new Set(event.customCollected || []);
  const seenCustomRefs = new Set();

  (event.preparedItems || []).forEach(ref => {
    const custom = parseCustomAsset(ref);
    if (!custom || seenCustomRefs.has(ref)) return;
    seenCustomRefs.add(ref);

    const quantity = Math.max(1, Number(custom.quantity || 1));
    const isReturned = returnedRefs.has(ref);
    const isPrepared = preparedRefs.has(ref);
    const isCollectedLoan = custom.type === 'LOAN' && collectedRefs.has(ref);
    let done = 0;

    if (phaseUsesReturns) {
      done = isReturned ? quantity : 0;
    } else if (phaseUsesOut) {
      done = !isReturned && (isPrepared || isCollectedLoan) ? quantity : 0;
    } else if (event.state !== 'New') {
      done = (isPrepared || isReturned || isCollectedLoan) ? quantity : 0;
    }

    addProgress(custom.department || 'UN', done, quantity);
  });

  const overviewProgress = eventOverviewProgress(event);
  let accountedTotal = [...totals.values()].reduce((sum, row) => sum + row.total, 0);
  let remainingTotal = Math.max(overviewProgress.total - accountedTotal, 0);

  // Required totals deliberately exclude manual extras. When the event-level
  // progress includes those deployed extras, add them back to their department.
  if (remainingTotal > 0) {
    Object.values(event.modelGroups || {}).forEach(group => {
      if (remainingTotal <= 0) return;
      const assigned = Math.max(0, Number(group.assignedQuantity || 0));
      const countableAssigned = Math.max(0, Number(group.countableAssignedQuantity || 0));
      const extraTotal = Math.max(assigned - countableAssigned, 0);
      if (!extraTotal) return;

      const returned = Math.max(0, Number(group.returnedQuantity || 0));
      const countableReturned = Math.max(0, Number(group.countableReturnedQuantity || 0));
      const prepared = Math.max(0, Number(group.preparedQuantity || 0));
      const countablePrepared = Math.max(0, Number(group.countablePreparedQuantity || 0));
      const quantity = Math.min(extraTotal, remainingTotal);
      const extraDone = phaseUsesReturns
        ? Math.max(returned - countableReturned, 0)
        : Math.max(prepared - countablePrepared, 0);

      addProgress(group.department || 'UN', Math.min(extraDone, quantity), quantity);
      remainingTotal -= quantity;
    });
  }

  if (remainingTotal > 0) {
    addProgress('UN', 0, remainingTotal);
  }

  if (!totals.size) {
    totals.set('UN', { code: 'UN', done: overviewProgress.done, total: overviewProgress.total });
  }

  const rows = [...totals.values()]
    .filter(row => row.total > 0)
    .map(row => ({ ...row, done: Math.min(row.done, row.total) }))
    .sort((a, b) => b.total - a.total);

  if (rows.length <= 4) return rows;

  const visible = rows.slice(0, 3);
  const remainder = rows.slice(3).reduce((combined, row) => ({
    code: 'OTHER',
    label: 'Other',
    done: combined.done + row.done,
    total: combined.total + row.total
  }), { code: 'OTHER', label: 'Other', done: 0, total: 0 });
  return [...visible, remainder];
}

function eventOverviewNotice(event, progress) {
  const remaining = Math.max(progress.total - progress.done, 0);
  switch (event.state) {
    case 'New': return progress.total ? `${progress.total} requirements added` : 'Ready to start planning';
    case 'Planning': return `${progress.total} asset requirements planned`;
    case 'Preparing': return `${remaining} item${remaining === 1 ? '' : 's'} left to pack`;
    case 'Ready': return 'All items ready';
    case 'Ongoing': {
      if (isEventLastDay(event)) return 'In progress. Last day';
      const end = parseEventOverviewDate(event.endDate);
      if (!end) return 'In progress';
      const today = new Date();
      today.setHours(12, 0, 0, 0);
      const days = Math.max(0, Math.ceil((end - today) / 86400000));
      return days
        ? `In progress  ·  Ends in ${days} day${days === 1 ? '' : 's'}`
        : 'In progress  ·  Ends today';
    }
    case 'Returning': {
      const returnable = Math.max(0, Number(event.returnableCount || 0));
      return `${returnable} asset${returnable === 1 ? '' : 's'} still out`;
    }
    case 'Overdue': return 'Overdue return';
    case 'Closed': {
      const remaining = Math.max(progress.total - progress.done, 0);
      return remaining
        ? `${remaining} item${remaining === 1 ? '' : 's'} not returned`
        : 'All items returned';
    }
    default: return '';
  }
}

function getEventPrimaryAction(event) {
  if (event.state === 'New') {
    return isAdminUser()
      ? { label: 'Start Planning', onclick: `openEventPlanning(${event.id})` }
      : { label: 'Start Preparing', onclick: `openPrepareWorkspaceForEvent(${event.id})` };
  }
  if (event.state === 'Planning') {
    return { label: 'Prepare', onclick: `openPrepareWorkspaceForEvent(${event.id})` };
  }
  if (event.state === 'Preparing') return { label: 'Continue Preparing', onclick: `openPrepareWorkspaceForEvent(${event.id})` };
  if (event.state === 'Ready') return { label: 'Generate DO', onclick: `openDeliveryOrderTab(${event.id})` };
  if (event.state === 'Ongoing') return { label: 'Start Return', onclick: `openReturnWorkspaceForEvent(${event.id})` };
  if (event.state === 'Returning') return { label: 'Continue Return', onclick: `openReturnWorkspaceForEvent(${event.id})` };
  if (event.state === 'Overdue') return { label: 'Start Return', onclick: `openReturnWorkspaceForEvent(${event.id})` };
  return { label: 'View', onclick: `viewEvent(${event.id})` };
}

function eventNextActionText(event) {
  switch (event.state) {
    case 'New': return isAdminUser() ? 'Add requirements and manage assets.' : 'Prepare or quick-add event assets.';
    case 'Planning': return 'Prepare the planned requirements.';
    case 'Preparing': return 'Continue packing remaining items.';
    case 'Ready': return 'Generate delivery order and dispatch.';
    case 'Ongoing': return isEventLastDay(event) ? 'Prioritise return today.' : 'Monitor event and provide on-site support.';
    case 'Returning': return 'Continue returning outstanding items.';
    case 'Overdue': return 'Resolve overdue returns immediately.';
    case 'Closed': return 'Review completed event details.';
    default: return 'Review event details.';
  }
}

function eventAssigneeSummaryHtml(event) {
  const rows = Array.isArray(event.assignedUsers) ? event.assignedUsers : [];
  if (!rows.length) {
    return '<div class="event-assignee-summary muted"><span>Assigned</span><strong>Unassigned</strong></div>';
  }
  const visible = rows.slice(0, 3);
  const names = visible
    .map(user => eventAssigneeDisplayName(user) || user.username)
    .filter(Boolean);
  const more = rows.length > visible.length ? ` +${rows.length - visible.length}` : '';
  return `
    <div class="event-assignee-summary">
      <span>Assigned</span>
      <strong>${escapeHtml(names.join(', ') + more)}</strong>
    </div>
  `;
}

async function openEventPlanning(eventId) {
  if (!isAdminUser()) {
    openPrepareWorkspaceForEvent(eventId);
    return;
  }
  const id = Number(eventId) || null;
  planPageState.eventId = id;
  planPageState.event = null;
  if (id && typeof workflowRememberEvent === 'function') workflowRememberEvent(id);
  showSection('plan', { eventId: id });
}

function openPrepareWorkspaceForEvent(eventId) {
  const id = Number(eventId) || null;
  prepareNewPageState.eventId = id;
  prepareNewPageState.event = null;
  if (id && typeof workflowRememberEvent === 'function') workflowRememberEvent(id);
  showSection('prepare-new', { eventId: id });
}

function openReturnWorkspaceForEvent(eventId) {
  const id = Number(eventId) || null;
  returnPageState.eventId = id;
  returnPageState.event = null;
  returnPageState.loaded = false;
  if (id && typeof workflowRememberEvent === 'function') workflowRememberEvent(id);
  showSection('return', { eventId: id });
}

function openEventTransport(eventId) {
  if (typeof openEventWorkforce === 'function') {
    openEventWorkforce(eventId, 'transport');
  }
}

function closeEventCardMenus() {
  document.querySelectorAll('.event-card-menu.open, .event-card-menu[data-event-menu-portal="true"]').forEach(menu => {
    menu.classList.remove('open');
    menu.style.position = '';
    menu.style.top = '';
    menu.style.left = '';
    menu.style.right = '';
    menu.style.bottom = '';
    menu.style.zIndex = '';
    menu.style.maxHeight = '';
    menu.style.overflowY = '';

    if (menu.dataset.eventMenuPortal === 'true') {
      const origin = menu.__eventMenuOriginParent;
      const nextSibling = menu.__eventMenuOriginNextSibling;
      if (origin?.isConnected) {
        origin.insertBefore(menu, nextSibling?.parentNode === origin ? nextSibling : null);
      } else {
        menu.remove();
      }
      delete menu.dataset.eventMenuPortal;
      delete menu.__eventMenuOriginParent;
      delete menu.__eventMenuOriginNextSibling;
    }
  });
}

function toggleEventCardMenu(event, eventId, context = 'card') {
  event?.stopPropagation();
  const target = document.getElementById(`event-card-menu-${context}-${eventId}`);
  const shouldOpen = target && !target.classList.contains('open');
  closeEventCardMenus();
  if (!shouldOpen || !target?.isConnected) return;
  if (target) {
    target.style.position = '';
    target.style.top = '';
    target.style.left = '';
    target.style.right = '';
    target.style.bottom = '';
    target.style.zIndex = '';
  }
  target.classList.add('open');
  if (target && shouldOpen) {
    const buttonRect = event?.currentTarget
      ? showbaseViewport.rect(event.currentTarget.getBoundingClientRect())
      : null;
    if (buttonRect) {
      target.__eventMenuOriginParent = target.parentElement;
      target.__eventMenuOriginNextSibling = target.nextSibling;
      document.body.appendChild(target);
      target.dataset.eventMenuPortal = 'true';
      const menuRect = showbaseViewport.rect(target.getBoundingClientRect());
      const margin = 10;
      const gap = 6;
      const roomBelow = showbaseViewport.height() - buttonRect.bottom;
      const preferredTop = roomBelow >= menuRect.height + gap + margin
        ? buttonRect.bottom + gap
        : buttonRect.top - menuRect.height - gap;
      target.style.position = 'fixed';
      target.style.top = `${Math.max(margin, Math.min(preferredTop, showbaseViewport.height() - menuRect.height - margin))}px`;
      target.style.left = `${Math.max(margin, Math.min(buttonRect.right - menuRect.width, showbaseViewport.width() - menuRect.width - margin))}px`;
      target.style.right = 'auto';
      target.style.bottom = 'auto';
      target.style.zIndex = '2000';
      target.style.maxHeight = `calc(var(--scaled-dvh, 100dvh) - ${margin * 2}px)`;
      target.style.overflowY = 'auto';
    }
  }
}

function eventMenuIconHtml(icon) {
  const paths = {
    edit: `
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
      <path d="m15 5 4 4"></path>
    `,
    view: `
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    `,
    logs: `
      <path d="M5 4h14v16H5z"></path>
      <path d="M8 8h8M8 12h8M8 16h5"></path>
    `,
    plan: `
      <rect x="5" y="4" width="14" height="17" rx="2"></rect>
      <path d="M9 4V2h6v2"></path>
      <path d="m9 13 2 2 4-4"></path>
    `,
    workforce: `
      <circle cx="7" cy="7" r="2.5"></circle>
      <path d="M2.5 19a4.5 4.5 0 0 1 9 0"></path>
      <rect x="13" y="8" width="9" height="10" rx="1.5"></rect>
      <path d="M16 8V6h3v2M13 12h9"></path>
    `,
    transport: `
      <path d="M3 6h11v10H3z"></path>
      <path d="M14 10h4l3 3v3h-7z"></path>
      <circle cx="7" cy="18" r="2"></circle>
      <circle cx="18" cy="18" r="2"></circle>
    `,
    return: `
      <path d="M9 7 4 12l5 5"></path>
      <path d="M4 12h10a6 6 0 0 1 6 6"></path>
    `,
    force: `
      <path d="m13 2-9 12h8l-1 8 9-12h-8Z"></path>
    `,
    delivery: `
      <path d="M7 3h7l4 4v14H7z"></path>
      <path d="M14 3v5h4"></path>
      <path d="M9 13h6M9 17h4"></path>
    `,
    packing: `
      <path d="m3 7 9-4 9 4-9 4z"></path>
      <path d="M3 7v10l9 4 9-4V7M12 11v10"></path>
    `,
    delete: `
      <path d="M3 6h18"></path>
      <path d="M8 6V4h8v2"></path>
      <path d="M19 6l-1 15H6L5 6"></path>
      <path d="M10 11v5"></path>
      <path d="M14 11v5"></path>
    `
  };
  return `<svg class="event-card-menu-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[icon] || ''}</svg>`;
}

function eventWorkflowIconHtml(kind) {
  const paths = {
    plan: '<rect x="6" y="4" width="12" height="16" rx="2"></rect><path d="M9 4.5h6M9 10h6M9 14h4"></path>',
    manpower: '<circle cx="7" cy="7" r="2.5"></circle><path d="M2.5 19a4.5 4.5 0 0 1 9 0"></path><rect x="13" y="8" width="9" height="10" rx="1.5"></rect><path d="M16 8V6h3v2M13 12h9"></path>',
    transport: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"></path><circle cx="7" cy="18" r="2"></circle><circle cx="18" cy="18" r="2"></circle><path d="M9 18h7M3 16h2"></path>',
    prepare: '<path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"></path><path d="M12 12v9M4.5 8 12 12l7.5-4"></path><path d="m15 14 1.6 1.6L20 12"></path>',
    return: '<path d="M9 7 4 12l5 5"></path><path d="M4 12h10a6 6 0 0 1 6 6"></path>'
  };
  if (kind === 'finance') return '<span class="event-finance-symbol" aria-hidden="true">$</span>';
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[kind] || ''}</svg>`;
}

function eventWorkflowFallbackProgress(event) {
  const required = Math.max(0, Number(event?.assetCount ?? event?.totalAssets ?? 0));
  const prepared = Math.max(0, Number(event?.preparedCount ?? event?.totalPrepared ?? 0));
  const returned = Math.max(0, Number(event?.returnedCount ?? event?.totalReturned ?? 0));
  const quantityStatus = done => !required || !done ? 'neutral' : done >= required ? 'green' : 'orange';
  return {
    plan: { status: required ? 'green' : 'neutral', label: required ? `Plan: ${required} asset requirements added` : 'Plan: no assets added' },
    manpower: { status: 'neutral', label: 'Crew & Vendors: no assignments' },
    transport: { status: 'neutral', label: 'Transport: no trips scheduled' },
    prepare: { status: quantityStatus(prepared), label: `Prepare: ${Math.min(prepared, required)}/${required} assets prepared` },
    return: { status: quantityStatus(returned), label: `Return: ${Math.min(returned, required)}/${required} assets returned` },
    finance: null
  };
}

function eventWorkflowProgressHtml(event, extraClass = '', closeOverviewOnNavigate = false) {
  const progress = event?.workflowProgress || eventWorkflowFallbackProgress(event);
  const actions = [
    ['plan', `openEventPlanning(${Number(event.id)})`],
    ['manpower', `openEventWorkforce(${Number(event.id)})`],
    ['transport', `openEventTransport(${Number(event.id)})`],
    ['prepare', `openPrepareWorkspaceForEvent(${Number(event.id)})`],
    ['return', `openReturnWorkspaceForEvent(${Number(event.id)})`],
    ['finance', `openEventFinance(${Number(event.id)})`]
  ];
  return `<div class="event-workflow-icon-strip ${escapeHtmlAttr(extraClass)}" aria-label="Event workspace progress">${actions.map(([kind, directAction]) => {
    const item = progress[kind];
    if (!item) return '';
    const status = ['green', 'orange', 'red', 'blue'].includes(item.status) ? item.status : 'neutral';
    const label = String(item.label || kind);
    const onclick = closeOverviewOnNavigate
      ? `eventOverviewNavigate('${kind}',${Number(event.id)})`
      : directAction;
    return `<button type="button" class="event-workflow-icon-button status-${status}" title="${escapeHtmlAttr(label)}" aria-label="${escapeHtmlAttr(label)}" onclick="${onclick}">${eventWorkflowIconHtml(kind)}</button>`;
  }).join('')}</div>`;
}

function openEventFinance(eventId) {
  const id = Number(eventId) || 0;
  if (!id) return;
  if (isAdminUser() && typeof openEventWorkforce === 'function') {
    openEventWorkforce(id, 'department');
    return;
  }
  if (typeof profitLossState !== 'undefined' && currentUserHasSalesAccess()) {
    profitLossState.eventId = id;
    showSection('profit-loss', { eventId: id });
  }
}

function eventCardMenuHtml(event, context = 'card') {
  const detailsAction = context !== 'card' && event.state === 'Closed'
    ? `<button type="button" onclick="viewEvent(${event.id})">${eventMenuIconHtml('view')}<span>View</span></button>`
    : (context !== 'card' && !isAdminUser()
      ? `<button type="button" onclick="viewEvent(${event.id})">${eventMenuIconHtml('view')}<span>View</span></button>`
      : '');
  const logsAction = context !== 'card' && canCurrentUserManageRoles()
    ? `<button type="button" onclick="openEventLogs(${event.id}, '${escapeJs(event.name || '')}')">${eventMenuIconHtml('logs')}<span>View logs</span></button>`
    : '';
  const adminActions = isAdminUser() ? `
    <button type="button" onclick="openDeliveryOrderTab(${event.id})">${eventMenuIconHtml('delivery')}<span>Generate DO</span></button>
    <button type="button" onclick="openPackingListPage(${event.id})">${eventMenuIconHtml('packing')}<span>Packing List</span></button>
    <button type="button" onclick="showForceStateModal(${event.id}, '${escapeHtmlAttr(event.state || '')}')">${eventMenuIconHtml('force')}<span>Force</span></button>
    <button type="button" class="danger" onclick="deleteEvent(${event.id})">${eventMenuIconHtml('delete')}<span>Delete</span></button>
  ` : '';
  if (!detailsAction && !logsAction && !adminActions) return '';

  return `
    <div class="event-card-menu" id="event-card-menu-${context}-${event.id}">
      ${detailsAction}
      ${logsAction}
      ${adminActions}
    </div>
  `;
}

function createEventsOverviewCard(event) {
  const card = document.createElement('article');
  const displayState = overviewDisplayState(event);
  card.className = `events-workflow-card ${getEventStateClass(displayState)}`;
  card.dataset.eventId = String(event.id);

  const progress = eventOverviewProgress(event);
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const action = getEventPrimaryAction(event);
  const menuHtml = eventCardMenuHtml(event, 'card');
  const progressVisualHtml = progress.added
    ? `
      <button
        type="button"
        class="event-progress-add-button"
        aria-label="Plan assets for ${escapeHtmlAttr(event.name || `event ${event.id}`)}"
        title="Plan assets"
        onclick="openEventPlanning(${event.id})"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 8v8"></path>
          <path d="M8 12h8"></path>
        </svg>
      </button>
    `
    : `
      <div class="event-progress-ring">
        <svg viewBox="0 0 72 72" aria-hidden="true" focusable="false">
          <circle class="event-progress-track-circle" cx="36" cy="36" r="29"></circle>
          <circle class="event-progress-value-circle" cx="36" cy="36" r="29" pathLength="100" style="stroke-dashoffset:${100 - percent}"></circle>
        </svg>
        <span>${percent}%</span>
      </div>
    `;
  const departmentsHtml = eventDepartmentProgress(event).map(row => {
    const total = Math.max(0, Number(row.total || 0));
    const done = Math.max(0, Number(row.done || 0));
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const meta = getDepartmentMeta(row.code);
    const label = row.label || meta.code || row.code;
    const fullLabel = row.label || meta.name || label;
    return `
      <div class="event-department-row" title="${escapeHtmlAttr(fullLabel)}">
        <span>${escapeHtml(label)}</span>
        <span class="event-department-track"><span style="width:${pct}%"></span></span>
        <span>${done}/${total}</span>
      </div>
    `;
  }).join('');
  const locationHtml = event.location
    ? `<span>${eventLocationIconHtml()}${escapeHtml(event.location)}</span>`
    : '';
  const assigneeSummary = eventAssigneeSummaryHtml(event);

  card.innerHTML = `
    <div class="event-workflow-main">
      <div class="event-workflow-heading">
        <div class="event-workflow-kicker">
          <span>#${escapeHtml(String(event.id))}</span>
          <span class="event-type-badge ${overviewEventType(event) === 'dry hire' ? 'dry-hire' : ''}">${overviewEventType(event) === 'dry hire' ? 'Dry Hire' : 'Events'}</span>
        </div>
        <div class="event-card-top-actions">
          <span class="event-workflow-state">${escapeHtml(eventStateDisplayLabel(displayState))}</span>
          <button type="button" class="event-top-icon-button" title="View event" aria-label="View ${escapeHtmlAttr(event.name || `event ${event.id}`)}" onclick="viewEvent(${event.id})">${eventMenuIconHtml('view')}</button>
          ${canCurrentUserManageRoles() ? `<button type="button" class="event-top-icon-button" title="View event logs" aria-label="View logs for ${escapeHtmlAttr(event.name || `event ${event.id}`)}" onclick="openEventLogs(${event.id}, '${escapeJs(event.name || '')}')">${eventMenuIconHtml('logs')}</button>` : ''}
          ${isAdminUser() ? `<button type="button" class="event-top-icon-button" title="Edit event" aria-label="Edit ${escapeHtmlAttr(event.name || `event ${event.id}`)}" onclick="editEvent(${event.id})">${eventMenuIconHtml('edit')}</button>` : ''}
        </div>
      </div>
      <h3 class="event-workflow-title">${escapeHtml(event.name || '')}</h3>
      <div class="event-workflow-meta">
        <span><span aria-hidden="true">&#128197;</span>${escapeHtml(eventDateRangeText(event))}</span>
        ${locationHtml}
      </div>
      ${assigneeSummary}
      <div class="event-workflow-progress">
        ${progressVisualHtml}
        <div class="event-progress-summary">
          <div class="event-progress-value" style="color:#111827;">${progress.done} / ${progress.total}</div>
          <div class="event-progress-label">${escapeHtml(progress.label)}</div>
        </div>
        <div class="event-department-progress">${departmentsHtml}</div>
      </div>
      <div class="event-workflow-notice">${escapeHtml(eventOverviewNotice(event, progress))}</div>
    </div>
    <div class="event-workflow-footer">
      ${eventWorkflowProgressHtml(event, 'event-card-workflow-icons')}
      <div class="event-card-controls">
        <button type="button" class="event-primary-action" onclick="${action.onclick}">${escapeHtml(action.label)}</button>
        ${menuHtml ? `<button type="button" class="event-overflow-button" aria-label="More actions for ${escapeHtmlAttr(event.name || '')}" onclick="toggleEventCardMenu(event, ${event.id}, 'card')">&#8230;</button>` : ''}
        ${menuHtml}
      </div>
    </div>
  `;
  return card;
}

function renderAllEventsCards(list) {
  const container = document.getElementById('all-events');
  if (!container) return;
  const sorted = getFilteredEventsForOverview(list || events);
  container.innerHTML = '';
  if (!sorted.length) {
    container.innerHTML = '<p style="text-align:center;color:#666;padding:40px;grid-column:1/-1;">No matching events found.</p>';
    return;
  }
  sorted.forEach(event => container.appendChild(createEventsOverviewCard(event)));
}

function renderAllEventsTable(list) {
  const container = document.getElementById('all-events-table-container');
  if (!container) return;
  closeEventCardMenus();
  const sorted = getFilteredEventsForOverview(list || events);
  if (!sorted.length) {
    container.innerHTML = '<p style="text-align:center;color:#666;padding:40px;">No matching events found.</p>';
    return;
  }
  const rows = sorted.map(event => {
    const progress = eventOverviewProgress(event);
    const action = getEventPrimaryAction(event);
    const location = event.location ? `<div class="event-list-location">${escapeHtml(event.location)}</div>` : '';
    const assigneeSummary = eventAssigneeSummaryHtml(event);
    const displayState = overviewDisplayState(event);
    const palette = getEventWorkflowPalette(displayState);
    return `
      <tr class="${getEventStateClass(displayState)}" style="--event-state:${palette.main};--event-soft:${palette.soft}">
        <td class="event-list-id"><strong>#${escapeHtml(String(event.id))}</strong></td>
        <td><div class="event-list-type-state">${eventTagBadgeHtml(event)}${eventStateBadgeHtml(event, displayState)}</div></td>
        <td class="event-list-title">${escapeHtml(event.name || '')}${location}${assigneeSummary}</td>
        <td>${escapeHtml(eventDateRangeText(event))}</td>
        <td class="event-list-workflow-cell">${eventWorkflowProgressHtml(event, 'event-list-workflow-icons')}</td>
        <td>${renderProgressCell(progress.done, progress.total)}</td>
        <td class="event-list-actions-cell">
          <div class="event-card-controls">
            <button type="button" class="event-primary-action" onclick="${action.onclick}">${escapeHtml(action.label)}</button>
            <button type="button" class="event-overflow-button" aria-label="More actions for ${escapeHtmlAttr(event.name || '')}" onclick="toggleEventCardMenu(event, ${event.id}, 'list')">&#8230;</button>
            ${eventCardMenuHtml(event, 'list')}
          </div>
        </td>
      </tr>
    `;
  }).join('');
  container.innerHTML = `
    <div class="event-list-table-wrap">
      <table class="event-list-table">
        <thead><tr><th>ID</th><th>Type / State</th><th>Event</th><th>Date</th><th>Workspaces</th><th>Progress</th><th>Next action</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderAllEventsList(eventsToRender = null) {
  const source = eventsToRender || events;
  const active = getActiveAllEventsTab();
  const calendarSource = active === 'calendar' && Array.isArray(calendarRawEvents)
    ? calendarRawEvents
    : source;
  updateEventStateFilterCounts(calendarSource, active === 'calendar');
  if (active === 'event-list') {
    renderAllEventsTable(source);
  } else if (active === 'calendar') {
    renderCalendar(getFilteredEventsForOverview(calendarSource));
  } else {
    renderAllEventsCards(source);
  }
}

function showAllEventsProgress(loaded, total) {
  if (!Number.isFinite(total) || loaded >= total) return;
  const active = getActiveAllEventsTab();
  const target = active === 'event-list'
    ? document.getElementById('all-events-table-container')
    : active === 'calendar'
      ? document.getElementById('calendar-container')
      : document.getElementById('all-events');
  if (!target) return;

  const indicator = document.createElement('div');
  indicator.className = 'loading events-progressive-loading';
  indicator.style.gridColumn = '1 / -1';
  indicator.textContent = `Loading more events (${loaded} of ${total})...`;
  target.appendChild(indicator);
}

async function loadAllEvents() {
  const loadVersion = ++__allEventsLoadVersion;
  __allEventsProgressiveLoading = true;
  let statsPromise = null;

  try {
    ensureAllEventsViewTabs();
    if (getActiveAllEventsTab() === 'calendar') {
      statsPromise = loadStatsCards();
      await loadCalendarView();
      return;
    }
    events = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;

    while (offset < total) {
      const response = await apiCall(
        `/api/events?view=summary&limit=${EVENT_OVERVIEW_PAGE_SIZE}&offset=${offset}`
      );
      if (loadVersion !== __allEventsLoadVersion) return;

      const page = response.data || [];
      const byId = new Map(events.map(event => [Number(event.id), event]));
      page.forEach(event => byId.set(Number(event.id), event));
      events = Array.from(byId.values());
      total = Math.max(0, Number(response.meta?.total ?? events.length));
      offset = Number(response.meta?.nextOffset ?? total);

      updateOverdueCounter(countOverdueEvents(events));
      renderAllEventsList(events);
      showAllEventsProgress(events.length, total);
      if (!statsPromise) statsPromise = loadStatsCards();

      if (!page.length || !response.meta?.hasMore) break;
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (getActiveSectionId() !== 'events') break;
    }
  } catch (error) {
    if (loadVersion !== __allEventsLoadVersion) return;
    console.error('Error loading events overview:', error);
    const active = getActiveAllEventsTab();
    const target = active === 'event-list'
      ? document.getElementById('all-events-table-container')
      : active === 'calendar'
        ? document.getElementById('calendar-container')
        : document.getElementById('all-events');
    if (target) target.innerHTML = '<p style="color:red;text-align:center;padding:30px;">Error loading events</p>';
  } finally {
    await (statsPromise || loadStatsCards());
    if (loadVersion === __allEventsLoadVersion) {
      __allEventsProgressiveLoading = false;
      if (getActiveSectionId() === 'events') renderAllEventsList(events);
    }
  }
}

function ensureEventPageToolbar(scope) {
  ensureEventListViewStyles();
  const containerId = scope === 'prepare' ? 'prepare-events' : 'return-events';
  const container = document.getElementById(containerId);
  if (!container) return;
  const toolbarId = `${scope}-events-toolbar`;
  if (document.getElementById(toolbarId)) return;

  const toolbar = document.createElement('div');
  toolbar.id = toolbarId;
  toolbar.className = 'event-view-toolbar';
  toolbar.innerHTML = `
    <div class="event-view-toggle">
      <button class="btn btn-secondary active" id="${scope}CardViewBtn" onclick="setEventPageView('${scope}', 'card')">▦ Card View</button>
      <button class="btn btn-secondary" id="${scope}ListViewBtn" onclick="setEventPageView('${scope}', 'list')">☰ List View</button>
    </div>
    <label style="display:flex;align-items:center;gap:8px;color:#555;font-size:13px;">
      Sort by
      <select id="${scope}EventsSortSelect" class="form-input" style="width:auto;min-width:160px;" onchange="${scope === 'prepare' ? 'loadPrepareEvents()' : 'loadReturnEvents()'}">
        <option value="startDate">Start Date</option>
        <option value="eventId">Event ID</option>
      </select>
    </label>
  `;
  container.parentNode.insertBefore(toolbar, container);
}

function getEventPageView(scope) {
  return localStorage.getItem(`${scope}EventsView`) || 'card';
}

function setEventPageView(scope, view) {
  localStorage.setItem(`${scope}EventsView`, view);
  if (scope === 'return') loadReturnEvents();
}

function updateEventPageToolbarState(scope) {
  const view = getEventPageView(scope);
  document.getElementById(`${scope}CardViewBtn`)?.classList.toggle('active', view === 'card');
  document.getElementById(`${scope}ListViewBtn`)?.classList.toggle('active', view === 'list');
}

async function loadReturnEvents(options = {}) {
  return loadReturnWorkspace(options);
}

window.__preparePendingActions = window.__preparePendingActions || {};
let __prepareUiSyncTimer = null;

function prepareButtonsForAsset(assetId, includeSource = false) {
  const encodedAssetId = encodeURIComponent(String(assetId || ''));
  const root = document.getElementById('prepareEventContent') || document;
  return Array.from(root.querySelectorAll('[data-asset-id], [data-prepare-source-id]')).filter(button => (
    button.dataset.assetId === encodedAssetId ||
    (includeSource && button.dataset.prepareSourceId === encodedAssetId)
  ));
}

function beginPrepareAssetAction(assetId, label = 'Working...') {
  const key = String(assetId || '');
  if (!key || window.__preparePendingActions[key]) return false;
  window.__preparePendingActions[key] = true;
  prepareButtonsForAsset(key, true).forEach(button => {
    button.disabled = true;
    button.style.opacity = '0.65';
    button.dataset.preparePreviousText = button.textContent;
    button.textContent = label;
  });
  return true;
}

function endPrepareAssetAction(assetId) {
  delete window.__preparePendingActions[String(assetId || '')];
}

function updatePrepareRowStatus(button, assetId, isPrepared) {
  let assetRow = button.parentElement;
  while (assetRow && !assetRow.querySelector('div[style*="margin-top: 2px"], div[style*="margin-top:2px"]')) {
    assetRow = assetRow.parentElement;
  }
  if (!assetRow) return;

  const statusText = assetRow.querySelector('div[style*="margin-top: 2px"], div[style*="margin-top:2px"]');
  if (statusText) {
    statusText.textContent = isPrepared ? 'Prepared' : 'Pending';
    statusText.style.color = isPrepared ? '#28a745' : '#ffc107';
  }

  const assetNameSpan = assetRow.querySelector('span');
  if (assetNameSpan && assetNameSpan.textContent.includes(assetId)) {
    assetNameSpan.dataset.prepareState = isPrepared ? 'prepared' : 'pending';
  }
}

function updateAllButtonsForAsset(assetId, isPrepared, options = {}) {
  const sourceAssetId = String(options.sourceAssetId || assetId || '');
  const effectiveAssetId = String(assetId || sourceAssetId);
  const buttons = prepareButtonsForAsset(effectiveAssetId, true)
    .concat(sourceAssetId === effectiveAssetId ? [] : prepareButtonsForAsset(sourceAssetId, true))
    .filter((button, index, all) => all.indexOf(button) === index);

  buttons.forEach(button => {
    button.disabled = false;
    button.style.opacity = '1';
    delete button.dataset.preparePreviousText;

    if (isPrepared) {
      button.textContent = 'Unprepare';
      button.classList.remove('btn-success', 'btn-secondary');
      button.classList.add('btn-warning', 'asset-action-btn');
      button.dataset.assetId = encodeURIComponent(effectiveAssetId);
      button.dataset.action = 'unprepare';
      button.removeAttribute('onclick');
      button.onclick = null;
    } else {
      button.textContent = 'Prepare';
      button.classList.remove('btn-warning', 'btn-secondary');
      button.classList.add('btn-success');

      const assignSourceId = button.dataset.prepareSourceId
        ? decodeURIComponent(button.dataset.prepareSourceId)
        : '';
      if (assignSourceId) {
        const buttonEventId = Number(button.dataset.eventId || window.currentPrepareEventId);
        const brand = button.dataset.prepareBrand || '';
        const model = button.dataset.prepareModel || '';
        button.classList.remove('asset-action-btn');
        delete button.dataset.action;
        button.removeAttribute('onclick');
        button.onclick = () => assignSpecificAsset(buttonEventId, assignSourceId, brand, model);
      } else {
        button.classList.add('asset-action-btn');
        button.dataset.assetId = encodeURIComponent(effectiveAssetId);
        button.dataset.action = 'prepare';
        button.removeAttribute('onclick');
        button.onclick = null;
      }
    }

    updatePrepareRowStatus(button, effectiveAssetId, isPrepared);
  });
}

function prepareModelProgress(group) {
  const required = Math.max(0, Number(group?.requiredQuantity || 0));
  const prepared = Math.max(0, Number(
    group?.countablePreparedQuantity ??
    getCountablePreparedQuantity(group || {})
  ));
  return { required, prepared };
}

function applyPrepareCanonicalProgress(event) {
  if (!event || Number(event.id) !== Number(window.currentPrepareEventId)) return;
  window.__currentPrepareEventData = event;
  const root = document.getElementById('prepareEventContent') || document;

  const requiredEl = document.getElementById('prepare-required-count');
  const preparedEl = document.getElementById('prepare-prepared-count');
  const extraEl = document.getElementById('prepare-extra-count');
  if (requiredEl) requiredEl.textContent = String(event.totalAssets ?? 0);
  if (preparedEl) preparedEl.textContent = String(event.totalPrepared ?? 0);
  if (extraEl) extraEl.textContent = String(getEventExtraQuantity(event));

  const modelGroups = Object.values(event.modelGroups || {});
  root.querySelectorAll('[data-prepare-model-key]').forEach(section => {
    const group = modelGroups.find(item => (
      `${item.department || ''}|${item.brand || ''}|${item.model || ''}` === section.dataset.prepareModelKey
    ));
    if (!group) return;
    const { required, prepared } = prepareModelProgress(group);
    const color = prepared >= required && required > 0 ? '#28a745' : '#ffc107';
    const text = section.querySelector('.prepare-model-progress-text');
    const bar = section.querySelector('.prepare-model-progress-bar');
    if (text) {
      text.textContent = `${prepared}/${required} prepared`;
      text.style.color = color;
    }
    if (bar) {
      bar.style.width = `${required > 0 ? Math.min(100, Math.round((prepared / required) * 100)) : 0}%`;
      bar.style.background = color;
    }
  });

  const customByDepartment = groupCustomAssetsByDepartment(event);
  root.querySelectorAll('[data-prepare-department]').forEach(section => {
    const department = section.dataset.prepareDepartment || '';
    const modelTotals = modelGroups
      .filter(group => normalizeDepartmentCode(group.department || 'UN') === department)
      .reduce((totals, group) => {
        const progress = prepareModelProgress(group);
        totals.required += progress.required;
        totals.prepared += progress.prepared;
        return totals;
      }, { required: 0, prepared: 0 });
    const customAssets = customByDepartment[department] || [];
    const required = modelTotals.required + getCustomRequiredQuantityForProgress(customAssets);
    const prepared = modelTotals.prepared + getCustomPreparedQuantityForProgress(customAssets);
    const color = prepared >= required && required > 0 ? '#28a745' : '#ffc107';
    const text = section.querySelector('.prepare-dept-progress-text');
    const bar = section.querySelector('.prepare-dept-progress-bar');
    if (text) {
      text.textContent = `${prepared}/${required} prepared`;
      text.style.color = color;
    }
    if (bar) {
      bar.style.width = `${required > 0 ? Math.min(100, Math.round((prepared / required) * 100)) : 0}%`;
      bar.style.background = color;
    }
  });
}

function schedulePrepareUiSync(eventId, delay = 600) {
  clearTimeout(__prepareUiSyncTimer);
  __prepareUiSyncTimer = setTimeout(async () => {
    if (
      typeof prepareScanQueueState !== 'undefined' && (
        prepareScanQueueState.processing
        || prepareScanQueueState.queue.length > 0
        || Date.now() - Number(prepareScanQueueState.lastInputAt || 0) < 250
      )
    ) {
      schedulePrepareUiSync(eventId, 300);
      return;
    }
    if (
      document.getElementById('prepare-new-section')?.classList.contains('active') &&
      document.querySelector('.prepare-new-action-menu.open')
    ) {
      schedulePrepareUiSync(eventId, 800);
      return;
    }
    try {
      if (
        document.getElementById('prepare-new-section')?.classList.contains('active') &&
        Number(prepareNewPageState.eventId) === Number(eventId)
      ) {
        await refreshPrepareNewSelectedEvent({ preserve: true });
      } else {
        const response = await apiCall(`/api/events/${eventId}`);
        applyPrepareCanonicalProgress(response.data || {});
      }
    } catch (error) {
      console.warn('Quiet prepare UI sync failed:', error);
    }
  }, delay);
}

async function prepareSpecificAsset(eventId, assetId, requestData = {}) {
  let actionStarted = false;
  try {
    const { skipUiSync = false, ...apiRequestData } = requestData || {};
    await ensureAssetsLoaded();
    if (!(await confirmDegradedAssetUse(assetId))) {
      updateAllButtonsForAsset(assetId, false);
      return false;
    }
    actionStarted = beginPrepareAssetAction(assetId, 'Preparing...');
    if (!actionStarted) return false;
    const response = await apiCall(`/api/events/${eventId}/prepare`, 'POST', {
      assetId,
      ...apiRequestData
    });
    await showApiWarning(response);
    const preparedAssetId = response?.data?.assetId || assetId;
    showNotification('success', `${customAssetLabelFromId(preparedAssetId)} marked as prepared`);
    updateAllButtonsForAsset(preparedAssetId, true, { sourceAssetId: assetId });
    if (!skipUiSync) schedulePrepareUiSync(eventId);
    return preparedAssetId;
  } catch (error) {
    console.error('Error in prepareSpecificAsset:', error);
    showNotification('error', `Failed to prepare asset: ${error.message}`);
    updateAllButtonsForAsset(assetId, false);
    return false;
  } finally {
    if (actionStarted) endPrepareAssetAction(assetId);
  }
}

async function unprepareSpecificAsset(eventId, assetId, requestData = {}) {
  if (!beginPrepareAssetAction(assetId, 'Unpreparing...')) return false;
  try {
    const { skipUiSync = false, ...apiRequestData } = requestData || {};
    await apiCall(`/api/events/${eventId}/unprepare`, 'POST', {
      assetId,
      ...apiRequestData
    });
    showNotification('success', `${customAssetLabelFromId(assetId)} unprepared`);
    updateAllButtonsForAsset(assetId, false);
    if (!skipUiSync) schedulePrepareUiSync(eventId);
    return true;
  } catch (error) {
    console.error('Error in unprepareSpecificAsset:', error);
    showNotification('error', `Failed to unprepare asset: ${error.message}`);
    updateAllButtonsForAsset(assetId, true);
    return false;
  } finally {
    endPrepareAssetAction(assetId);
  }
}

function parseContainerBulkPreparedMarker(value) {
  const match = String(value || '').match(/^\[BULK\]([^|]+)\|(\d+)(?:\|([^|]+))?$/);
  if (!match) return null;
  return {
    bulkId: match[1],
    quantity: Math.max(1, Number.parseInt(match[2], 10) || 1),
    subprojectId: String(match[3] || '')
  };
}

function eventContainerBulkQuantity(event, bulkId, subprojectId = '', returned = false) {
  const returnedRefs = new Set(event?.returnedItems || []);
  return (event?.actuallyPrepared || []).reduce((sum, ref) => {
    const marker = parseContainerBulkPreparedMarker(ref);
    if (!marker || marker.bulkId !== bulkId) return sum;
    if (subprojectId && marker.subprojectId !== String(subprojectId)) return sum;
    if (returnedRefs.has(ref) !== returned) return sum;
    return sum + marker.quantity;
  }, 0);
}

async function processUniversalContainer(eventId, containerOrId, scannedValue = '') {
  const feedbackDiv = document.getElementById('universal-asset-feedback');
  const input = document.getElementById('universalAssetInput');
  const quickAddEnabled = getPrepareQuickAddEnabled();
  const containerLookup = typeof containerOrId === 'object'
    ? String(containerOrId?.id || '')
    : String(containerOrId || '');
  const container = typeof containerOrId === 'object'
    ? containerOrId
    : await getContainerById(containerLookup, false);
  if (!container) {
    if (feedbackDiv) showFeedback(feedbackDiv, 'error', `Container ${containerLookup} not found`);
    return;
  }

  const containerLabel = container.id || containerLookup;
  const assetIds = (container.assetIds || []).map(a => String(a || '').trim()).filter(Boolean);
  const bulkItems = containerBulkItems(container);
  const total = assetIds.length + bulkItems.reduce((sum, item) => sum + item.quantity, 0);
  if (!total) {
    if (feedbackDiv) showFeedback(feedbackDiv, 'warning', `Container ${containerLabel} has no assets`);
    return;
  }

  if (feedbackDiv) {
    showFeedback(
      feedbackDiv,
      'info',
      `Processing container <strong>${escapeHtml(containerLabel)}</strong> (${total} asset units)…<br>` +
      (quickAddEnabled
        ? `Scanned container assets will be added into this event.`
        : `Extra container assets will remain listed as extra assets.`)
    );
  }

  const event = (
    Number(prepareNewPageState.eventId) === Number(eventId)
      ? prepareNewPageState.event
      : window.__currentPrepareEventData
  ) || {};

  const preparedSet = new Set(event.actuallyPrepared || []);
  const returnedSet = new Set(event.returnedItems || []);
  const activeSubprojectId = (
    Number(prepareNewPageState.eventId) === Number(eventId)
      ? eventActiveSubproject(prepareNewPageState, prepareNewPageState.event)?.id || ''
      : ''
  );
  const results = {
    prepared: [], addedToEvent: [], extra: [], skippedPrepared: [], skippedReturned: [], failed: [],
    preparedQuantity: 0, addedToEventQuantity: 0, extraQuantity: 0,
    skippedPreparedQuantity: 0, skippedReturnedQuantity: 0, failedQuantity: 0
  };

  window.__processingContainerBatch = true;
  prepareNewPageState.suppressRealtimeUntil = Date.now() + 5000;
  try {
    for (const aid of assetIds) {
      if (returnedSet.has(aid)) { results.skippedReturned.push(aid); results.skippedReturnedQuantity += 1; continue; }
      if (preparedSet.has(aid)) { results.skippedPrepared.push(aid); results.skippedPreparedQuantity += 1; continue; }
      try {
        await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', {
          quickAdd: quickAddEnabled,
          addScannedAssetsToEvent: quickAddEnabled,
          assetId: aid,
          fromContainer: true,
          source: quickAddEnabled ? 'quick-add-container' : 'container',
          subprojectId: activeSubprojectId
        }).then((response) => {
          updateAllButtonsForAsset(response?.data?.assetId || aid, true, { sourceAssetId: aid });
          if (response?.data?.isExtra) {
            results.extra.push(aid);
            results.extraQuantity += 1;
          } else {
            results.addedToEvent.push(aid);
            results.addedToEventQuantity += 1;
          }
        });
        results.prepared.push(aid);
        results.preparedQuantity += 1;
        preparedSet.add(aid);
      } catch (err) {
        results.failed.push({ id: aid, error: err?.message || String(err) });
        results.failedQuantity += 1;
      }
    }

    for (const item of bulkItems) {
      const asset = getAssetFromCache(item.assetId);
      const label = [asset?.brand, asset?.model].filter(Boolean).join(' ') || 'Bulk asset';
      const returnedQuantity = eventContainerBulkQuantity(
        event,
        item.assetId,
        activeSubprojectId,
        true
      );
      const returnedFromContainer = Math.min(item.quantity, returnedQuantity);
      if (returnedFromContainer > 0) {
        results.skippedReturned.push(`${returnedFromContainer}x ${label}`);
        results.skippedReturnedQuantity += returnedFromContainer;
      }

      const alreadyPrepared = eventContainerBulkQuantity(
        event,
        item.assetId,
        activeSubprojectId,
        false
      );
      const activeContainerQuantity = Math.max(0, item.quantity - returnedFromContainer);
      const quantity = Math.max(0, activeContainerQuantity - alreadyPrepared);
      if (alreadyPrepared > 0) {
        const skipped = Math.min(activeContainerQuantity, alreadyPrepared);
        results.skippedPrepared.push(`${skipped}x ${label}`);
        results.skippedPreparedQuantity += skipped;
      }
      if (quantity <= 0) continue;

      try {
        const response = await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', {
          quickAdd: quickAddEnabled,
          addScannedAssetsToEvent: quickAddEnabled,
          assetId: item.assetId,
          quantity,
          fromContainer: true,
          source: quickAddEnabled ? 'quick-add-container' : 'container',
          subprojectId: activeSubprojectId
        });
        const preparedQuantity = Math.max(
          1,
          Number(response?.data?.preparedQuantity || quantity)
        );
        const preparedLabel = `${preparedQuantity}x ${label}`;
        results.prepared.push(preparedLabel);
        results.preparedQuantity += preparedQuantity;
        updateAllButtonsForAsset(
          response?.data?.assetId || item.assetId,
          true,
          { sourceAssetId: item.assetId }
        );
        if (response?.data?.isExtra) {
          results.extra.push(preparedLabel);
          results.extraQuantity += preparedQuantity;
        } else {
          results.addedToEvent.push(preparedLabel);
          results.addedToEventQuantity += preparedQuantity;
        }
      } catch (err) {
        results.failed.push({ id: `${quantity}x ${label}`, error: err?.message || String(err) });
        results.failedQuantity += quantity;
      }
    }
  } finally {
    window.__processingContainerBatch = false;
    clearWorkflowScanInput(input, scannedValue || containerLookup);
  }

  const failed = results.failedQuantity;
  playWorkflowTone(failed ? 'error' : 'success');
  const listToHtml = (title, items) => items && items.length ? `
    <section class="prepare-new-container-list">
      <h5>${escapeHtml(title)}</h5>
      <ul>${items.slice(0, 50).map(item => `<li>${escapeHtml(String(item))}</li>`).join('')}</ul>
      ${items.length > 50 ? `<small>...and ${items.length - 50} more</small>` : ''}
    </section>
  ` : '';
  const failuresToHtml = (items) => items && items.length ? `
    <section class="prepare-new-container-list">
      <h5 class="prepare-new-container-failure">Failures</h5>
      ${items.slice(0, 30).map(item => `
        <div class="prepare-new-container-failure">${escapeHtml(item.id)} - ${escapeHtml(item.error)}</div>
      `).join('')}
      ${items.length > 30 ? `<small>...and ${items.length - 30} more failures</small>` : ''}
    </section>
  ` : '';

  const detailsHtml = `
    <div class="prepare-new-container-result">
      <div class="prepare-new-container-title">
        <strong>Container ${escapeHtml(containerLabel)}</strong>
        <span>${results.preparedQuantity} / ${total} prepared</span>
      </div>
      <dl class="prepare-new-container-stats">
        <div><dt>Added into event requirements</dt><dd>${results.addedToEventQuantity}</dd></div>
        <div><dt>Extra assets</dt><dd>${results.extraQuantity}</dd></div>
        <div><dt>Already prepared</dt><dd>${results.skippedPreparedQuantity}</dd></div>
        <div><dt>Returned in this event</dt><dd>${results.skippedReturnedQuantity}</dd></div>
        <div class="${failed ? 'has-failures' : ''}"><dt>Failed</dt><dd>${failed}</dd></div>
      </dl>
      <details class="prepare-new-container-details" ${failed ? 'open' : ''}>
        <summary>Asset details</summary>
        <div class="prepare-new-container-detail-scroll">
          ${failuresToHtml(results.failed)}
          ${listToHtml('Prepared / added', results.prepared)}
          ${listToHtml('Added into event requirements', results.addedToEvent)}
          ${listToHtml('Extra assets', results.extra)}
          ${listToHtml('Skipped (already prepared)', results.skippedPrepared)}
          ${listToHtml('Skipped (returned)', results.skippedReturned)}
        </div>
      </details>
    </div>
  `;

  if (feedbackDiv) {
    showFeedback(feedbackDiv, failed ? 'warning' : 'success', detailsHtml);
    requestAnimationFrame(() => feedbackDiv.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest'
    }));
  }
  schedulePrepareUiSync(eventId, 350);
}






(function initialisePatchedEventViews() {
  document.addEventListener('DOMContentLoaded', () => {
    ensureAllEventsViewTabs();
    const eventSearch = document.getElementById('event-search');
    if (eventSearch) eventSearch.oninput = () => renderAllEventsList(events);
  });
})();
