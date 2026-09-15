const workforceScheduleState = {
  showRates: false,
  coverageMode: 'pax',
  department: 'all',
  bulkDay: 'all',
  bulkDepartment: 'all',
  bulkTime: '08:00',
  exportScope: 'event',
  exportValue: '',
  saving: false,
  tagMenuTrigger: null
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
  return `<div class="wf-view-switch" role="group" aria-label="Crew and vendors view">
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

function applyWorkforceRealtimeScheduleUpdates(payload) {
  const details = payload?.details || {};
  const candidates = [
    details,
    ...(Array.isArray(details.changes)
      ? details.changes
        .filter(change => change?.topic === 'workforce')
        .map(change => change.details || {})
      : [])
  ];
  if (candidates.some(row => row.structureChanged)) return false;
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
    if (Object.prototype.hasOwnProperty.call(update, 'callTime')) {
      assignment.callTimes ||= {};
      if (update.callTime) assignment.callTimes[date] = update.callTime;
      else delete assignment.callTimes[date];
    }
    if (Object.prototype.hasOwnProperty.call(update, 'department')) {
      assignment.dateDepartments ||= {};
      if (String(update.department || '') === String(assignment.department || '')) {
        delete assignment.dateDepartments[date];
      } else {
        assignment.dateDepartments[date] = String(update.department || '');
      }
    }
    if (Object.prototype.hasOwnProperty.call(update, 'roleName')) {
      assignment.dateRoles ||= {};
      if (String(update.roleName || '') === String(assignment.roleName || '')) {
        delete assignment.dateRoles[date];
      } else {
        assignment.dateRoles[date] = String(update.roleName || '');
      }
    }
  });
  if (workforcePageState.viewMode === 'schedule') renderWorkforcePage();
  return true;
}

function applyWorkforceRealtimeCallTimes(payload) {
  return applyWorkforceRealtimeScheduleUpdates(payload);
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

function wfScheduleDateValue(row, field, date, fallback = '') {
  const values = row?.[field];
  const dateKey = String(date || '');
  if (values && Object.prototype.hasOwnProperty.call(values, dateKey)) {
    return String(values[dateKey] ?? '');
  }
  return String(fallback ?? '');
}

function wfScheduleDepartment(row, date = '') {
  return wfScheduleDateValue(
    row,
    'dateDepartments',
    date,
    row?.department || (row?.subjectType === 'app-user' ? 'FT' : '')
  );
}

function wfScheduleRole(row, date = '') {
  const fallback = row?.roleName || (
    row?.subjectType === 'vendor'
      ? `${Number(row?.pax || 0)} pax manpower`
      : 'Role not set'
  );
  return wfScheduleDateValue(row, 'dateRoles', date, fallback) || 'Role not set';
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

function wfScheduleQuotationLabel(date) {
  const labels = workforcePageState.data?.event?.quotationScheduleLabels?.[date];
  return Array.isArray(labels)
    ? labels.map(label => String(label || '').trim()).filter(Boolean).join(' · ')
    : '';
}

function wfScheduleQuotationLabelHtml(date, className = '') {
  const label = wfScheduleQuotationLabel(date);
  return label
    ? `<small class="wf-schedule-day-purpose ${wfAttr(className)}">${wfEscape(label)}</small>`
    : '';
}

function wfScheduleVisibleRows() {
  const department = workforceScheduleState.department;
  return wfScheduleRows().filter(row =>
    department === 'all' || (row.workDates || []).some(date =>
      wfScheduleDepartment(row, date) === department
    )
  );
}

function wfScheduleDepartments() {
  const codes = new Set();
  wfScheduleRows().forEach(row => (row.workDates || []).forEach(date => {
    const code = wfScheduleDepartment(row, date);
    if (code) codes.add(code);
  }));
  return [...codes].sort((a, b) => {
    if (a === 'FT') return -1;
    if (b === 'FT') return 1;
    return wfDepartmentMeta(a).name.localeCompare(wfDepartmentMeta(b).name);
  });
}

function wfScheduleSortRows(rows, date = '') {
  return [...rows].sort((a, b) => {
    const rooms = wfSubprojects();
    const roomOrder = row => {
      const index = rooms.findIndex(room =>
        String(room.id || '') === String(wfEffectiveSubprojectId(row) || '')
      );
      return index < 0 ? rooms.length : index;
    };
    const subprojectOrder = roomOrder(a) - roomOrder(b);
    if (subprojectOrder) return subprojectOrder;
    const aDepartment = wfScheduleDepartment(a, date);
    const bDepartment = wfScheduleDepartment(b, date);
    if (aDepartment === 'FT' && bDepartment !== 'FT') return -1;
    if (bDepartment === 'FT' && aDepartment !== 'FT') return 1;
    const departmentOrder = wfDepartmentMeta(aDepartment).name.localeCompare(
      wfDepartmentMeta(bDepartment).name
    );
    return departmentOrder || wfScheduleSubject(a).name.localeCompare(wfScheduleSubject(b).name);
  });
}

function wfScheduleRoomSelectHtml(row, date) {
  const rooms = wfSubprojects();
  if (rooms.length <= 1) return '';
  const selectedId = wfEffectiveSubprojectId(row);
  const selected = rooms.find(room => String(room.id) === selectedId) || rooms[0];
  const label = String(selected?.name || 'Venue').trim().split(/\s+/)[0] || 'Venue';
  return `<button type="button" class="wf-schedule-room" style="${wfRoomChipStyle(row)}"
    aria-label="Change assigned venue" aria-haspopup="listbox" aria-expanded="false"
    title="${wfAttr(selected.name || 'Venue')} — change assigned venue"
    onclick="toggleWorkforceScheduleRoomMenu(event,'${wfAttr(row.id)}','${wfAttr(date)}')">${wfEscape(label)}</button>`;
}

function closeWorkforceScheduleTagMenu(refocus = false) {
  document.getElementById('wfScheduleTagMenu')?.remove();
  const trigger = workforceScheduleState.tagMenuTrigger;
  trigger?.setAttribute('aria-expanded', 'false');
  workforceScheduleState.tagMenuTrigger = null;
  if (refocus && trigger?.isConnected) trigger.focus();
}

function openWorkforceScheduleTagMenu(trigger, kind, assignmentId, date, label, options) {
  closeWorkforceScheduleTagMenu();
  closeWorkforceScheduleSelects();
  document.body.insertAdjacentHTML('beforeend', `<div class="wf-schedule-tag-menu" id="wfScheduleTagMenu"
    data-kind="${wfAttr(kind)}" data-assignment-id="${wfAttr(assignmentId)}" data-date="${wfAttr(date || '')}"
    role="listbox" aria-label="${wfAttr(label)}">${options.map(option =>
      `<button type="button" role="option" aria-selected="${option.selected}" class="${option.selected ? 'selected' : ''}"
        onclick="chooseWorkforceScheduleTag(event,'${wfAttr(kind)}','${wfAttr(assignmentId)}','${wfAttr(date || '')}','${wfAttr(option.value)}')">
        ${option.badge || ''}<span>${wfEscape(option.label)}</span>${wfScheduleIcon('check')}</button>`
    ).join('')}</div>`);
  positionWorkforceScheduleTagMenu(trigger);
}

function positionWorkforceScheduleTagMenu(trigger) {
  const menu = document.getElementById('wfScheduleTagMenu');
  if (!menu || !trigger) return;
  const rect = showbaseViewport.rect(trigger.getBoundingClientRect());
  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(rect.left, showbaseViewport.width() - menuWidth - 8))}px`;
  menu.style.top = `${rect.bottom + menuHeight + 6 <= showbaseViewport.height()
    ? rect.bottom + 4
    : Math.max(8, rect.top - menuHeight - 4)}px`;
  workforceScheduleState.tagMenuTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
}

function toggleWorkforceScheduleRoomMenu(event, assignmentId, date) {
  event?.preventDefault();
  event?.stopPropagation();
  const trigger = event?.currentTarget;
  if (!trigger) return;
  if (
    document.getElementById('wfScheduleTagMenu')?.dataset.kind === 'room' &&
    workforceScheduleState.tagMenuTrigger === trigger
  ) {
    closeWorkforceScheduleTagMenu(true);
    return;
  }
  const assignment = wfScheduleRows().find(row => String(row.id) === String(assignmentId));
  if (!assignment) return;
  const selectedId = wfEffectiveSubprojectId(assignment);
  openWorkforceScheduleTagMenu(
    trigger,
    'room',
    assignmentId,
    date,
    'Assigned venue',
    wfSubprojects().map(room => ({
      value: room.id,
      label: room.name || 'Venue',
      selected: String(room.id) === selectedId
    }))
  );
}

function wfScheduleDepartmentOptions(assignment) {
  const rows = [
    ...(workforcePageState.data?.allDepartments || [])
      .filter(isSelectableCompanyDepartment)
  ];
  if (assignment?.subjectType === 'app-user' && !rows.some(row => row.code === 'FT')) {
    rows.unshift({ code: 'FT', name: 'Full-time (no department)', color: '#e2e8f0', textColor: '#334155' });
  }
  return rows;
}

function toggleWorkforceScheduleDepartmentMenu(event, assignmentId, date) {
  event?.preventDefault();
  event?.stopPropagation();
  const trigger = event?.currentTarget;
  if (!trigger) return;
  if (
    document.getElementById('wfScheduleTagMenu')?.dataset.kind === 'department' &&
    workforceScheduleState.tagMenuTrigger === trigger
  ) {
    closeWorkforceScheduleTagMenu(true);
    return;
  }
  const assignment = wfScheduleRows().find(row => String(row.id) === String(assignmentId));
  if (!assignment) return;
  const selectedCode = wfScheduleDepartment(assignment, date);
  openWorkforceScheduleTagMenu(
    trigger,
    'department',
    assignmentId,
    date,
    'Assigned department',
    wfScheduleDepartmentOptions(assignment).map(row => {
      const meta = wfDepartmentMeta(row.code);
      return {
        value: row.code,
        label: row.name || meta.name,
        selected: row.code === selectedCode,
        badge: `<i class="wf-schedule-tag-menu-badge" style="${wfDepartmentStyle(row.code)}">${wfEscape(meta.code)}</i>`
      };
    })
  );
}

function chooseWorkforceScheduleTag(event, kind, assignmentId, date, value) {
  event?.preventDefault();
  event?.stopPropagation();
  const trigger = workforceScheduleState.tagMenuTrigger;
  closeWorkforceScheduleTagMenu();
  if (kind === 'department') {
    updateWorkforceScheduleDepartment(assignmentId, date, value, trigger);
  } else {
    updateWorkforceAssignmentSubproject(assignmentId, date, value, trigger);
  }
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
  return `<div class="plan-metric wf-schedule-metric"><div class="plan-metric-icon">${wfScheduleIcon(icon)}</div>
    <div><strong>${wfEscape(value)}</strong><span>${wfEscape(label)}</span></div></div>`;
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
  const departmentCode = wfScheduleDepartment(row, date);
  const department = wfDepartmentMeta(departmentCode);
  const callTime = String(row.callTimes?.[date] || '');
  const role = wfScheduleRole(row, date);
  const dateConflicts = (row.dateConflicts || []).filter(conflict => String(conflict.date || '') === String(date));
  const conflictTitle = wfConflictTooltipText(dateConflicts);
  return `<article class="wf-schedule-person ${dateConflicts.length ? 'has-conflict' : ''}" style="${wfDepartmentStyle(departmentCode)}"
    role="button" tabindex="0" title="Open event assignment"
    onclick="if(!event.target.closest('input,button,label'))openWorkforceScheduledAssignment('${wfAttr(row.id)}')"
    onkeydown="if((event.key==='Enter'||event.key===' ')&&!event.target.closest('input,button')){event.preventDefault();openWorkforceScheduledAssignment('${wfAttr(row.id)}')}">
    <div class="wf-schedule-person-main">
      <div><strong>${wfEscape(subject.name)}${dateConflicts.length ? `<span class="wf-schedule-conflict wf-instant-tooltip" data-wf-tooltip="${wfAttr(conflictTitle)}" role="img" aria-label="${wfAttr(`Schedule conflict. ${conflictTitle}`)}">!</span>` : ''}</strong>
        <button type="button" class="wf-schedule-role" title="Rename role for ${wfAttr(wfScheduleDateLabel(date))}"
          aria-haspopup="dialog" aria-expanded="false"
          onclick="openWorkforceScheduleRoleEditor(event,'${wfAttr(row.id)}','${wfAttr(date)}')">${wfEscape(role)}</button>
        ${wfScheduleRate(row) ? `<button type="button" class="wf-schedule-rate wf-schedule-rate-edit" title="Change rate for ${wfAttr(wfScheduleDateLabel(date))}"
          onclick="openWorkforceScheduleRateEditor(event,'${wfAttr(row.id)}','${wfAttr(date)}')">${wfEscape(wfScheduleRate(row))}</button>` : ''}</div>
      <span class="wf-schedule-assignment-tags">
        ${wfScheduleRoomSelectHtml(row, date)}
        <button type="button" class="wf-schedule-dept wf-schedule-dept-edit" title="Change department for ${wfAttr(wfScheduleDateLabel(date))}"
          aria-haspopup="listbox" aria-expanded="false"
          onclick="toggleWorkforceScheduleDepartmentMenu(event,'${wfAttr(row.id)}','${wfAttr(date)}')">${wfEscape(department.name)}</button>
      </span>
    </div>
    <div class="wf-schedule-person-meta">
      <label title="Set call time for this assignment on ${wfAttr(wfScheduleDateLabel(date))}">
        ${wfScheduleIcon('clock')}
        <input type="time" value="${wfAttr(callTime)}" data-assignment-id="${wfAttr(row.id)}" data-date="${wfAttr(date)}"
          onchange="updateWorkforceCallTime('${wfAttr(row.id)}','${wfAttr(date)}',this.value,this)">
      </label>
      <button type="button" class="wf-schedule-person-download" title="Open individual schedule PDF"
        onclick="event.stopPropagation();downloadWorkforceSchedule('worker','${wfAttr(subject.id)}')">${wfScheduleIcon('download')}</button>
      <button type="button" class="wf-schedule-person-remove" title="Remove from ${wfAttr(wfScheduleDateLabel(date))}"
        aria-label="Remove ${wfAttr(subject.name)} from ${wfAttr(wfScheduleDateLabel(date))}"
        onclick="event.stopPropagation();removeWorkforceScheduleDate('${wfAttr(row.id)}','${wfAttr(date)}',this)">&times;</button>
    </div>
  </article>`;
}

async function updateWorkforceAssignmentSubproject(assignmentId, date, subprojectId, trigger) {
  const assignment = wfScheduleRows().find(row => String(row.id) === String(assignmentId));
  if (!assignment || !trigger) return;
  const role = wfScheduleRole(assignment, date);
  const selectedRoom = wfSubprojects().find(room => String(room.id) === String(subprojectId));
  const previousChip = {
    label: trigger.textContent,
    style: trigger.getAttribute('style'),
    title: trigger.getAttribute('title')
  };
  if (selectedRoom) {
    const label = String(selectedRoom.name || 'Venue').trim().split(/\s+/)[0] || 'Venue';
    trigger.textContent = label;
    trigger.setAttribute('style', wfRoomChipStyle({ ...assignment, subprojectId }));
    trigger.setAttribute('title', `${selectedRoom.name || 'Venue'} — saving assigned venue`);
  }
  trigger.disabled = true;
  trigger.classList.add('saving');
  try {
    const response = await apiCall(
      `/api/events/${workforcePageState.eventId}/workforce/assignments/${encodeURIComponent(assignmentId)}/schedule-day`,
      'PATCH',
      {
        date,
        department: wfScheduleDepartment(assignment, date),
        roleName: role === 'Role not set' ? '' : role,
        subprojectId
      }
    );
    workforcePageState.data = response.data.workforce;
    renderWorkforcePage();
    showNotification('success', `Assigned venue updated for ${wfScheduleDateLabel(date)}`);
  } catch (error) {
    trigger.textContent = previousChip.label;
    if (previousChip.style == null) trigger.removeAttribute('style');
    else trigger.setAttribute('style', previousChip.style);
    if (previousChip.title == null) trigger.removeAttribute('title');
    else trigger.setAttribute('title', previousChip.title);
    trigger.disabled = false;
    trigger.classList.remove('saving');
    showNotification('error', error.message);
  }
}

async function removeWorkforceScheduleDate(assignmentId, date, button) {
  const assignment = wfScheduleRows().find(row => String(row.id) === String(assignmentId));
  if (!assignment) return;
  const subject = wfScheduleSubject(assignment);
  const confirmed = await showAppConfirm({
    title: 'Remove from this day?',
    message: `Remove ${subject.name} from ${wfScheduleDateLabel(date, { weekday: true, year: true })}? Other assigned dates will remain unchanged.`,
    confirmText: 'Remove from Day',
    variant: 'danger'
  });
  if (!confirmed) return;
  button.disabled = true;
  try {
    const response = await deleteWorkforceAssignmentRequest(
      workforcePageState.eventId, assignmentId, false, date
    );
    workforcePageState.data = response.data;
    renderWorkforcePage();
    showNotification('success', `${subject.name} removed from ${wfScheduleDateLabel(date)}`);
  } catch (error) {
    button.disabled = false;
    showNotification('error', error.message);
  }
}

async function updateWorkforceScheduleDepartment(assignmentId, date, department, trigger) {
  const assignment = wfScheduleRows().find(row => String(row.id) === String(assignmentId));
  if (!assignment || !trigger) return;
  const role = wfScheduleRole(assignment, date);
  trigger.disabled = true;
  trigger.classList.add('saving');
  try {
    const response = await apiCall(
      `/api/events/${workforcePageState.eventId}/workforce/assignments/${encodeURIComponent(assignmentId)}/schedule-day`,
      'PATCH',
      { date, department, roleName: role === 'Role not set' ? '' : role }
    );
    workforcePageState.data = response.data.workforce;
    renderWorkforcePage();
    showNotification('success', `Department updated for ${wfScheduleDateLabel(date)}`);
  } catch (error) {
    trigger.disabled = false;
    trigger.classList.remove('saving');
    showNotification('error', error.message);
  }
}

function wfScheduleRoleUsageKeys(vendorRoles) {
  const keys = new Set();
  (workforcePageState.data?.assignments || []).forEach(row => {
    const isVendor = String(row?.subjectType || '').toLowerCase() === 'vendor' || Boolean(row?.vendorId);
    if (isVendor !== vendorRoles) return;
    const dates = Array.isArray(row.workDates) && row.workDates.length ? row.workDates : [''];
    dates.forEach(date => {
      const department = wfScheduleDepartment(row, date);
      const roleName = wfScheduleDateValue(
        row,
        'dateRoles',
        date,
        row?.roleName || row?.serviceName || ''
      ).trim();
      if (department && roleName) keys.add(`${department}|${roleName.toLowerCase()}`);
    });
  });
  return keys;
}

function wfScheduleRoleSuggestions(department, assignment) {
  if (String(assignment?.subjectType || '').toLowerCase() === 'vendor' || assignment?.vendorId) return [];
  const workerRoleKeys = wfScheduleRoleUsageKeys(false);
  const vendorRoleKeys = wfScheduleRoleUsageKeys(true);
  const names = new Set();
  (workforcePageState.data?.roles || []).forEach(row => {
    if (!row || String(row.department || '') !== String(department || '')) return;
    const name = String(row.name || '').trim();
    if (!name) return;
    const roleType = String(row.type || row.subjectType || '').trim().toLowerCase();
    if (roleType === 'vendor') return;
    const roleKey = `${department}|${name.toLowerCase()}`;
    if (roleType !== 'worker' && vendorRoleKeys.has(roleKey) && !workerRoleKeys.has(roleKey)) return;
    names.add(name);
  });
  return [...names].sort((a, b) => a.localeCompare(b));
}

function openWorkforceScheduleRoleEditor(event, assignmentId, date) {
  event?.preventDefault();
  event?.stopPropagation();
  const trigger = event?.currentTarget;
  if (!trigger) return;
  if (
    document.getElementById('wfScheduleTagMenu')?.dataset.kind === 'role' &&
    workforceScheduleState.tagMenuTrigger === trigger
  ) {
    closeWorkforceScheduleTagMenu(true);
    return;
  }
  closeWorkforceScheduleTagMenu();
  closeWorkforceScheduleSelects();
  const assignment = wfScheduleRows().find(row => String(row.id) === String(assignmentId));
  if (!assignment || !trigger) return;
  const currentRole = wfScheduleRole(assignment, date);
  const subject = wfScheduleSubject(assignment);
  document.body.insertAdjacentHTML('beforeend', `<div class="wf-schedule-tag-menu wf-schedule-role-popover" id="wfScheduleTagMenu"
    data-kind="role" data-assignment-id="${wfAttr(assignmentId)}" data-date="${wfAttr(date)}" role="dialog" aria-label="Rename role">
    <form class="wf-schedule-role-editor" onsubmit="saveWorkforceScheduleRole(event)">
      <div class="wf-schedule-role-context"><strong>Rename role</strong><span>${wfEscape(subject.name)} · ${wfEscape(wfScheduleDateLabel(date))}</span></div>
      <label><span>Role / Position</span><input id="wfScheduleRoleInput" maxlength="100" autocomplete="off" placeholder="Role not set"
        value="${wfAttr(currentRole === 'Role not set' ? '' : currentRole)}" oninput="renderWorkforceScheduleRoleSuggestions(this.value)"></label>
      <div class="wf-schedule-role-suggestions" id="wfScheduleRoleSuggestions"></div>
      <div class="wf-schedule-role-actions"><button type="button" onclick="closeWorkforceScheduleTagMenu(true)">Cancel</button>
        <button type="submit" class="primary">Save</button></div>
    </form></div>`);
  renderWorkforceScheduleRoleSuggestions('');
  positionWorkforceScheduleTagMenu(trigger);
  requestAnimationFrame(() => {
    const input = document.getElementById('wfScheduleRoleInput');
    input?.focus();
    input?.select();
  });
}

function openWorkforceScheduleRateEditor(event, assignmentId, date) {
  event.preventDefault();
  event.stopPropagation();
  closeWorkforceScheduleTagMenu();
  closeWorkforceScheduleSelects();
  const assignment = wfScheduleRows().find(row => String(row.id) === String(assignmentId));
  if (!assignment) return;
  const rate = assignment.subjectType === 'vendor' ? assignment.ratePerPax : assignment.dailyRate;
  document.body.insertAdjacentHTML('beforeend', `<div class="wf-schedule-tag-menu wf-schedule-role-popover" id="wfScheduleTagMenu"
    data-kind="rate" data-assignment-id="${wfAttr(assignmentId)}" data-date="${wfAttr(date)}" role="dialog" aria-label="Change daily rate">
    <form class="wf-schedule-role-editor" onsubmit="saveWorkforceScheduleRate(event)">
      <div class="wf-schedule-role-context"><strong>Change rate for this day</strong><span>${wfEscape(wfScheduleSubject(assignment).name)} · ${wfEscape(wfScheduleDateLabel(date))}</span></div>
      <div class="wf-schedule-rate-field">
        <label for="wfScheduleRateInput"><span>${assignment.subjectType === 'vendor' ? 'Rate per pax / day ($)' : 'Daily rate ($)'}</span></label>
        <div class="wf-schedule-rate-control">
          <input id="wfScheduleRateInput" type="number" min="0" step="0.01" required value="${wfAttr(rate ?? '')}"
            onkeydown="handleWorkforceScheduleRateArrow(event)">
          <span class="wf-schedule-rate-arrows">
            <button type="button" aria-label="Increase rate by $10" title="Increase by $10" onclick="adjustWorkforceScheduleRate(1)">&#9650;</button>
            <button type="button" aria-label="Decrease rate by $10" title="Decrease by $10" onclick="adjustWorkforceScheduleRate(-1)">&#9660;</button>
          </span>
        </div>
      </div>
      <div class="wf-schedule-role-actions"><button type="button" onclick="closeWorkforceScheduleTagMenu(true)">Cancel</button><button type="submit" class="primary">Save</button></div>
    </form></div>`);
  positionWorkforceScheduleTagMenu(event.currentTarget);
  document.getElementById('wfScheduleRateInput')?.focus();
}

function adjustWorkforceScheduleRate(direction) {
  const input = document.getElementById('wfScheduleRateInput');
  if (!input) return;
  const current = Number(input.value || 0);
  if (!Number.isFinite(current)) return;
  const cents = Math.round(current * 100);
  const nextCents = Math.max(0, cents + (direction > 0 ? 1000 : -1000));
  input.value = String(nextCents / 100);
  input.focus();
}

function handleWorkforceScheduleRateArrow(event) {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  adjustWorkforceScheduleRate(event.key === 'ArrowUp' ? 1 : -1);
}

async function saveWorkforceScheduleRate(event) {
  event.preventDefault();
  event.stopPropagation();
  const menu = document.getElementById('wfScheduleTagMenu');
  const assignmentId = menu?.dataset.assignmentId;
  const date = menu?.dataset.date;
  const assignment = wfScheduleRows().find(row => String(row.id) === assignmentId);
  const input = document.getElementById('wfScheduleRateInput');
  if (!assignment || !input?.reportValidity()) return;
  const rate = Number(input.value);
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const role = wfScheduleRole(assignment, date);
    const response = await apiCall(`/api/events/${workforcePageState.eventId}/workforce/assignments/${encodeURIComponent(assignmentId)}/schedule-day`, 'PATCH', {
      date, rate, department: wfScheduleDepartment(assignment, date), roleName: role === 'Role not set' ? '' : role
    });
    closeWorkforceScheduleTagMenu();
    workforcePageState.data = response.data.workforce;
    renderWorkforcePage();
    showNotification('success', `Rate updated for ${wfScheduleDateLabel(date)}`);
  } catch (error) {
    button.disabled = false;
    showNotification('error', error.message);
  }
}

function renderWorkforceScheduleRoleSuggestions(search = '') {
  const menu = document.getElementById('wfScheduleTagMenu');
  const root = document.getElementById('wfScheduleRoleSuggestions');
  const assignment = wfScheduleRows().find(row =>
    String(row.id) === String(menu?.dataset.assignmentId || '')
  );
  if (!root || !assignment) return;
  const department = wfScheduleDepartment(assignment, menu.dataset.date || '');
  const needle = String(search || '').trim().toLowerCase();
  const names = wfScheduleRoleSuggestions(department, assignment).filter(name =>
    !needle || name.toLowerCase().includes(needle)
  );
  root.innerHTML = names.length
    ? `<span>Suggested</span>${names.map(name => `<button type="button" onclick="chooseWorkforceScheduleRoleSuggestion('${wfAttr(name)}')">${wfEscape(name)}</button>`).join('')}`
    : '';
}

function chooseWorkforceScheduleRoleSuggestion(roleName) {
  const input = document.getElementById('wfScheduleRoleInput');
  if (!input) return;
  input.value = roleName;
  input.closest('form')?.requestSubmit();
}

async function saveWorkforceScheduleRole(event) {
  event.preventDefault();
  event.stopPropagation();
  const menu = document.getElementById('wfScheduleTagMenu');
  const assignmentId = String(menu?.dataset.assignmentId || '');
  const date = String(menu?.dataset.date || '');
  const assignment = wfScheduleRows().find(row => String(row.id) === assignmentId);
  const trigger = workforceScheduleState.tagMenuTrigger;
  if (!assignment || !trigger || !date) return;
  const currentRole = wfScheduleRole(assignment, date);
  const roleName = String(document.getElementById('wfScheduleRoleInput')?.value || '').trim().slice(0, 100);
  closeWorkforceScheduleTagMenu();
  if (roleName === (currentRole === 'Role not set' ? '' : currentRole)) return;
  trigger.disabled = true;
  trigger.classList.add('saving');
  try {
    const response = await apiCall(
      `/api/events/${workforcePageState.eventId}/workforce/assignments/${encodeURIComponent(assignmentId)}/schedule-day`,
      'PATCH',
      { date, department: wfScheduleDepartment(assignment, date), roleName }
    );
    workforcePageState.data = response.data.workforce;
    renderWorkforcePage();
    showNotification('success', `Role updated for ${wfScheduleDateLabel(date)}`);
  } catch (error) {
    trigger.disabled = false;
    trigger.classList.remove('saving');
    showNotification('error', error.message);
  }
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
    const dateRows = wfScheduleSortRows(rows.filter(row =>
      (row.workDates || []).includes(date) && (
        workforceScheduleState.department === 'all' ||
        wfScheduleDepartment(row, date) === workforceScheduleState.department
      )
    ), date);
    return `<section class="wf-schedule-day">
      <header><div class="wf-schedule-day-heading"><span><strong>${wfEscape(wfScheduleDateLabel(date, { short: true }))}</strong>
        <small>${wfEscape(wfScheduleDateLabel(date, { weekday: true }).split(',')[0])}</small></span>
        ${wfScheduleQuotationLabelHtml(date)}</div>
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
      <div class="wf-coverage-scroll"><table><thead><tr><th>Department</th>${dates.map(date => `<th><span>${wfEscape(wfScheduleDateLabel(date, { short: true }))}</span>${wfScheduleQuotationLabelHtml(date, 'table')}</th>`).join('')}<th>Event Total</th></tr></thead>
        <tbody>${departments.map(code => {
          const dateRows = date => rows.filter(row =>
            (row.workDates || []).includes(date) && wfScheduleDepartment(row, date) === code
          );
          const total = dates.reduce((sum, date) => sum + (
            workforceScheduleState.coverageMode === 'cost'
              ? wfScheduleDayCost(dateRows(date), date)
              : wfScheduleCrewCount(dateRows(date), date)
          ), 0);
          const totalLabel = workforceScheduleState.coverageMode === 'cost' ? wfMoney(total) : String(total);
          return `<tr><th><span class="wf-schedule-dept" style="${wfDepartmentStyle(code)}">${wfEscape(wfDepartmentMeta(code).name)}</span></th>${dates.map(date => `<td>${wfEscape(wfScheduleCoverageValue(dateRows(date), date))}</td>`).join('')}<td class="event-total">${wfEscape(totalLabel)}</td></tr>`;
        }).join('')}
          <tr class="total"><th>${workforceScheduleState.coverageMode === 'cost' ? 'Total Cost' : 'Total Crew'}</th>${dates.map(date => `<td>${wfEscape(wfScheduleCoverageValue(rows, date))}</td>`).join('')}<td class="event-total">${wfEscape(wfScheduleCoverageTotal(rows, dates))}</td></tr></tbody></table></div>
    </section>
  </div>`;
}

function wfScheduleDepartmentFiltersHtml() {
  const departments = wfScheduleDepartments();
  return `<div class="wf-schedule-filter-row">
    <div class="wf-schedule-filter-options"><span>Department</span>
      <button type="button" class="${workforceScheduleState.department === 'all' ? 'active' : ''}" onclick="setWorkforceScheduleDepartment('all')">All</button>
      ${departments.map(code => `<button type="button" style="${wfDepartmentStyle(code)}" class="dept ${workforceScheduleState.department === code ? 'active' : ''}" onclick="setWorkforceScheduleDepartment('${wfAttr(code)}')">${wfEscape(wfDepartmentMeta(code).name)}</button>`).join('')}
    </div>
    <button type="button" class="wf-button primary wf-schedule-manage-directory" onclick="openFreelancerDirectory('manage')">Manage Workers/Vendors</button>
  </div>`;
}

function wfScheduleCustomSelectHtml(id, label, value, options) {
  const selected = options.find(option => option.value === value) || options[0];
  const selectedMarker = selected.badge || (selected.color
    ? `<i class="wf-schedule-select-swatch" style="--wf-option-color:${wfAttr(selected.color)}"></i>`
    : '');
  return `<div class="wf-schedule-select-field"><span>${wfEscape(label)}</span>
    <div class="wf-schedule-select" id="${wfAttr(id)}" data-value="${wfAttr(selected.value)}">
      <button type="button" class="wf-schedule-select-trigger" aria-haspopup="listbox" aria-expanded="false"
        onclick="toggleWorkforceScheduleSelect('${wfAttr(id)}',event)">
        <span class="wf-schedule-select-value">${selectedMarker}<b>${wfEscape(selected.label)}</b></span>
        ${wfScheduleIcon('chevronDown')}
      </button>
      <div class="wf-schedule-select-menu" role="listbox" aria-label="${wfAttr(label)}">
        ${options.map(option => `<button type="button" class="wf-schedule-select-option ${option.value === selected.value ? 'selected' : ''}"
          role="option" aria-selected="${option.value === selected.value}" data-value="${wfAttr(option.value)}"
          onclick="chooseWorkforceScheduleSelect(this,event)">
          <span class="wf-schedule-option-label">${option.badge || (option.color ? `<i class="wf-schedule-select-swatch" style="--wf-option-color:${wfAttr(option.color)}"></i>` : '')}<b>${wfEscape(option.label)}</b></span>
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
  closeWorkforceScheduleTagMenu();
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
      return {
        value: code,
        label: department.name,
        badge: `<i class="wf-schedule-tag-menu-badge" style="${wfDepartmentStyle(code)}">${wfEscape(code)}</i>`
      };
    })
  ];
  root.innerHTML = `<div class="wf-schedule-page">
    <header class="plan-page-heading wf-manpower-page-heading wf-schedule-heading"><div>
      <div class="wf-manpower-title-row"><h2>Crew &amp; Vendors Schedule</h2>
        ${canCurrentUserViewAllInvoiceClaims() ? `<button class="wf-button primary" type="button" onclick="showSection('invoice-claims')">
          View all invoices &amp; claims
        </button>` : ''}
      </div>
      <p>See who is assigned each day, by department and role.</p></div>
      <div class="wf-manpower-heading-actions wf-schedule-actions">
        <button type="button" class="wf-button" onclick="downloadWorkforceSchedule('event')">${wfScheduleIcon('download')} Export Event Schedule</button>
        ${wfWorkforceViewSwitchHtml()}
      </div></header>
    <section class="plan-event-bar wf-schedule-event-bar">
      ${wfManpowerEventPickerHtml(data, 'Choose an event for the crew and vendors schedule')}
      <div class="plan-metrics wf-schedule-metrics">
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
      <button type="button" class="wf-button primary" onclick="applyWorkforceBulkCallTime()">Apply</button>
      <label class="wf-rate-toggle"><span>Show Rates</span><input type="checkbox" ${workforceScheduleState.showRates ? 'checked' : ''} onchange="toggleWorkforceScheduleRates(this.checked)"><i></i></label>
    </section>
    ${wfScheduleDepartmentFiltersHtml()}
    <section id="wfScheduleBoard">${wfScheduleDayBoardHtml()}</section>
    ${wfScheduleCoverageHtml()}
    ${wfCrewTransportCategoryHtml()}
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

async function applyWorkforceBulkCallTime() {
  if (workforceScheduleState.saving) return;
  const day = workforceScheduleState.bulkDay || 'all';
  const department = workforceScheduleState.bulkDepartment || 'all';
  const callTime = document.getElementById('wfScheduleBulkTime')?.value || '';
  if (!callTime) {
    showNotification('warning', 'Choose a call time first');
    return;
  }
  const updates = [];
  wfScheduleRows().forEach(row => {
    (row.workDates || []).forEach(date => {
      if (day !== 'all' && day !== date) return;
      if (department !== 'all' && wfScheduleDepartment(row, date) !== department) return;
      updates.push({ assignmentId: row.id, date, callTime });
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
  if (!event.target.closest('.wf-schedule-tag-menu')) closeWorkforceScheduleTagMenu();
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const trigger = document.querySelector('.wf-schedule-select.is-open .wf-schedule-select-trigger');
  closeWorkforceScheduleSelects();
  if (trigger) trigger.focus();
  else closeWorkforceScheduleTagMenu(true);
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
      <label class="wf-field"><span>Department *</span><select id="wfFullTimeStaffDepartment" data-department-select="true" required></select></label>
      <label class="wf-field wf-room-field"><span>Room / Sub-project *</span><select id="wfFullTimeStaffRoom"></select></label>
      <label class="wf-field"><span>Role / Position</span><input id="wfFullTimeStaffRole" maxlength="100"></label>
      <label class="wf-field"><span>Daily rate ($)</span><input id="wfFullTimeStaffRate" type="number" min="0" step=".01"></label>
      <div class="wf-field full"><span>Working dates *</span><div class="wf-date-calendar" id="wfFullTimeStaffDates"></div></div>
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

function openWorkforceDayStaffPicker(date = '', department = '') {
  ensureWorkforceDayStaffModal();
  const modal = document.getElementById('wfScheduleDayStaffModal');
  modal.dataset.date = date;
  modal.dataset.department = department;
  document.getElementById('wfScheduleDayStaffSearch').value = '';
  document.getElementById('wfScheduleDayStaffDate').textContent = date
    ? `The new assignment will start with ${wfScheduleDateLabel(date, { weekday: true })} selected.`
    : `The new assignment will start in ${department || 'the selected department'}.`;
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
  const modal = document.getElementById('wfScheduleDayStaffModal');
  const date = modal?.dataset.date || '';
  const department = modal?.dataset.department || '';
  workforcePageState.assignmentPrefillDates = date ? [date] : [];
  closeWorkforceModal('wfScheduleDayStaffModal');
  if (type === 'app-user') openFullTimeStaffAssignment('', id, department);
  else if (type === 'vendor') openVendorAssignment(id, department);
  else openFreelancerAssignment(id, department);
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
