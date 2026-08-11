const workforceScheduleState = {
  showRates: false,
  coverageMode: 'pax',
  department: 'all',
  bulkDay: 'all',
  bulkDepartment: 'all',
  bulkTime: '08:00',
  exportScope: 'event',
  exportValue: '',
  saving: false
};

function wfScheduleIcon(name) {
  const paths = {
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M16 3v4M8 3v4M3 10h18"></path>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18"></path>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"></path>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"></path>',
    plus: '<path d="M12 5v14M5 12h14"></path>',
    clock: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
    chevronDown: '<path d="m6 9 6 6 6-6"></path>',
    check: '<path d="m5 12 4 4L19 6"></path>'
  };
  return `<svg class="wf-schedule-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.list}</svg>`;
}

function wfWorkforceViewSwitchHtml() {
  return `<div class="wf-view-switch" role="group" aria-label="Manpower view">
    <button type="button" class="${workforcePageState.viewMode === 'assignments' ? 'active' : ''}"
      onclick="setWorkforceViewMode('assignments')">By department</button>
    <button type="button" class="${workforcePageState.viewMode === 'schedule' ? 'active' : ''}"
      onclick="setWorkforceViewMode('schedule')">By day</button>
  </div>`;
}

function setWorkforceViewMode(mode) {
  workforcePageState.viewMode = mode === 'schedule' ? 'schedule' : 'assignments';
  if (typeof syncWorkforceRoute === 'function') syncWorkforceRoute();
  renderWorkforcePage();
}

function resetWorkforceScheduleFilters() {
  workforceScheduleState.department = 'all';
  workforceScheduleState.bulkDay = 'all';
  workforceScheduleState.bulkDepartment = 'all';
}

function applyWorkforceRealtimeCallTimes(payload) {
  const details = payload?.details || {};
  const candidates = [
    details,
    ...(Array.isArray(details.changes)
      ? details.changes
        .filter(change => change?.topic === 'workforce')
        .map(change => change.details || {})
      : [])
  ];
  const updates = candidates.flatMap(row =>
    Array.isArray(row.updates) ? row.updates : []
  );
  if (!updates.length || !workforcePageState.data) return false;
  const assignments = new Map(
    (workforcePageState.data.assignments || []).map(row => [String(row.id), row])
  );
  updates.forEach(update => {
    const assignment = assignments.get(String(update.assignmentId || ''));
    const date = String(update.date || '');
    if (!assignment || !date) return;
    assignment.callTimes ||= {};
    if (update.callTime) assignment.callTimes[date] = update.callTime;
    else delete assignment.callTimes[date];
  });
  if (workforcePageState.viewMode === 'schedule') renderWorkforcePage();
  return true;
}

function wfScheduleDates() {
  const dates = new Set(
    typeof wfEventDateOptions === 'function' ? wfEventDateOptions() : []
  );
  wfScheduleRows().forEach(row => {
    (row.workDates || []).forEach(date => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) dates.add(String(date));
    });
  });
  return [...dates].sort();
}

function wfScheduleRows() {
  return (workforcePageState.data?.assignments || []).filter(row => !(
    String(row.subjectType || '') === 'vendor' &&
    String(row.providerType || '') === 'service'
  ));
}

function wfScheduleSubject(row) {
  const type = String(row?.subjectType || '').toLowerCase();
  if (type === 'app-user') {
    const user = wfFindAppUser(row.userUsername) || {};
    return {
      id: wfAssignmentSubjectId(row),
      name: user.name || row.userUsername || 'Unknown app user',
      phone: user.phone || '',
      type: 'staff'
    };
  }
  if (type === 'vendor' || row?.vendorId) {
    const vendor = wfFindVendor(row.vendorId) || {};
    return {
      id: String(row.vendorId || ''),
      name: vendor.name || 'Unknown vendor',
      phone: vendor.phone || '',
      type: 'vendor'
    };
  }
  const worker = wfFindFreelancer(row?.freelancerId) || {};
  return {
    id: String(row?.freelancerId || ''),
    name: worker.name || 'Unknown worker',
    phone: worker.phone || '',
    type: 'freelancer'
  };
}

function wfScheduleDateLabel(value, options = {}) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-SG', {
    day: 'numeric', month: options.short ? 'short' : 'long',
    year: options.year ? 'numeric' : undefined,
    weekday: options.weekday ? 'short' : undefined
  });
}

function wfScheduleVisibleRows() {
  const department = workforceScheduleState.department;
  return wfScheduleRows().filter(row =>
    department === 'all' || String(
      row.department || (row.subjectType === 'app-user' ? 'FT' : '')
    ) === department
  );
}

function wfScheduleDepartments() {
  const codes = new Set(wfScheduleRows().map(row =>
    row.department || (row.subjectType === 'app-user' ? 'FT' : '')
  ).filter(Boolean));
  return [...codes].sort((a, b) => {
    if (a === 'FT') return -1;
    if (b === 'FT') return 1;
    return wfDepartmentMeta(a).name.localeCompare(wfDepartmentMeta(b).name);
  });
}

function wfScheduleSortRows(rows) {
  return [...rows].sort((a, b) => {
    const aDepartment = a.department || (a.subjectType === 'app-user' ? 'FT' : '');
    const bDepartment = b.department || (b.subjectType === 'app-user' ? 'FT' : '');
    if (aDepartment === 'FT' && bDepartment !== 'FT') return -1;
    if (bDepartment === 'FT' && aDepartment !== 'FT') return 1;
    const departmentOrder = wfDepartmentMeta(aDepartment).name.localeCompare(
      wfDepartmentMeta(bDepartment).name
    );
    return departmentOrder || wfScheduleSubject(a).name.localeCompare(wfScheduleSubject(b).name);
  });
}

function wfScheduleCrewCount(rows, date = '') {
  const people = new Set();
  let vendorPax = 0;
  rows.forEach(row => {
    if (date && !(row.workDates || []).includes(date)) return;
    if (row.subjectType === 'vendor') vendorPax += Number(row.pax || 0);
    else people.add(wfAssignmentSubjectId(row));
  });
  return people.size + vendorPax;
}

function wfScheduleDayCost(rows, date = '') {
  return rows.reduce((total, row) => {
    if (date && !(row.workDates || []).includes(date)) return total;
    if (row.subjectType === 'vendor') {
      return total + Number(row.pax || 0) * Number(row.ratePerPax || 0);
    }
    return total + Number(row.dailyRate || 0);
  }, 0);
}

function wfScheduleCoverageValue(rows, date) {
  return workforceScheduleState.coverageMode === 'cost'
    ? wfMoney(wfScheduleDayCost(rows, date))
    : String(wfScheduleCrewCount(rows, date));
}

function wfScheduleCoverageTotal(rows, dates) {
  const total = dates.reduce((sum, date) => sum + (
    workforceScheduleState.coverageMode === 'cost'
      ? wfScheduleDayCost(rows, date)
      : wfScheduleCrewCount(rows, date)
  ), 0);
  return workforceScheduleState.coverageMode === 'cost' ? wfMoney(total) : String(total);
}

function wfScheduleMetricHtml(icon, value, label) {
  return `<div class="wf-schedule-metric"><span>${wfScheduleIcon(icon)}</span>
    <div><strong>${wfEscape(value)}</strong><small>${wfEscape(label)}</small></div></div>`;
}

function wfScheduleRate(row) {
  if (!workforceScheduleState.showRates) return '';
  if (row.subjectType === 'vendor') {
    return row.ratePerPax == null ? 'Rate not set' : `${wfMoney(row.ratePerPax)}/pax/day`;
  }
  return row.dailyRate == null ? 'Rate not set' : `${wfMoney(row.dailyRate)}/day`;
}

function wfScheduleStaffCard(row, date) {
  const subject = wfScheduleSubject(row);
  const departmentCode = row.department || (row.subjectType === 'app-user' ? 'FT' : '');
  const department = wfDepartmentMeta(departmentCode);
  const callTime = String(row.callTimes?.[date] || '');
  const role = row.roleName || (row.subjectType === 'vendor' ? `${Number(row.pax || 0)} pax manpower` : 'Role not set');
  return `<article class="wf-schedule-person" style="${wfDepartmentStyle(departmentCode)}"
    role="button" tabindex="0" title="Open event assignment"
    onclick="if(!event.target.closest('input,button,label'))openWorkforceScheduledAssignment('${wfAttr(row.id)}')"
    onkeydown="if((event.key==='Enter'||event.key===' ')&&!event.target.closest('input,button')){event.preventDefault();openWorkforceScheduledAssignment('${wfAttr(row.id)}')}">
    <div class="wf-schedule-person-main">
      <span class="wf-avatar ${subject.type}">${wfEscape(wfInitials(subject.name))}</span>
      <div><strong>${wfEscape(subject.name)}</strong><small>${wfEscape(role)}</small>
        ${wfScheduleRate(row) ? `<small class="wf-schedule-rate">${wfEscape(wfScheduleRate(row))}</small>` : ''}</div>
      <span class="wf-schedule-dept" title="${wfAttr(department.name)}">${wfEscape(department.code)}</span>
    </div>
    <div class="wf-schedule-person-meta">
      <label title="Set call time for this assignment on ${wfAttr(wfScheduleDateLabel(date))}">
        ${wfScheduleIcon('clock')}
        <input type="time" value="${wfAttr(callTime)}" data-assignment-id="${wfAttr(row.id)}" data-date="${wfAttr(date)}"
          onchange="updateWorkforceCallTime('${wfAttr(row.id)}','${wfAttr(date)}',this.value,this)">
      </label>
      <button type="button" class="wf-schedule-person-download" title="Open individual schedule PDF"
        onclick="event.stopPropagation();downloadWorkforceSchedule('worker','${wfAttr(subject.id)}')">${wfScheduleIcon('download')}</button>
    </div>
  </article>`;
}

function openWorkforceScheduledAssignment(assignmentId) {
  const row = wfScheduleRows().find(item => String(item.id) === String(assignmentId));
  if (!row) return;
  if (row.subjectType === 'app-user') {
    openFullTimeStaffAssignment(row.id);
  } else if (row.subjectType === 'vendor' || row.vendorId) {
    openVendorAssignment(row.vendorId, row.department, row.id);
  } else {
    openFreelancerAssignment(row.freelancerId, row.department, row.id);
  }
}

function wfScheduleDayBoardHtml() {
  const rows = wfScheduleVisibleRows();
  return `<div class="wf-schedule-days" id="wfScheduleDays">${wfScheduleDates().map(date => {
    const dateRows = wfScheduleSortRows(rows.filter(row => (row.workDates || []).includes(date)));
    return `<section class="wf-schedule-day">
      <header><div><strong>${wfEscape(wfScheduleDateLabel(date, { short: true }))}</strong>
        <small>${wfEscape(wfScheduleDateLabel(date, { weekday: true }).split(',')[0])}</small></div>
        <div><span class="wf-day-crew-count">${wfScheduleCrewCount(dateRows)} crew</span>
          <button type="button" class="wf-icon-button add" title="Add worker or vendor to this day"
            onclick="openWorkforceDayStaffPicker('${wfAttr(date)}')">${wfScheduleIcon('plus')}</button>
          <button type="button" class="wf-icon-button" title="Open this day's schedule PDF"
            onclick="downloadWorkforceSchedule('date','${wfAttr(date)}')">${wfScheduleIcon('download')}</button></div></header>
      <div class="wf-schedule-day-call">Call times set individually or above</div>
      <div class="wf-schedule-day-list">${dateRows.length
        ? dateRows.map(row => wfScheduleStaffCard(row, date)).join('')
        : '<div class="wf-schedule-empty">No crew assigned</div>'}</div>
    </section>`;
  }).join('')}</div>`;
}

function wfScheduleCoverageHtml() {
  const dates = wfScheduleDates();
  const rows = wfScheduleRows();
  const departments = wfScheduleDepartments();
  return `<div class="wf-schedule-lower">
    <section class="wf-schedule-summary-card"><h3>Call Time Summary</h3>
      <div class="wf-call-summary">${dates.map(date => {
        const dateRows = rows.filter(row => (row.workDates || []).includes(date));
        const times = [...new Set(dateRows.map(row => row.callTimes?.[date] || ''))];
        const defaultTime = times.length === 1
          ? (times[0] || 'Not set')
          : (times.length ? 'Multiple' : 'Not set');
        return `<div><span>${wfEscape(wfScheduleDateLabel(date, { short: true, weekday: true }))}</span><strong>${wfEscape(defaultTime)}</strong></div>`;
      }).join('')}</div>
    </section>
    <section class="wf-schedule-summary-card coverage"><header class="wf-coverage-heading"><h3>Daily Department Coverage</h3>
      <div class="wf-coverage-toggle" role="group" aria-label="Coverage values">
        <button type="button" class="${workforceScheduleState.coverageMode === 'pax' ? 'active' : ''}" onclick="setWorkforceCoverageMode('pax')">Pax</button>
        <button type="button" class="${workforceScheduleState.coverageMode === 'cost' ? 'active' : ''}" onclick="setWorkforceCoverageMode('cost')">Cost</button>
      </div></header>
      <div class="wf-coverage-scroll"><table><thead><tr><th>Department</th>${dates.map(date => `<th>${wfEscape(wfScheduleDateLabel(date, { short: true }))}</th>`).join('')}<th>Event Total</th></tr></thead>
        <tbody>${departments.map(code => {
          const departmentRows = rows.filter(row => String(row.department || (row.subjectType === 'app-user' ? 'FT' : '')) === code);
          return `<tr><th><span class="wf-schedule-dept" style="${wfDepartmentStyle(code)}">${wfEscape(code)}</span></th>${dates.map(date => `<td>${wfEscape(wfScheduleCoverageValue(departmentRows, date))}</td>`).join('')}<td class="event-total">${wfEscape(wfScheduleCoverageTotal(departmentRows, dates))}</td></tr>`;
        }).join('')}
          <tr class="total"><th>${workforceScheduleState.coverageMode === 'cost' ? 'Total Cost' : 'Total Crew'}</th>${dates.map(date => `<td>${wfEscape(wfScheduleCoverageValue(rows, date))}</td>`).join('')}<td class="event-total">${wfEscape(wfScheduleCoverageTotal(rows, dates))}</td></tr></tbody></table></div>
    </section>
  </div>`;
}

function wfScheduleDepartmentFiltersHtml() {
  const departments = wfScheduleDepartments();
  return `<div class="wf-schedule-filter-row"><span>Department</span>
    <button type="button" class="${workforceScheduleState.department === 'all' ? 'active' : ''}" onclick="setWorkforceScheduleDepartment('all')">All</button>
    ${departments.map(code => `<button type="button" style="${wfDepartmentStyle(code)}" class="dept ${workforceScheduleState.department === code ? 'active' : ''}" onclick="setWorkforceScheduleDepartment('${wfAttr(code)}')">${wfEscape(code)}</button>`).join('')}
  </div>`;
}

function wfScheduleCustomSelectHtml(id, label, value, options) {
  const selected = options.find(option => option.value === value) || options[0];
  const selectedSwatch = selected.color
    ? `<i class="wf-schedule-select-swatch" style="--wf-option-color:${wfAttr(selected.color)}"></i>`
    : '';
  return `<div class="wf-schedule-select-field"><span>${wfEscape(label)}</span>
    <div class="wf-schedule-select" id="${wfAttr(id)}" data-value="${wfAttr(selected.value)}">
      <button type="button" class="wf-schedule-select-trigger" aria-haspopup="listbox" aria-expanded="false"
        onclick="toggleWorkforceScheduleSelect('${wfAttr(id)}',event)">
        <span class="wf-schedule-select-value">${selectedSwatch}<b>${wfEscape(selected.label)}</b></span>
        ${wfScheduleIcon('chevronDown')}
      </button>
      <div class="wf-schedule-select-menu" role="listbox" aria-label="${wfAttr(label)}">
        ${options.map(option => `<button type="button" class="wf-schedule-select-option ${option.value === selected.value ? 'selected' : ''}"
          role="option" aria-selected="${option.value === selected.value}" data-value="${wfAttr(option.value)}"
          onclick="chooseWorkforceScheduleSelect(this,event)">
          <span class="wf-schedule-option-label">${option.color ? `<i class="wf-schedule-select-swatch" style="--wf-option-color:${wfAttr(option.color)}"></i>` : ''}<b>${wfEscape(option.label)}</b></span>
          ${wfScheduleIcon('check')}</button>`).join('')}
      </div>
    </div>
  </div>`;
}

function closeWorkforceScheduleSelects(exceptId = '') {
  document.querySelectorAll('.wf-schedule-select.is-open').forEach(select => {
    if (select.id === exceptId) return;
    select.classList.remove('is-open');
    select.querySelector('.wf-schedule-select-trigger')?.setAttribute('aria-expanded', 'false');
  });
}

function toggleWorkforceScheduleSelect(id, event) {
  event?.stopPropagation();
  const select = document.getElementById(id);
  if (!select) return;
  const willOpen = !select.classList.contains('is-open');
  closeWorkforceScheduleSelects();
  select.classList.toggle('is-open', willOpen);
  select.querySelector('.wf-schedule-select-trigger')?.setAttribute('aria-expanded', String(willOpen));
}

function chooseWorkforceScheduleSelect(option, event) {
  event?.stopPropagation();
  const select = option?.closest('.wf-schedule-select');
  if (!select) return;
  const value = String(option.dataset.value || 'all');
  if (select.id === 'wfScheduleBulkDay') workforceScheduleState.bulkDay = value;
  if (select.id === 'wfScheduleBulkDepartment') workforceScheduleState.bulkDepartment = value;
  select.dataset.value = value;
  select.querySelector('.wf-schedule-select-value').innerHTML =
    option.querySelector('.wf-schedule-option-label')?.innerHTML || '';
  select.querySelectorAll('.wf-schedule-select-option').forEach(row => {
    const selected = row === option;
    row.classList.toggle('selected', selected);
    row.setAttribute('aria-selected', String(selected));
  });
  closeWorkforceScheduleSelects();
  select.querySelector('.wf-schedule-select-trigger')?.focus();
}

function renderWorkforceSchedulePage(root, data) {
  const boardScroll = document.getElementById('wfScheduleDays')?.scrollLeft || 0;
  const content = root.closest('.content-area');
  const pageScroll = content?.scrollTop || 0;
  const rows = wfScheduleRows();
  const people = new Set(rows.filter(row => row.subjectType !== 'vendor').map(wfAssignmentSubjectId));
  const vendors = new Set(rows.filter(row => row.subjectType === 'vendor').map(wfAssignmentSubjectId));
  const dates = wfScheduleDates();
  const eventDates = data.event.startDate === data.event.endDate
    ? data.event.startDate
    : [data.event.startDate, data.event.endDate].filter(Boolean).join(' - ');
  const departments = wfScheduleDepartments();
  if (!dates.includes(workforceScheduleState.bulkDay)) workforceScheduleState.bulkDay = 'all';
  if (!departments.includes(workforceScheduleState.bulkDepartment)) workforceScheduleState.bulkDepartment = 'all';
  const dayOptions = [
    { value: 'all', label: 'All Days' },
    ...dates.map(date => ({
      value: date,
      label: wfScheduleDateLabel(date, { short: true, weekday: true })
    }))
  ];
  const departmentOptions = [
    { value: 'all', label: 'All Departments' },
    ...departments.map(code => {
      const department = wfDepartmentMeta(code);
      return { value: code, label: department.name, color: department.color };
    })
  ];
  root.innerHTML = `<div class="wf-schedule-page">
    <header class="wf-schedule-title"><div><h2>Manpower Schedule</h2>
      <p>See who is assigned each day, by department and role.</p></div>
      <div class="wf-schedule-actions">
        <button type="button" class="wf-button" onclick="downloadWorkforceSchedule('event')">${wfScheduleIcon('download')} Export Event Schedule</button>
        ${wfWorkforceViewSwitchHtml()}
      </div></header>
    <section class="wf-schedule-event-card">
      <button type="button" class="wf-schedule-event" onclick="openWorkforceEventChooser()">
        <span>${wfScheduleIcon('calendar')}</span><div><strong>${wfEscape(data.event.name)}</strong>
          <small>${wfEscape(eventDates)}${data.event.location ? ` &middot; ${wfEscape(data.event.location)}` : ''}</small></div></button>
      <div class="wf-schedule-metrics">
        ${wfScheduleMetricHtml('users', wfScheduleCrewCount(rows), 'Total Crew')}
        ${wfScheduleMetricHtml('briefcase', vendors.size, 'Total Vendors')}
        ${wfScheduleMetricHtml('list', rows.reduce((sum, row) => sum + (row.workDates || []).length, 0), 'Assignments')}
        ${wfScheduleMetricHtml('calendar', dates.length, 'Schedule Days')}
      </div>
    </section>
    <section class="wf-schedule-controls"><strong>Call Time Controls</strong>
      ${wfScheduleCustomSelectHtml('wfScheduleBulkDay', 'Day', workforceScheduleState.bulkDay, dayOptions)}
      ${wfScheduleCustomSelectHtml('wfScheduleBulkDepartment', 'Department', workforceScheduleState.bulkDepartment, departmentOptions)}
      <label><span>Call Time</span><input id="wfScheduleBulkTime" type="time" value="${wfAttr(workforceScheduleState.bulkTime)}" onchange="workforceScheduleState.bulkTime=this.value"></label>
      <button type="button" class="wf-button primary" onclick="applyWorkforceBulkCallTime(false)">Apply to All Staff</button>
      <button type="button" class="wf-button" onclick="applyWorkforceBulkCallTime(true)">Apply to Department</button>
      <label class="wf-rate-toggle"><span>Show Rates</span><input type="checkbox" ${workforceScheduleState.showRates ? 'checked' : ''} onchange="toggleWorkforceScheduleRates(this.checked)"><i></i></label>
    </section>
    ${wfScheduleDepartmentFiltersHtml()}
    <section id="wfScheduleBoard">${wfScheduleDayBoardHtml()}</section>
    ${wfScheduleCoverageHtml()}
  </div>`;
  requestAnimationFrame(() => {
    const board = document.getElementById('wfScheduleDays');
    if (board) board.scrollLeft = boardScroll;
    if (content) content.scrollTop = pageScroll;
  });
}

function setWorkforceScheduleDepartment(code) {
  workforceScheduleState.department = code || 'all';
  renderWorkforcePage();
}

function toggleWorkforceScheduleRates(checked) {
  workforceScheduleState.showRates = Boolean(checked);
  renderWorkforcePage();
}

function setWorkforceCoverageMode(mode) {
  workforceScheduleState.coverageMode = mode === 'cost' ? 'cost' : 'pax';
  renderWorkforcePage();
}

async function updateWorkforceCallTime(assignmentId, date, callTime, input) {
  const assignment = wfScheduleRows().find(row => String(row.id) === String(assignmentId));
  if (!assignment) return;
  const previous = assignment.callTimes?.[date] || '';
  assignment.callTimes ||= {};
  if (callTime) assignment.callTimes[date] = callTime;
  else delete assignment.callTimes[date];
  input?.classList.add('saving');
  try {
    await apiCall(`/api/events/${workforcePageState.eventId}/workforce/schedule/call-times`, 'PATCH', {
      updates: [{ assignmentId, date, callTime }]
    });
    input?.classList.add('saved');
    setTimeout(() => input?.classList.remove('saved'), 700);
  } catch (error) {
    if (previous) assignment.callTimes[date] = previous;
    else delete assignment.callTimes[date];
    if (input) input.value = previous;
    showNotification('error', error.message);
  } finally {
    input?.classList.remove('saving');
  }
}

async function applyWorkforceBulkCallTime(departmentOnly) {
  if (workforceScheduleState.saving) return;
  const day = workforceScheduleState.bulkDay || 'all';
  const department = workforceScheduleState.bulkDepartment || 'all';
  const callTime = document.getElementById('wfScheduleBulkTime')?.value || '';
  if (!callTime) {
    showNotification('warning', 'Choose a call time first');
    return;
  }
  if (departmentOnly && department === 'all') {
    showNotification('warning', 'Choose a department first');
    return;
  }
  const updates = [];
  wfScheduleRows().forEach(row => {
    const rowDepartment = row.department || (row.subjectType === 'app-user' ? 'FT' : '');
    if (departmentOnly && rowDepartment !== department) return;
    (row.workDates || []).forEach(date => {
      if (day === 'all' || day === date) updates.push({ assignmentId: row.id, date, callTime });
    });
  });
  if (!updates.length) {
    showNotification('warning', 'No matching assignments were found');
    return;
  }
  workforceScheduleState.saving = true;
  try {
    await apiCall(`/api/events/${workforcePageState.eventId}/workforce/schedule/call-times`, 'PATCH', { updates });
    updates.forEach(update => {
      const row = wfScheduleRows().find(item => String(item.id) === String(update.assignmentId));
      if (row) (row.callTimes ||= {})[update.date] = callTime;
    });
    renderWorkforcePage();
    showNotification('success', `Updated ${updates.length} call time${updates.length === 1 ? '' : 's'}`);
  } catch (error) {
    showNotification('error', error.message);
  } finally {
    workforceScheduleState.saving = false;
  }
}

document.addEventListener('click', event => {
  if (!event.target.closest('.wf-schedule-select')) closeWorkforceScheduleSelects();
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const trigger = document.querySelector('.wf-schedule-select.is-open .wf-schedule-select-trigger');
  closeWorkforceScheduleSelects();
  trigger?.focus();
});

function downloadWorkforceSchedule(scope = 'event', value = '') {
  ensureWorkforceScheduleExportModal();
  workforceScheduleState.exportScope = scope;
  workforceScheduleState.exportValue = value;
  document.getElementById('wfScheduleExportPhones').checked = false;
  document.getElementById('wfScheduleExportRates').checked = false;
  openWorkforceModal('wfScheduleExportModal');
}

function ensureWorkforceScheduleExportModal() {
  if (document.getElementById('wfScheduleExportModal')) return;
  ensureWorkforceModals();
  document.body.insertAdjacentHTML('beforeend', wfModal(
    'wfScheduleExportModal',
    'Export manpower schedule',
    `<form onsubmit="confirmWorkforceScheduleExport(event)">
      <div class="wf-modal-body"><div class="wf-schedule-export-options">
        <label class="wf-schedule-export-option"><span>Phone numbers</span>
          <input id="wfScheduleExportPhones" type="checkbox"><i aria-hidden="true"></i></label>
        <label class="wf-schedule-export-option"><span>Rates</span>
          <input id="wfScheduleExportRates" type="checkbox"><i aria-hidden="true"></i></label>
      </div></div>
      <footer class="wf-modal-actions"><button type="button" class="wf-button" onclick="closeWorkforceModal('wfScheduleExportModal')">Cancel</button>
        <button type="submit" class="wf-button primary">Open PDF</button></footer>
    </form>`
  ));
}

function confirmWorkforceScheduleExport(event) {
  event.preventDefault();
  const scope = workforceScheduleState.exportScope || 'event';
  const value = workforceScheduleState.exportValue || '';
  const params = new URLSearchParams({ scope });
  if (scope === 'worker') params.set('subjectId', value);
  if (scope === 'date') params.set('date', value);
  if (document.getElementById('wfScheduleExportPhones')?.checked) params.set('showPhones', '1');
  if (document.getElementById('wfScheduleExportRates')?.checked) params.set('showRates', '1');
  closeWorkforceModal('wfScheduleExportModal');
  const preview = window.open(
    `/api/events/${workforcePageState.eventId}/workforce/schedule.pdf?${params}`,
    '_blank'
  );
  if (preview) preview.opener = null;
  else showNotification('warning', 'Allow pop-ups to preview the schedule PDF');
}

function ensureFullTimeStaffModal() {
  if (document.getElementById('wfFullTimeStaffModal')) return;
  ensureWorkforceModals();
  document.body.insertAdjacentHTML('beforeend', wfModal('wfFullTimeStaffModal', 'Add Full-time Staff', `<form id="wfFullTimeStaffForm">
    <div class="wf-modal-body"><div class="wf-form-grid">
      <label class="wf-field full"><span>App user *</span><select id="wfFullTimeStaffUser" required></select></label>
      <label class="wf-field wf-room-field full"><span>Room / Sub-project *</span><select id="wfFullTimeStaffRoom"></select></label>
      <label class="wf-field"><span>Department *</span><select id="wfFullTimeStaffDepartment" required></select></label>
      <label class="wf-field"><span>Role / Position</span><input id="wfFullTimeStaffRole" maxlength="100"></label>
      <div class="wf-field full"><span>Working dates *</span><div class="wf-date-calendar" id="wfFullTimeStaffDates"></div></div>
      <label class="wf-field"><span>Daily rate ($)</span><input id="wfFullTimeStaffRate" type="number" min="0" step=".01"></label>
      <label class="wf-field"><span>Initial call time</span><input id="wfFullTimeStaffCallTime" type="time"></label>
    </div><p class="wf-help">Full-time staff can submit claims. Invoice uploads start with zero slots; an admin can add one when needed.</p>
    <div class="wf-error" id="wfFullTimeStaffError"></div></div>
    <footer class="wf-modal-actions"><button type="button" class="wf-button" onclick="closeWorkforceModal('wfFullTimeStaffModal')">Cancel</button>
      <button type="submit" class="wf-button primary">Add Staff</button></footer></form>`, '', true));
  document.getElementById('wfFullTimeStaffForm').addEventListener('submit', saveFullTimeStaffAssignment);
}

function ensureWorkforceDayStaffModal() {
  if (document.getElementById('wfScheduleDayStaffModal')) return;
  ensureWorkforceModals();
  document.body.insertAdjacentHTML('beforeend', wfModal(
    'wfScheduleDayStaffModal',
    'Add Worker or Vendor',
    `<div class="wf-modal-body"><div class="wf-directory-toolbar">
      <input class="wf-search" id="wfScheduleDayStaffSearch" type="search" placeholder="Search full-time staff, workers or vendors"
        oninput="renderWorkforceDayStaffPicker(this.value)">
    </div><p class="wf-help" id="wfScheduleDayStaffDate"></p>
    <div class="wf-schedule-staff-picker" id="wfScheduleDayStaffList"></div></div>`,
    '', true
  ));
}

function openWorkforceDayStaffPicker(date) {
  ensureWorkforceDayStaffModal();
  const modal = document.getElementById('wfScheduleDayStaffModal');
  modal.dataset.date = date;
  document.getElementById('wfScheduleDayStaffSearch').value = '';
  document.getElementById('wfScheduleDayStaffDate').textContent =
    `The new assignment will start with ${wfScheduleDateLabel(date, { weekday: true })} selected.`;
  renderWorkforceDayStaffPicker('');
  openWorkforceModal('wfScheduleDayStaffModal');
}

function renderWorkforceDayStaffPicker(search = '') {
  const root = document.getElementById('wfScheduleDayStaffList');
  if (!root) return;
  const needle = String(search || '').trim().toLowerCase();
  const rows = [
    ...(workforcePageState.data?.appUsers || []).map(row => ({
      id: row.username, name: row.name || row.username, detail: 'Full-time app user', type: 'app-user'
    })),
    ...(workforcePageState.data?.freelancers || []).filter(row => row.active !== false).map(row => ({
      id: row.id, name: row.name, detail: wfFormatPhone(row.phone) || 'Worker', type: 'worker'
    })),
    ...(workforcePageState.data?.vendors || []).filter(row => row.active !== false).map(row => ({
      id: row.id, name: row.name, detail: 'Vendor manpower', type: 'vendor'
    }))
  ].filter(row => !needle || `${row.name} ${row.detail}`.toLowerCase().includes(needle));
  root.innerHTML = rows.map(row => `<button type="button" onclick="chooseWorkforceDayStaff('${wfAttr(row.type)}','${wfAttr(row.id)}')">
    <span class="wf-avatar ${row.type === 'app-user' ? 'staff' : row.type}">${wfEscape(wfInitials(row.name))}</span>
    <span><strong>${wfEscape(row.name)}</strong><small>${wfEscape(row.detail)}</small></span>
    ${wfScheduleIcon('plus')}</button>`).join('') || '<div class="wf-schedule-empty">No matching staff or vendors.</div>';
}

function chooseWorkforceDayStaff(type, id) {
  const date = document.getElementById('wfScheduleDayStaffModal')?.dataset.date || '';
  workforcePageState.assignmentPrefillDates = date ? [date] : [];
  closeWorkforceModal('wfScheduleDayStaffModal');
  if (type === 'app-user') openFullTimeStaffAssignment('', id);
  else if (type === 'vendor') openVendorAssignment(id);
  else openFreelancerAssignment(id);
}

function openFullTimeStaffAssignment(assignmentId = '', username = '', department = '') {
  ensureFullTimeStaffModal();
  const assignment = (workforcePageState.data?.assignments || []).find(row =>
    String(row.id) === String(assignmentId) && row.subjectType === 'app-user'
  );
  workforcePageState.editingAssignmentId = assignment?.id || null;
  const form = document.getElementById('wfFullTimeStaffForm');
  form.reset();
  const userSelect = document.getElementById('wfFullTimeStaffUser');
  userSelect.innerHTML = '<option value="">Select an app user</option>' +
    (workforcePageState.data?.appUsers || []).map(user => `<option value="${wfAttr(user.username)}">${wfEscape(user.name)} (${wfEscape(user.username)})</option>`).join('');
  userSelect.value = assignment?.userUsername || username || '';
  userSelect.disabled = Boolean(assignment);
  wfPopulateSubprojectSelect('wfFullTimeStaffRoom', assignment?.subprojectId);
  const departmentSelect = document.getElementById('wfFullTimeStaffDepartment');
  const selectedDepartment = assignment?.department || department || 'FT';
  departmentSelect.innerHTML = `<option value="FT" ${selectedDepartment === 'FT' ? 'selected' : ''}>Full-time (no department)</option>` +
    wfDepartmentOptions(selectedDepartment);
  wfTintDepartmentSelect(departmentSelect);
  document.getElementById('wfFullTimeStaffRole').value = assignment?.roleName || '';
  document.getElementById('wfFullTimeStaffRate').value = assignment?.dailyRate ?? '';
  document.getElementById('wfFullTimeStaffCallTime').value = '';
  document.getElementById('wfFullTimeStaffCallTime').disabled = Boolean(assignment);
  document.getElementById('wfFullTimeStaffDates').innerHTML = wfDateCalendarHtml(
    assignment?.workDates?.length
      ? assignment.workDates
      : (workforcePageState.assignmentPrefillDates.length
        ? workforcePageState.assignmentPrefillDates
        : wfScheduleDates()),
    workforcePageState.data?.workerDateConflicts?.[wfAssignmentSubjectId(assignment || { subjectType: 'app-user', userUsername: username })] || {}
  );
  workforcePageState.assignmentPrefillDates = [];
  document.getElementById('wfFullTimeStaffModalTitle').textContent = assignment ? 'Edit Full-time Assignment' : 'Add Full-time Staff';
  form.querySelector('[type="submit"]').textContent = assignment ? 'Save Assignment' : 'Add Staff';
  wfError('wfFullTimeStaffError');
  closeWorkforceModal('wfFreelancerDirectoryModal');
  openWorkforceModal('wfFullTimeStaffModal');
}

async function saveFullTimeStaffAssignment(event) {
  event.preventDefault();
  const dates = wfSelectedCalendarDates('wfFullTimeStaffDates');
  if (!dates.length) {
    wfError('wfFullTimeStaffError', 'Select at least one working date.');
    return;
  }
  const assignmentId = workforcePageState.editingAssignmentId;
  const body = {
    username: document.getElementById('wfFullTimeStaffUser').value,
    subprojectId: document.getElementById('wfFullTimeStaffRoom').value,
    department: document.getElementById('wfFullTimeStaffDepartment').value,
    roleName: document.getElementById('wfFullTimeStaffRole').value,
    customRole: document.getElementById('wfFullTimeStaffRole').value,
    workDates: dates,
    days: dates.length,
    dailyRate: document.getElementById('wfFullTimeStaffRate').value,
    callTime: document.getElementById('wfFullTimeStaffCallTime').value
  };
  try {
    const response = await apiCall(
      assignmentId
        ? `/api/events/${workforcePageState.eventId}/workforce/assignments/${encodeURIComponent(assignmentId)}`
        : `/api/events/${workforcePageState.eventId}/workforce/staff-assignments`,
      assignmentId ? 'PUT' : 'POST', body
    );
    workforcePageState.data = response.data;
    closeWorkforceModal('wfFullTimeStaffModal');
    renderWorkforcePage();
    showNotification('success', assignmentId ? 'Full-time assignment updated' : 'Full-time staff added');
  } catch (error) {
    wfError('wfFullTimeStaffError', error.message);
  }
}
