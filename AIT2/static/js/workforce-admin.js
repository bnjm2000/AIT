const workforcePageState = {
  eventId: null,
  eventOptions: [],
  data: null,
  loading: false,
  loadRequestId: 0,
  reviewSubmissionId: null,
  denialSubmissionId: null,
  reviewDenialPending: false,
  autoAllocation: false,
  editingFreelancerId: null,
  selectedFreelancerId: null,
  editingAssignmentId: null,
  editingVendorId: null,
  selectedVendorId: null,
  editingVendorAssignmentId: null,
  assignmentPrefillDates: [],
  vendorMemberSelection: new Set(),
  directoryMode: 'manage',
  directorySubject: 'worker',
  directoryDepartment: '',
  historyFreelancerId: null,
  historyReturnFreelancerId: null,
  freelancerWorkspaceData: null,
  freelancerWorkspaceSearch: '',
  freelancerWorkspaceIncludeVendors: false,
  freelancerWorkspaceReturnId: null,
  editingTransportProfileId: null,
  selectedTransportProfileId: null,
  selectedFleetVehicleId: null,
  editingTransportId: null,
  editingLocationId: null,
  returnToTransportBooking: false,
  transportAvailabilityTimer: null,
  transportAvailabilityRequest: 0,
  transportVehicleSelections: {
    fleet: new Set(),
    external: new Set()
  },
  transportDriverDetails: new Map(),
  viewMode: 'schedule',
  activeSubprojectId: 'all',
  focusTarget: '',
  pendingUploads: new Map(),
  uploadActive: false,
  uploadSequence: 0
};

const workforceEventChooserState = {
  requestId: 0
};

const workforceDocumentsState = {
  eventId: 0,
  rows: [],
  statusCounts: {},
  kindCounts: {},
  statuses: new Set(['to-review', 'to-pay']),
  kind: 'all',
  includeFullTime: false,
  search: '',
  sortBy: 'event',
  sortDirection: 'desc',
  page: 1,
  pageSize: 50,
  pageCount: 1,
  total: 0,
  totalItems: 0,
  totalUploads: 0,
  attentionTotal: 0,
  loading: false,
  requestId: 0,
  searchTimer: null,
  realtimeTimer: null
};

const ADMIN_INVOICE_FILE_ACCEPT = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.xls',
  '.xlsx',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
].join(',');
const ADMIN_CLAIM_FILE_ACCEPT = [
  '.pdf', '.png', '.jpg', '.jpeg',
  'application/pdf', 'image/png', 'image/jpeg'
].join(',');

function wfEscape(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(String(value ?? ''));
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function wfAttr(value) {
  return wfEscape(value).replace(/"/g, '&quot;');
}

function wfConflictTooltipText(conflicts, { includeDate = false } = {}) {
  const reasons = new Map();
  (conflicts || []).forEach(conflict => {
    const eventId = String(conflict?.eventId || '').trim();
    const date = String(conflict?.date || '').trim();
    const eventName = String(conflict?.eventName || '').trim();
    const eventLabel = eventId ? `event #${eventId}` : 'another event';
    const reason = `Also scheduled for ${eventLabel}${eventName ? ` ${eventName}` : ''}`;
    reasons.set(`${eventId}:${date}:${eventName}`, includeDate && date ? `${date}: ${reason}` : reason);
  });
  return [...reasons.values()].join('\n');
}

let workforceTooltipTarget = null;

function ensureWorkforceInstantTooltip() {
  let tooltip = document.getElementById('workforceInstantTooltip');
  if (tooltip) return tooltip;
  tooltip = document.createElement('div');
  tooltip.id = 'workforceInstantTooltip';
  tooltip.className = 'wf-instant-tooltip-popup';
  tooltip.setAttribute('role', 'tooltip');
  document.body.appendChild(tooltip);
  return tooltip;
}

function positionWorkforceInstantTooltip(target, tooltip) {
  const targetRect = showbaseViewport.rect(target.getBoundingClientRect());
  const tooltipRect = showbaseViewport.rect(tooltip.getBoundingClientRect());
  const gap = 9;
  const edge = 8;
  const targetCenter = targetRect.left + (targetRect.width / 2);
  const left = Math.min(
    showbaseViewport.width() - tooltipRect.width - edge,
    Math.max(edge, targetCenter - (tooltipRect.width / 2))
  );
  const showAbove = targetRect.top >= tooltipRect.height + gap + edge;
  const top = showAbove
    ? targetRect.top - tooltipRect.height - gap
    : targetRect.bottom + gap;

  tooltip.dataset.placement = showAbove ? 'top' : 'bottom';
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
  tooltip.style.setProperty(
    '--wf-tooltip-arrow-left',
    `${Math.round(Math.min(tooltipRect.width - 10, Math.max(10, targetCenter - left)))}px`
  );
}

function showWorkforceInstantTooltip(target) {
  const reason = String(target?.dataset?.wfTooltip || '').trim();
  if (!reason) return;
  const tooltip = ensureWorkforceInstantTooltip();
  workforceTooltipTarget = target;
  tooltip.textContent = reason;
  tooltip.classList.add('is-visible');
  positionWorkforceInstantTooltip(target, tooltip);
}

function hideWorkforceInstantTooltip(target = null) {
  if (target && target !== workforceTooltipTarget) return;
  workforceTooltipTarget = null;
  document.getElementById('workforceInstantTooltip')?.classList.remove('is-visible');
}

function wfSubprojects() {
  return workforcePageState.data?.subprojects ||
    workforcePageState.data?.event?.subprojects || [];
}

function wfEffectiveSubprojectId(row) {
  return String(row?.subprojectId || wfSubprojects()[0]?.id || '');
}

function wfSubprojectName(row) {
  const roomId = wfEffectiveSubprojectId(row);
  return String(
    row?.subprojectName ||
    wfSubprojects().find(room => String(room.id) === roomId)?.name ||
    ''
  );
}

function wfDefaultSubprojectId(existingId = '') {
  const rooms = wfSubprojects();
  const existing = String(existingId || '');
  if (rooms.some(room => String(room.id) === existing)) return existing;
  if (
    workforcePageState.activeSubprojectId !== 'all' &&
    rooms.some(room =>
      String(room.id) === String(workforcePageState.activeSubprojectId)
    )
  ) {
    return String(workforcePageState.activeSubprojectId);
  }
  return String(rooms[0]?.id || '');
}

function wfPopulateSubprojectSelect(selectId, existingId = '') {
  const select = document.getElementById(selectId);
  if (!select) return;
  const rooms = wfSubprojects();
  const field = select.closest('.wf-room-field');
  if (field) field.hidden = rooms.length === 0;
  select.required = rooms.length > 0;
  select.innerHTML = rooms.map(room =>
    `<option value="${wfAttr(room.id)}">${wfEscape(room.name)}</option>`
  ).join('');
  select.value = wfDefaultSubprojectId(existingId);
}

function wfRoomBadge(row) {
  const name = wfSubprojectName(row);
  return name && wfSubprojects().length > 1
    ? `<span class="wf-room-badge">${wfEscape(name)}</span>`
    : '';
}

function wfRoomChipStyle(row) {
  const roomId = wfEffectiveSubprojectId(row);
  const index = Math.max(0, wfSubprojects().findIndex(room => String(room.id) === roomId));
  const palette = [
    ['#e7f5ef', '#176b51', '#93d0ba'],
    ['#eef1ff', '#4338a8', '#b8bdf2'],
    ['#fff2df', '#9a5200', '#efc27e'],
    ['#f7eafe', '#7b2d8c', '#d6a5df'],
    ['#e8f4fb', '#17607f', '#9bc9df'],
    ['#fdecef', '#a22f49', '#efadbb']
  ];
  const [background, color, border] = palette[index % palette.length];
  return `--wf-room-chip-bg:${background};--wf-room-chip-text:${color};--wf-room-chip-border:${border}`;
}

function wfSubprojectTabsHtml() {
  const rooms = wfSubprojects();
  if (rooms.length < 2) return '';
  const assignments = workforcePageState.data?.assignments || [];
  const tabs = [
    {
      id: 'all',
      name: 'All Rooms',
      assignmentCount: assignments.length
    },
    ...rooms.map(room => ({
      id: String(room.id),
      name: room.name,
      assignmentCount: assignments.filter(row =>
        wfEffectiveSubprojectId(row) === String(room.id)
      ).length
    }))
  ];
  return `<nav class="wf-room-tabs" aria-label="Event rooms">${tabs.map(tab => `
    <button type="button"
      class="${String(workforcePageState.activeSubprojectId) === tab.id ? 'active' : ''}"
      onclick="setWorkforceSubproject('${wfAttr(tab.id)}')">
      <span>${wfEscape(tab.name)}</span>
      <small>${tab.assignmentCount} crew</small>
    </button>`).join('')}</nav>`;
}

function setWorkforceSubproject(subprojectId) {
  workforcePageState.activeSubprojectId = String(subprojectId || 'all');
  renderWorkforcePage();
}

function wfMoney(value) {
  return `$${Number(value || 0).toLocaleString('en-SG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function wfMetricIconSvg(kind) {
  const icons = {
    invoice: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l3 3v15H6z"></path><path d="M14 3v4h4M9 11h6M9 15h4"></path><path d="M10.5 18h3"></path></svg>',
    claims: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21z"></path><path d="M9 8h6M9 12h6M9 16h3"></path></svg>',
    worker: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"></circle><path d="M5 21a7 7 0 0 1 14 0"></path></svg>',
    transport: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7z"></path><circle cx="7" cy="18" r="2"></circle><circle cx="18" cy="18" r="2"></circle></svg>',
    combined: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M8 7h8M8 11h2M14 11h2M8 15h2M14 15h2M8 18h8"></path></svg>'
  };
  return icons[kind] || icons.combined;
}

function wfDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-SG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function wfInitials(name) {
  return String(name || 'FW').split(/\s+/).filter(Boolean).slice(0, 2)
    .map(part => part[0].toUpperCase()).join('') || 'FW';
}

function wfStatusClass(status) {
  return `status-${String(status || 'Pending Review').toLowerCase().replace(/\s+/g, '-')}`;
}

function wfDirectorySubjects() {
  if (document.getElementById('freelancer-workspace-section')?.classList.contains('active')) {
    return workforcePageState.freelancerWorkspaceData?.subjects || [];
  }
  return [];
}

function wfDirectoryFreelancers() {
  const subjects = wfDirectorySubjects();
  return subjects.length
    ? subjects.filter(row => row.subjectType !== 'vendor')
    : workforcePageState.data?.freelancers || [];
}

function wfDirectoryVendors() {
  const subjects = wfDirectorySubjects();
  return subjects.length
    ? subjects.filter(row => row.subjectType === 'vendor')
    : workforcePageState.data?.vendors || [];
}

function wfFindFreelancer(id) {
  return wfDirectoryFreelancers().find(row => String(row.id) === String(id));
}

function wfFindVendor(id) {
  return wfDirectoryVendors().find(row => String(row.id) === String(id));
}

function wfFindAppUser(username) {
  return (workforcePageState.data?.appUsers || [])
    .find(row => String(row.username) === String(username));
}

function wfAssignmentSubjectId(row) {
  if (String(row?.subjectType || '').toLowerCase() === 'app-user') {
    return row?.userUsername ? `user:${row.userUsername}` : '';
  }
  return String(row?.freelancerId || row?.vendorId || '');
}

function wfTransportCompanyInvoices(booking) {
  const records = [
    ...(Array.isArray(booking?.companyInvoices) ? booking.companyInvoices : []),
    ...(booking?.companyInvoice ? [booking.companyInvoice] : [])
  ];
  const seen = new Set();
  return records.filter(record => {
    if (!record || typeof record !== 'object') return false;
    const identity = String(record.id || '');
    if (identity && seen.has(identity)) return false;
    if (identity) seen.add(identity);
    return true;
  });
}

function wfFindSubmission(id) {
  for (const [freelancerId, rows] of Object.entries(workforcePageState.data?.submissions || {})) {
    for (const plural of ['invoices', 'claims']) {
      const record = rows?.[plural]?.find(row => String(row.id) === String(id));
      if (record) return { record, freelancerId, kind: plural.slice(0, -1) };
    }
  }
  for (const booking of workforcePageState.data?.transportBookings || []) {
    const records = [
      ...(booking?.invoice ? [{ field: 'invoice', record: booking.invoice }] : []),
      ...wfTransportCompanyInvoices(booking).map(record => ({ field: 'companyInvoice', record })),
      ...(Array.isArray(booking?.claims)
        ? booking.claims.map(record => ({ field: 'claim', record }))
        : [])
    ];
    for (const { field, record } of records) {
      if (record && String(record.id) === String(id)) {
        const group = (workforcePageState.data?.transportCompanies || []).find(item =>
          (item.bookings || []).some(row => String(row.id) === String(booking.id))
        );
        const company = String(group?.company || record.company || booking.company || 'Transport provider');
        const expectedAmount = field === 'companyInvoice'
          ? Number(group?.estimatedCost || 0)
          : Number(booking.cost || 0) * (booking.twoWay ? 2 : 1);
        const kind = field === 'claim' ? 'claim' : 'invoice';
        Object.assign(record, {
          isTransportInvoice: kind === 'invoice',
          isTransportClaim: kind === 'claim',
          transportInvoiceScope: field === 'companyInvoice' ? 'company' : 'booking',
          subject: record.subject || { name: company, type: 'transport', company },
          expectedAmount: record.expectedAmount ?? expectedAmount,
          expectedAmountBreakdown: record.expectedAmountBreakdown || [{
            role: field === 'companyInvoice' ? 'Company invoice' : 'Transport booking',
            department: 'Transport',
            amount: expectedAmount,
            calculation: field === 'companyInvoice'
              ? `Estimated event transport: ${wfMoney(expectedAmount)}`
              : [booking.locationFrom, booking.locationTo].filter(Boolean).join(' to ')
          }]
        });
        return { record, freelancerId: '', kind, isTransport: true };
      }
    }
  }
  return null;
}

function wfAssignmentsForFreelancer(id) {
  return (workforcePageState.data?.assignments || [])
    .filter(row => String(row.freelancerId) === String(id));
}

function wfDepartmentsForFreelancer(id) {
  return [...new Set(wfAssignmentsForFreelancer(id).map(row => row.department).filter(Boolean))];
}

function wfDepartmentMeta(code) {
  const departmentCode = String(code || 'UN').toUpperCase();
  const sources = [
    ...(workforcePageState.data?.departments || []),
    ...(workforcePageState.data?.allDepartments || []),
    ...(workforcePageState.freelancerWorkspaceData?.departments || [])
  ];
  const row = sources.find(item => String(item.code || '').toUpperCase() === departmentCode) || {};
  const validColour = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value || ''))
    ? String(value)
    : fallback;
  return {
    code: departmentCode,
    name: row.name || (departmentCode === 'FT' ? 'Full-time' : code) || 'Unknown',
    color: validColour(row.color, '#e2e3e5'),
    textColor: validColour(row.textColor, '#383d41')
  };
}

function wfDepartmentStyle(code) {
  const department = wfDepartmentMeta(code);
  return `--wf-dept-color:${department.color};--wf-dept-text:${department.textColor}`;
}

function wfDepartmentOptions(selectedCode = '') {
  return (workforcePageState.data?.allDepartments || [])
    .filter(isSelectableCompanyDepartment).map(row => {
    const department = wfDepartmentMeta(row.code);
    return `<option value="${wfAttr(row.code)}" style="background-color:${department.color};color:${department.textColor}"
      ${row.code === selectedCode ? 'selected' : ''}>${wfEscape(row.name)} (${wfEscape(row.code)})</option>`;
  }).join('');
}

function wfTintDepartmentSelect(select) {
  if (!select) return;
  select.classList.add('wf-department-select');
  select.setAttribute('style', wfDepartmentStyle(select.value));
  select.onchange = () => select.setAttribute('style', wfDepartmentStyle(select.value));
}

function workforceRoutePath(
  eventId = workforcePageState.eventId,
  viewMode = workforcePageState.viewMode
) {
  const id = Number(eventId);
  if (!id) return '/manpower';
  const view = viewMode === 'schedule' ? 'by-day' : 'by-department';
  return `/manpower/${id}/${view}`;
}

function syncWorkforceRoute(options = {}) {
  if (typeof updateAppDetailHistory !== 'function') return;
  updateAppDetailHistory(
    workforceRoutePath(),
    options.replace === true
  );
}

function restoreWorkforceRouteState(route) {
  if (route?.kind !== 'workforce' || !Number(route.eventId)) return false;
  const eventId = Number(route.eventId);
  const eventChanged = eventId !== Number(workforcePageState.eventId);
  workforcePageState.eventId = eventId;
  workforcePageState.viewMode = route.viewMode === 'assignments'
    ? 'assignments'
    : 'schedule';
  if (eventChanged) {
    workforcePageState.data = null;
    workforcePageState.activeSubprojectId = 'all';
    if (typeof resetWorkforceScheduleFilters === 'function') {
      resetWorkforceScheduleFilters();
    }
  }
  return true;
}

function openEventWorkforce(eventId, focus = '') {
  if (!isAdminUser()) {
    showNotification('error', 'Admin privileges are required');
    return;
  }
  const id = Number(eventId);
  const focusTarget = String(focus || '');
  workforcePageState.eventId = id;
  workforcePageState.data = null;
  workforcePageState.activeSubprojectId = 'all';
  if (focus !== 'transport') {
    workforcePageState.viewMode = (
      focus === 'department'
      || focusTarget.startsWith('review-claim:')
    )
      ? 'assignments'
      : 'schedule';
  }
  if (typeof resetWorkforceScheduleFilters === 'function') {
    resetWorkforceScheduleFilters();
  }
  workforcePageState.focusTarget = focusTarget;
  if (id && typeof workflowRememberEvent === 'function') workflowRememberEvent(id);
  showSection(focus === 'transport' ? 'transport' : 'workforce', { eventId: id });
}

function openEventWorkforceReview(eventId, submissionId) {
  const id = String(submissionId || '').trim();
  if (!id) return;
  openEventWorkforce(eventId, `review-claim:${id}`);
}

async function loadWorkforcePage() {
  const root = document.getElementById('workforce-page-root');
  if (!root) return;
  if (!workforcePageState.eventId && typeof workflowRememberedEventId === 'function') {
    workforcePageState.eventId = workflowRememberedEventId();
  }
  const requestId = ++workforcePageState.loadRequestId;
  workforcePageState.loading = true;
  if (!workforcePageState.data) root.innerHTML = '<div class="loading">Loading crew &amp; vendors...</div>';
  try {
    if (!workforcePageState.eventOptions.length) {
      const eventOptionsLoad = await startProgressiveEventOptions(
        workforcePageState.eventId,
        loaded => {
          workforcePageState.eventOptions = loaded.slice().sort(planCompareEventsByEventIdDesc);
          if (planEventChooserState.context === 'workforce') renderPlanEventChooser();
        }
      );
      workforcePageState.eventOptions = eventOptionsLoad.first
        .slice()
        .sort(planCompareEventsByEventIdDesc);
      eventOptionsLoad.completion.then(loaded => {
        workforcePageState.eventOptions = loaded.slice().sort(planCompareEventsByEventIdDesc);
        if (planEventChooserState.context === 'workforce') renderPlanEventChooser();
      }).catch(error => console.warn('Unable to load more event options:', error));
    }
    const selectedEventIsAvailable = workforcePageState.eventOptions.some(
      event => Number(event.id) === Number(workforcePageState.eventId)
    );
    if (!selectedEventIsAvailable) {
      workforcePageState.eventId = Number(workforcePageState.eventOptions[0]?.id || 0);
      workforcePageState.data = null;
      if (workforcePageState.eventId && typeof workflowRememberEvent === 'function') {
        workflowRememberEvent(workforcePageState.eventId);
      }
    }
    if (!workforcePageState.eventId) {
      root.innerHTML = '<div class="wf-panel wf-empty">Create an event before assigning crew &amp; vendors.</div>';
      return;
    }
    syncWorkforceRoute({ replace: true });
    const eventId = Number(workforcePageState.eventId);
    const response = await apiCall(`/api/events/${eventId}/workforce`);
    if (
      requestId !== workforcePageState.loadRequestId ||
      eventId !== Number(workforcePageState.eventId)
    ) return;
    workforcePageState.data = response.data;
    renderWorkforcePage();
  } catch (error) {
    if (requestId !== workforcePageState.loadRequestId) return;
    root.innerHTML = `<div class="wf-panel wf-empty">Unable to load this page: ${wfEscape(error.message)}</div>`;
  } finally {
    if (requestId === workforcePageState.loadRequestId) {
      workforcePageState.loading = false;
    }
  }
}

async function refreshWorkforcePage() {
  const response = await apiCall(`/api/events/${workforcePageState.eventId}/workforce`);
  workforcePageState.data = response.data;
  renderWorkforcePage();
}

async function changeWorkforceEvent(eventId) {
  const id = Number(eventId);
  if (!id) return;
  closeModal('planEventChooserModal');
  workforcePageState.eventId = id;
  if (typeof workflowRememberEvent === 'function') workflowRememberEvent(id);
  workforcePageState.data = null;
  workforcePageState.activeSubprojectId = 'all';
  if (typeof resetWorkforceScheduleFilters === 'function') {
    resetWorkforceScheduleFilters();
  }
  syncWorkforceRoute();
  await loadWorkforcePage();
}

const WF_DOCUMENT_STATUS_FILTERS = [
  ['awaiting-upload', 'Awaiting upload'],
  ['to-review', 'Pending Review'],
  ['to-pay', 'Approved / To pay'],
  ['paid', 'Paid'],
  ['awaiting-confirmation', 'Awaiting confirmation'],
  ['payment-confirmed', 'Confirmed'],
  ['denied', 'Denied']
];

const WF_DOCUMENT_SORT_FIELDS = new Set(['event', 'uploader', 'submitted', 'status']);

function wfDocumentSortDirectionLabel(sortBy, direction) {
  const ascending = direction === 'asc';
  if (sortBy === 'event') return ascending ? 'Oldest event first' : 'Newest event first';
  if (sortBy === 'uploader') return ascending ? 'A to Z' : 'Z to A';
  if (sortBy === 'submitted') return ascending ? 'Oldest first' : 'Newest first';
  return ascending ? 'Workflow order' : 'Reverse workflow';
}

function wfDocumentSortHeader(sortBy, label) {
  const active = workforceDocumentsState.sortBy === sortBy;
  const direction = active ? workforceDocumentsState.sortDirection : '';
  const nextDirection = active && direction === 'asc' ? 'desc' : 'asc';
  const currentLabel = active ? wfDocumentSortDirectionLabel(sortBy, direction) : '';
  return `<button class="wf-document-sort-header ${active ? 'is-active' : ''}" type="button"
    onclick="wfDocumentsSetSort('${sortBy}')" aria-pressed="${active}"
    title="${wfAttr(active ? `Sorted ${currentLabel}. Click to reverse.` : `Sort by ${label}`)}">
    <span>${wfEscape(label)}</span><i aria-hidden="true">${active ? (direction === 'asc' ? '&uarr;' : '&darr;') : '&harr;'}</i>
    <span class="sr-only">${active ? `Sorted ${direction}. Activate for ${nextDirection}.` : `Activate to sort by ${label}.`}</span>
  </button>`;
}

function wfDocumentStatusClass(statusKey) {
  return {
    'awaiting-upload': 'status-awaiting-upload',
    'to-review': 'status-pending-review',
    'to-pay': 'status-to-pay',
    paid: 'status-paid',
    'awaiting-confirmation': 'status-awaiting-confirmation',
    'payment-confirmed': 'status-payment-confirmed',
    denied: 'status-denied',
    queued: 'status-queued',
    processing: 'status-processing',
    'details-required': 'status-details-required'
  }[statusKey] || 'status-unselected';
}

function wfDocumentStatusKeyFromRecord(record) {
  if (record.isAwaitingUpload) return 'awaiting-upload';
  if (record.processingState === 'Queued' || record.submissionStage === 'Queued') return 'queued';
  if (record.processingState === 'Processing' || record.submissionStage === 'Processing') return 'processing';
  if (record.submissionStage === 'Details Required') return 'details-required';
  if (record.paymentConfirmedAt) return 'payment-confirmed';
  return {
    'Pending Review': 'to-review',
    Approved: 'to-pay',
    Paid: 'awaiting-confirmation',
    Denied: 'denied'
  }[record.status || 'Pending Review'] || 'to-review';
}

function wfDocumentStatusMenu(record) {
  const statusKey = record.statusKey || wfDocumentStatusKeyFromRecord(record);
  if (statusKey === 'awaiting-upload') {
    return '<span class="wf-status-button status-badge status-awaiting-upload">Awaiting upload</span>';
  }
  const displayStatus = record.paymentConfirmedAt
    ? 'Payment Confirmed'
    : (record.status || 'Pending Review');
  if (['queued', 'processing', 'details-required'].includes(statusKey)) {
    const label = WF_DOCUMENT_STATUS_FILTERS.find(row => row[0] === statusKey)?.[1] || record.statusLabel;
    if (statusKey === 'queued' || statusKey === 'processing') {
      return `<span class="upload-status"><span class="wf-status-button status-badge ${wfStatusClass(label)}">${wfEscape(label)}</span>
        <span class="upload-progress-track processing"><span></span></span><small>${statusKey === 'queued' ? 'Waiting' : 'Analysing'}</small></span>`;
    }
    return `<span class="wf-status-button status-badge ${wfStatusClass(label)}">${wfEscape(label)}</span>`;
  }
  if (displayStatus === 'Pending Review') {
    return `<button class="wf-status-button status-badge ${wfStatusClass(displayStatus)}" type="button"
      onclick="event.stopPropagation();openWorkforceDocumentSubmission('${wfAttr(record.id)}')">
      Pending Review
    </button>`;
  }
  return `<div class="wf-status-control wf-document-status-control">
    <button class="wf-status-button status-badge ${wfStatusClass(displayStatus)}" type="button"
      aria-haspopup="menu" aria-expanded="false"
      onclick="toggleWorkforceDocumentStatusMenu(event,'${wfAttr(record.id)}')">
      ${wfEscape(displayStatus)} <span aria-hidden="true">&#9662;</span>
    </button>
    <div class="wf-status-menu wf-document-status-menu" id="wfDocumentStatusMenu-${wfAttr(record.id)}" role="menu">
      ${['Pending Review', 'Approved', 'Denied', 'Paid', 'Payment Confirmed'].map(status => `
        <button class="${wfStatusClass(status)}" type="button" role="menuitem"
          onclick="chooseWorkforceDocumentStatus(event,'${wfAttr(record.id)}','${status}')">${status}</button>
      `).join('')}
    </div>
  </div>`;
}

function ensureWorkforceDocumentsLayout() {
  const root = document.getElementById('workforce-documents-root');
  if (!root || root.querySelector('.wf-documents-shell')) return root;
  root.innerHTML = `<div class="wf-documents-shell">
    <div class="plan-page-heading wf-documents-heading">
      <div>
        <button class="wf-back" type="button" onclick="showSection('workforce')">&larr; Back to Crew &amp; Vendors</button>
        <h2>Invoices &amp; Claims</h2>
        <p id="wfDocumentsScope">Review every worker and vendor upload across your company.</p>
      </div>
    </div>
    <div class="wf-document-metrics" id="wfDocumentMetrics"></div>
    <section class="wf-panel wf-documents-panel">
      <header class="wf-documents-toolbar">
        <div class="wf-document-kind-tabs" id="wfDocumentKindTabs" aria-label="Document type filters"></div>
        <div class="wf-documents-toolbar-actions">
          <button class="wf-history-vendor-toggle wf-documents-fulltime-toggle" id="wfDocumentsFullTimeToggle"
            type="button" aria-pressed="false" onclick="wfDocumentsToggleFullTime()">
            <i aria-hidden="true"></i>
            <span><strong>Show full-time</strong><small>Include staff invoices and claims</small></span>
          </button>
          <label class="wf-document-search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m16 16 4 4"></path></svg>
            <input type="search" placeholder="Search event, uploader, file or department"
              value="${wfAttr(workforceDocumentsState.search)}"
              oninput="wfDocumentsSearchChanged(this.value)">
          </label>
        </div>
      </header>
      <div class="wf-document-status-filters" id="wfDocumentStatusFilters"></div>
      <div class="wf-documents-list" id="wfDocumentsList" aria-live="polite"></div>
      <footer class="wf-documents-pagination" id="wfDocumentsPagination"></footer>
    </section>
  </div>`;
  return root;
}

async function loadWorkforceDocumentsPage(options = {}) {
  const root = ensureWorkforceDocumentsLayout();
  if (!root) return;
  const scope = document.getElementById('wfDocumentsScope');
  if (scope) {
    scope.textContent = Number(workforceDocumentsState.eventId || 0) > 0
      ? `Review invoices and claims for Event #${Number(workforceDocumentsState.eventId)}.`
      : 'Review every worker and vendor upload across your company.';
  }
  const requestId = ++workforceDocumentsState.requestId;
  workforceDocumentsState.loading = true;
  const list = document.getElementById('wfDocumentsList');
  if (!options.quiet && list) {
    list.innerHTML = '<div class="wf-documents-loading"><span class="wf-loading-spinner"></span>Loading invoices and claims...</div>';
  }
  const params = new URLSearchParams({
    page: String(workforceDocumentsState.page),
    pageSize: String(workforceDocumentsState.pageSize),
    kind: workforceDocumentsState.kind,
    sort: workforceDocumentsState.sortBy,
    direction: workforceDocumentsState.sortDirection
  });
  if (Number(workforceDocumentsState.eventId || 0) > 0) {
    params.set('eventId', String(Number(workforceDocumentsState.eventId)));
  }
  if (workforceDocumentsState.statuses.size) {
    [...workforceDocumentsState.statuses].forEach(status => params.append('status', status));
  } else {
    params.set('status', 'all');
  }
  if (workforceDocumentsState.search) params.set('search', workforceDocumentsState.search);
  if (workforceDocumentsState.includeFullTime) params.set('includeFullTime', '1');
  try {
    const response = await apiCall(`/api/workforce/submissions?${params.toString()}`);
    if (requestId !== workforceDocumentsState.requestId) return;
    Object.assign(workforceDocumentsState, response.data, { loading: false });
    const selectedStatusesWithItems = [...workforceDocumentsState.statuses].filter(
      status => Number(workforceDocumentsState.statusCounts?.[status] || 0) > 0
    );
    if (selectedStatusesWithItems.length) {
      [...workforceDocumentsState.statuses].forEach(status => {
        if (Number(workforceDocumentsState.statusCounts?.[status] || 0) === 0) {
          workforceDocumentsState.statuses.delete(status);
        }
      });
    }
    renderWorkforceDocumentsPage();
  } catch (error) {
    if (requestId !== workforceDocumentsState.requestId) return;
    workforceDocumentsState.loading = false;
    if (list) list.innerHTML = `<div class="wf-empty">Unable to load invoices and claims: ${wfEscape(error.message)}</div>`;
  }
}

function renderWorkforceDocumentsPage() {
  ensureWorkforceDocumentsLayout();
  const counts = workforceDocumentsState.statusCounts || {};
  const kindCounts = workforceDocumentsState.kindCounts || {};
  const metrics = document.getElementById('wfDocumentMetrics');
  const kindTabs = document.getElementById('wfDocumentKindTabs');
  const statusFilters = document.getElementById('wfDocumentStatusFilters');
  const list = document.getElementById('wfDocumentsList');
  const pagination = document.getElementById('wfDocumentsPagination');
  const fullTimeToggle = document.getElementById('wfDocumentsFullTimeToggle');
  if (!metrics || !kindTabs || !statusFilters || !list || !pagination) return;

  if (fullTimeToggle) {
    fullTimeToggle.classList.toggle('is-on', workforceDocumentsState.includeFullTime);
    fullTimeToggle.setAttribute('aria-pressed', String(workforceDocumentsState.includeFullTime));
  }

  metrics.innerHTML = `
    <div><span class="wf-document-metric-icon is-attention">!</span><span><strong>${Number(workforceDocumentsState.attentionTotal || 0)}</strong><small>Needs attention</small></span></div>
    <div><span class="wf-document-metric-icon">${wfMetricIconSvg('invoice')}</span><span><strong>${Number(kindCounts.invoice || 0)}</strong><small>Invoices</small></span></div>
    <div><span class="wf-document-metric-icon is-claim">${wfMetricIconSvg('claims')}</span><span><strong>${Number(kindCounts.claim || 0)}</strong><small>Claims</small></span></div>
    <div><span class="wf-document-metric-icon is-total">${wfMetricIconSvg('combined')}</span><span><strong>${Number(workforceDocumentsState.totalUploads || 0)}</strong><small>Total uploads</small></span></div>`;

  kindTabs.innerHTML = [
    ['all', 'All files', workforceDocumentsState.totalUploads],
    ['invoice', 'Invoices', kindCounts.invoice],
    ['claim', 'Claims', kindCounts.claim]
  ].map(([key, label, count]) => `<button type="button" class="${workforceDocumentsState.kind === key ? 'active' : ''}"
    onclick="wfDocumentsSetKind('${key}')">${label}<span>${Number(count || 0)}</span></button>`).join('');

  const allActive = workforceDocumentsState.statuses.size === 0;
  statusFilters.innerHTML = `<button type="button" class="wf-document-filter ${allActive ? 'active' : ''}"
      onclick="wfDocumentsToggleStatus('all')">All <span>${Number(workforceDocumentsState.totalItems || 0)}</span></button>` +
    WF_DOCUMENT_STATUS_FILTERS.filter(([key]) => Number(counts[key] || 0) > 0).map(([key, label]) => {
      const active = workforceDocumentsState.statuses.has(key);
      return `
      <button type="button" class="wf-document-filter ${active ? `${wfDocumentStatusClass(key)} active` : ''}"
        aria-pressed="${active}" onclick="wfDocumentsToggleStatus('${key}')">
        ${label} <span>${Number(counts[key] || 0)}</span>
      </button>`;
    }).join('');

  list.innerHTML = `<div class="wf-documents-list-head">
      ${wfDocumentSortHeader('event', 'Event')}${wfDocumentSortHeader('uploader', 'Uploader')}<span>File</span>${wfDocumentSortHeader('submitted', 'Submitted')}<span>Amount</span>${wfDocumentSortHeader('status', 'Status')}<span>Download</span>
    </div>` + (workforceDocumentsState.rows.length
      ? workforceDocumentsState.rows.map(wfDocumentEntry).join('')
      : `<div class="wf-documents-empty"><strong>No matching uploads</strong><span>Try another status, type, or search term.</span></div>`);
  renderWorkforceDocumentsPagination(pagination);
}

function wfDocumentRow(record) {
  const event = record.event || {};
  const subject = record.subject || {};
  const eventDates = event.startDate === event.endDate || !event.endDate
    ? event.startDate
    : `${event.startDate} - ${event.endDate}`;
  const detailMarkup = record.kind === 'claim'
    ? `<small class="wf-claim-date">${wfClaimDate(record)}</small>`
    : '<small>Invoice</small>';
  const canOpenSubject = ['worker', 'vendor'].includes(subject.type) && subject.id;
  const departments = wfDocumentDepartmentRoles(record.departmentDetails);
  const subjectPhone = wfFormatPhone(subject.phone);
  const awaitingUpload = Boolean(record.isAwaitingUpload);
  const fileCell = awaitingUpload
    ? `<div class="wf-document-file is-awaiting" data-label="File">
        <span class="wf-document-type is-awaiting">INV</span>
        <span><strong>No invoice uploaded</strong><small>Awaiting worker or vendor upload</small></span>
      </div>`
    : `<button class="wf-document-file" data-label="File" type="button" onclick="openWorkforceDocumentSubmission('${wfAttr(record.id)}')">
        <span class="wf-document-type is-${wfAttr(record.kind)}">${record.kind === 'invoice' ? 'INV' : 'CLM'}</span>
        <span><span class="wf-file-title"><strong title="${wfAttr(record.originalName)}">${wfEscape(record.originalName || `${record.kind} upload`)}</strong>${record.kind === 'claim' ? wfClaimCategoryBadge(record) : ''}</span>${detailMarkup}</span>
      </button>`;
  const downloadCell = awaitingUpload
    ? '<span class="wf-document-download-empty" aria-label="No file available">-</span>'
    : `<a class="wf-icon-button" href="${wfAttr(record.downloadUrl)}" download title="Download ${wfAttr(record.originalName || record.kind)}" aria-label="Download ${wfAttr(record.originalName || record.kind)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5"></path><path d="M5 20h14"></path></svg>
      </a>`;
  return `<article class="wf-document-row ${awaitingUpload ? 'is-awaiting-upload' : ''}" data-submission-id="${wfAttr(record.id)}" data-event-id="${Number(event.id || 0)}">
    <button class="wf-document-event wf-document-navigation" data-label="Event" type="button"
      onclick="viewEvent(${Number(event.id || 0)},{updateHistory:false})" title="View event">
      <span class="wf-document-event-title"><strong>#${wfEscape(event.id)} ${wfEscape(event.name)}</strong>${planEventStateBadgeHtml(event)}</span>
      <small>${wfEscape(eventDates || 'No event date')}${event.location ? ` &middot; ${wfEscape(event.location)}` : ''}</small>
    </button>
    <button class="wf-document-uploader wf-document-navigation" data-label="Uploader" type="button"
      ${canOpenSubject ? `onclick="openFreelancerHistory('${wfAttr(subject.id)}')" title="View all events for ${wfAttr(subject.name)}"` : 'disabled'}>
      <span class="wf-avatar ${subject.type === 'vendor' ? 'vendor' : ''}">${wfEscape(wfInitials(subject.name))}</span>
      <span><strong>${wfEscape(subject.name || 'Unknown')}</strong>${subjectPhone ? `<small>${wfEscape(subjectPhone)}</small>` : ''}
        ${departments ? `<span class="wf-document-departments">${departments}</span>` : ''}</span>
    </button>
    ${fileCell}
    <div class="wf-document-submitted" data-label="Submitted"><strong>${awaitingUpload ? 'Not uploaded' : wfEscape(wfDateTime(wfDocumentSubmittedAt(record)) || 'Unknown')}</strong></div>
    <div class="wf-document-amount" data-label="Amount"><strong>${awaitingUpload ? '-' : (record.amount == null ? 'To verify' : wfMoney(record.amount))}</strong></div>
    <div class="wf-document-status" data-label="Status">${wfDocumentStatusMenu(record)}</div>
    <div class="wf-document-download" data-label="Download">${downloadCell}</div>
  </article>`;
}

function wfDocumentEntry(record) {
  return record.isClaimGroup ? wfDocumentClaimGroup(record) : wfDocumentRow(record);
}

function wfDocumentSubmittedAt(record) {
  return String(record?.submittedAt || record?.uploadedAt || record?.createdAt || '');
}

function wfDocumentDepartmentRoles(departmentDetails = []) {
  return departmentDetails.map(department => {
    const roles = [...new Set((department.roles || []).map(role => String(role || '').trim()).filter(Boolean))];
    return `<span class="wf-document-department-role">
      <span class="wf-document-department" style="--wf-document-dept-bg:${wfAttr(department.color || '#e2e3e5')};--wf-document-dept-text:${wfAttr(department.textColor || '#383d41')}"
        title="${wfAttr(department.name || department.code)}">${wfEscape(department.name || department.code)}</span>
      ${roles.length ? `<span class="wf-document-role">${roles.map(wfEscape).join(', ')}</span>` : ''}
    </span>`;
  }).join('');
}

function wfDocumentClaimGroupItem(record, index) {
  return `<article class="wf-document-claim-item" data-submission-id="${wfAttr(record.id)}">
    <span class="wf-document-claim-index">Claim ${index + 1}</span>
    <button class="wf-document-file" data-label="File" type="button" onclick="openWorkforceDocumentSubmission('${wfAttr(record.id)}')">
      <span class="wf-document-type is-claim">CLM</span>
      <span><span class="wf-file-title"><strong title="${wfAttr(record.originalName)}">${wfEscape(record.originalName || 'Claim upload')}</strong>${wfClaimCategoryBadge(record)}</span>
        <small class="wf-claim-date">${wfClaimDate(record)}</small></span>
    </button>
    <div class="wf-document-submitted" data-label="Submitted"><strong>${wfEscape(wfDateTime(wfDocumentSubmittedAt(record)) || 'Unknown')}</strong></div>
    <div class="wf-document-amount" data-label="Amount"><strong>${record.amount == null ? 'To verify' : wfMoney(record.amount)}</strong></div>
    <div class="wf-document-status" data-label="Status">${wfDocumentStatusMenu(record)}</div>
    <div class="wf-document-download" data-label="Download"><a class="wf-icon-button" href="${wfAttr(record.downloadUrl)}" download
      title="Download ${wfAttr(record.originalName || 'claim')}" aria-label="Download ${wfAttr(record.originalName || 'claim')}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5"></path><path d="M5 20h14"></path></svg>
    </a></div>
  </article>`;
}

function wfDocumentClaimGroup(group) {
  const event = group.event || {};
  const subject = group.subject || {};
  const claims = group.claims || [];
  const eventDates = event.startDate === event.endDate || !event.endDate
    ? event.startDate
    : `${event.startDate} - ${event.endDate}`;
  const canOpenSubject = ['worker', 'vendor'].includes(subject.type) && subject.id;
  const departments = wfDocumentDepartmentRoles(group.departmentDetails);
  const subjectPhone = wfFormatPhone(subject.phone);
  const totalLabel = group.claimAmountsComplete
    ? wfMoney(group.claimTotal || 0)
    : `${wfMoney(group.claimTotal || 0)} + pending`;
  const groupKey = `documents-${wfClaimGroupControlId(event.id, subject.id)}`;
  const reviewedCount = claims.filter(record => record.verifiedAt).length;
  const submittedAt = claims.reduce((latest, record) => {
    const value = wfDocumentSubmittedAt(record);
    return value > latest ? value : latest;
  }, '');
  return `<section class="wf-document-claim-group" id="wfDocumentClaimGroup-${wfAttr(groupKey)}"
      data-event-id="${Number(event.id || 0)}" data-subject-id="${wfAttr(subject.id)}">
    <header class="wf-document-claim-group-head">
      <button class="wf-document-event wf-document-navigation" type="button"
        onclick="viewEvent(${Number(event.id || 0)},{updateHistory:false})" title="View event">
        <span class="wf-document-event-title"><strong>#${wfEscape(event.id)} ${wfEscape(event.name)}</strong>${planEventStateBadgeHtml(event)}</span>
        <small>${wfEscape(eventDates || 'No event date')}${event.location ? ` &middot; ${wfEscape(event.location)}` : ''}</small>
      </button>
      <button class="wf-document-uploader wf-document-navigation" type="button"
        ${canOpenSubject ? `onclick="openFreelancerHistory('${wfAttr(subject.id)}')" title="View all events for ${wfAttr(subject.name)}"` : 'disabled'}>
        <span class="wf-avatar ${subject.type === 'vendor' ? 'vendor' : ''}">${wfEscape(wfInitials(subject.name))}</span>
        <span><strong>${wfEscape(subject.name || 'Unknown')}</strong>${subjectPhone ? `<small>${wfEscape(subjectPhone)}</small>` : ''}
          ${departments ? `<span class="wf-document-departments">${departments}</span>` : ''}</span>
      </button>
      <button class="wf-document-file wf-document-claim-toggle" type="button"
        onclick="toggleWorkforceDocumentClaimGroup(event,'${wfAttr(groupKey)}')" aria-expanded="false"
        aria-controls="wfDocumentClaimItems-${wfAttr(groupKey)}">
        <span class="wf-document-type is-claim">CLM</span>
        <span><strong>${claims.length} claims</strong><small>${reviewedCount} of ${claims.length} reviewed</small></span>
      </button>
      <div class="wf-document-submitted"><strong>${wfEscape(wfDateTime(submittedAt) || 'Unknown')}</strong><small>Latest submission</small></div>
      <div class="wf-document-amount"><strong>${totalLabel}</strong><small>Claim total</small></div>
      <div class="wf-document-status">${wfClaimGroupStatusControl(claims, event.id, subject.id, 'documents')}</div>
      <button class="wf-icon-button wf-document-claim-expand" type="button"
        onclick="toggleWorkforceDocumentClaimGroup(event,'${wfAttr(groupKey)}')" aria-expanded="false"
        aria-controls="wfDocumentClaimItems-${wfAttr(groupKey)}" title="Show claims" aria-label="Show claims">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"></path></svg>
      </button>
    </header>
    <div class="wf-document-claim-items" id="wfDocumentClaimItems-${wfAttr(groupKey)}" hidden>${claims.map(wfDocumentClaimGroupItem).join('')}</div>
  </section>`;
}

function toggleWorkforceDocumentClaimGroup(event, groupKey) {
  event.stopPropagation();
  const group = document.getElementById(`wfDocumentClaimGroup-${groupKey}`);
  const items = document.getElementById(`wfDocumentClaimItems-${groupKey}`);
  if (!group || !items) return;
  const open = items.hidden;
  items.hidden = !open;
  group.classList.toggle('is-open', open);
  group.querySelectorAll('[aria-controls]').forEach(button => {
    button.setAttribute('aria-expanded', String(open));
  });
  const expand = group.querySelector('.wf-document-claim-expand');
  if (expand) {
    expand.title = open ? 'Hide claims' : 'Show claims';
    expand.setAttribute('aria-label', expand.title);
  }
}

function renderWorkforceDocumentsPagination(node) {
  const page = Number(workforceDocumentsState.page || 1);
  const pageCount = Number(workforceDocumentsState.pageCount || 1);
  const total = Number(workforceDocumentsState.total || 0);
  const first = total ? (page - 1) * workforceDocumentsState.pageSize + 1 : 0;
  const last = Math.min(page * workforceDocumentsState.pageSize, total);
  node.innerHTML = `<span>Showing ${first}-${last} of ${total}</span><div>
    <button class="wf-icon-button" type="button" aria-label="Previous page" ${page <= 1 ? 'disabled' : ''}
      onclick="wfDocumentsSetPage(${page - 1})">&lsaquo;</button>
    <strong>Page ${page} of ${pageCount}</strong>
    <button class="wf-icon-button" type="button" aria-label="Next page" ${page >= pageCount ? 'disabled' : ''}
      onclick="wfDocumentsSetPage(${page + 1})">&rsaquo;</button>
  </div>`;
}

function wfDocumentsSetKind(kind) {
  workforceDocumentsState.kind = ['invoice', 'claim'].includes(kind) ? kind : 'all';
  workforceDocumentsState.page = 1;
  loadWorkforceDocumentsPage();
}

function wfDocumentsSetSort(sortBy) {
  const validSort = WF_DOCUMENT_SORT_FIELDS.has(sortBy) ? sortBy : 'event';
  if (workforceDocumentsState.sortBy === validSort) {
    workforceDocumentsState.sortDirection = workforceDocumentsState.sortDirection === 'asc'
      ? 'desc'
      : 'asc';
  } else {
    workforceDocumentsState.sortBy = validSort;
    workforceDocumentsState.sortDirection = ['uploader', 'status'].includes(validSort)
      ? 'asc'
      : 'desc';
  }
  workforceDocumentsState.page = 1;
  loadWorkforceDocumentsPage();
}

function wfDocumentsToggleFullTime() {
  workforceDocumentsState.includeFullTime = !workforceDocumentsState.includeFullTime;
  workforceDocumentsState.page = 1;
  const toggle = document.getElementById('wfDocumentsFullTimeToggle');
  if (toggle) {
    toggle.classList.toggle('is-on', workforceDocumentsState.includeFullTime);
    toggle.setAttribute('aria-pressed', String(workforceDocumentsState.includeFullTime));
  }
  loadWorkforceDocumentsPage();
}

function wfDocumentsToggleStatus(status) {
  if (status === 'all') {
    workforceDocumentsState.statuses.clear();
  } else if (workforceDocumentsState.statuses.has(status)) {
    workforceDocumentsState.statuses.delete(status);
  } else {
    workforceDocumentsState.statuses.add(status);
  }
  workforceDocumentsState.page = 1;
  loadWorkforceDocumentsPage();
}

function wfDocumentsSearchChanged(value) {
  clearTimeout(workforceDocumentsState.searchTimer);
  workforceDocumentsState.searchTimer = setTimeout(() => {
    workforceDocumentsState.search = String(value || '').trim();
    workforceDocumentsState.page = 1;
    loadWorkforceDocumentsPage({ quiet: true });
  }, 250);
}

function wfDocumentsSetPage(page) {
  workforceDocumentsState.page = Math.max(1, Number(page || 1));
  loadWorkforceDocumentsPage();
}

function wfFindDocumentSubmission(id) {
  for (const row of workforceDocumentsState.rows) {
    if (String(row.id) === String(id)) return row;
    if (row.isClaimGroup) {
      const claim = (row.claims || []).find(item => String(item.id) === String(id));
      if (claim) return claim;
    }
  }
  return null;
}

async function wfLoadDocumentEvent(record) {
  if (!record?.event?.id) return false;
  if (
    Number(workforcePageState.data?.event?.id) !== Number(record.event.id) ||
    !wfFindSubmission(record.id)
  ) {
    const response = await apiCall(`/api/events/${Number(record.event.id)}/workforce`);
    workforcePageState.eventId = Number(record.event.id);
    workforcePageState.data = response.data;
  }
  const found = wfFindSubmission(record.id);
  if (found) {
    Object.assign(found.record, {
      subject: record.subject,
      event: record.event,
      expectedAmount: record.expectedAmount,
      expectedAmountBreakdown: record.expectedAmountBreakdown,
      assignmentWorkDates: record.assignmentWorkDates,
      isTransportInvoice: record.isTransportInvoice,
      isTransportClaim: record.isTransportClaim,
      transportInvoiceScope: record.transportInvoiceScope
    });
  }
  return Boolean(found);
}

async function openWorkforceDocumentSubmission(id) {
  const record = wfFindDocumentSubmission(id);
  if (!record || record.isAwaitingUpload) return;
  const statusKey = record.statusKey || wfDocumentStatusKeyFromRecord(record);
  if (['queued', 'processing'].includes(statusKey)) {
    window.open(record.previewUrl, '_blank', 'noopener');
    return;
  }
  try {
    if (await wfLoadDocumentEvent(record)) await openWorkforceReview(id);
  } catch (error) {
    showNotification('error', error.message);
  }
}

function toggleWorkforceDocumentStatusMenu(event, id) {
  event.stopPropagation();
  const menu = document.getElementById(`wfDocumentStatusMenu-${id}`);
  if (!menu) return;
  const willOpen = !menu.classList.contains('open');
  closeWorkforceStatusMenus(menu);
  menu.classList.toggle('open', willOpen);
  menu.classList.remove('open-upward');
  const control = menu.closest('.wf-status-control');
  control?.classList.toggle('menu-open', willOpen);
  control?.querySelector(':scope > button')?.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) {
    const buttonRect = event.currentTarget.getBoundingClientRect();
    if (window.innerHeight - buttonRect.bottom < 190 && buttonRect.top > 190) {
      menu.classList.add('open-upward');
    }
  }
}

async function chooseWorkforceDocumentStatus(event, id, status) {
  event.stopPropagation();
  closeWorkforceStatusMenus();
  const record = wfFindDocumentSubmission(id);
  if (!record) return;
  try {
    if (!await wfLoadDocumentEvent(record)) return;
    const found = wfFindSubmission(id);
    if (!found) return;
    if (
      found.record.status === status &&
      !found.record.paymentConfirmedAt &&
      status !== 'Denied'
    ) return;
    if (!found.record.verifiedAt && status !== 'Pending Review') {
      await openWorkforceReview(id, status);
      return;
    }
    if (status === 'Denied') {
      openWorkforceDenialReason(id);
      return;
    }
    await applyWorkforceStatus(id, status);
  } catch (error) {
    showNotification('error', error.message);
  }
}

async function refreshAfterWorkforceSubmissionMutation(data) {
  workforcePageState.data = data;
  if (document.getElementById('invoice-claims-section')?.classList.contains('active')) {
    await loadWorkforceDocumentsPage({ quiet: true });
    return;
  }
  renderWorkforcePage();
}

function workforceDocumentsRealtimeRelevant(payload) {
  const actions = [payload?.details?.action]
    .concat((payload?.details?.changes || []).map(change => change?.details?.action))
    .map(action => String(action || '').toLowerCase());
  return actions.some(action => (
    action.includes('invoice') || action.includes('claim') ||
    action.includes('submission') || action.includes('payment') ||
    action.includes('profile') || action.includes('assignment') ||
    action.includes('deleted')
  ));
}

function queueWorkforceDocumentsRealtimeRefresh() {
  clearTimeout(workforceDocumentsState.realtimeTimer);
  workforceDocumentsState.realtimeTimer = setTimeout(() => {
    if (document.getElementById('invoice-claims-section')?.classList.contains('active')) {
      loadWorkforceDocumentsPage({ quiet: true });
    }
  }, 250);
}

function wfStatusMenu(record) {
  if (record.status === 'Uploading') {
    return `<span class="upload-status"><span class="wf-status-button status-badge status-uploading">Uploading</span>
      <span class="upload-progress-track"><span data-wf-upload-progress="${wfAttr(record.id)}" style="width:${Number(record.uploadProgress || 0)}%"></span></span>
      <small data-wf-upload-label="${wfAttr(record.id)}">${Math.round(Number(record.uploadProgress || 0))}%</small></span>`;
  }
  if (record.status === 'Queueing') {
    return `<span class="upload-status"><span class="wf-status-button status-badge status-queueing">Queueing</span>
      <span class="upload-progress-track"><span data-wf-upload-progress="${wfAttr(record.id)}" style="width:100%"></span></span>
      <small data-wf-upload-label="${wfAttr(record.id)}">Queueing</small></span>`;
  }
  if (record.status === 'Failed') {
    return `<span class="upload-status"><span class="wf-status-button status-badge status-failed" title="${wfAttr(record.processingError || 'Upload failed')}">Failed</span>
      <small>${wfEscape(record.processingError || 'Upload failed')}</small></span>`;
  }
  if (record.processingState === 'Queued' || record.submissionStage === 'Queued') {
    return `<span class="upload-status"><span class="wf-status-button status-badge ${wfStatusClass('Queued')}">Queued</span>
      <span class="upload-progress-track processing"><span></span></span><small>Waiting</small></span>`;
  }
  if (record.processingState === 'Processing') {
    return `<span class="upload-status"><span class="wf-status-button status-badge ${wfStatusClass('Processing')}">Processing</span>
      <span class="upload-progress-track processing"><span></span></span><small>Analysing</small></span>`;
  }
  if (record.submissionStage === 'Details Required') {
    return `<button class="wf-status-button status-badge ${wfStatusClass('Details Required')}" type="button"
      onclick="event.stopPropagation();openWorkforceReview('${wfAttr(record.id)}')">
      Details required
    </button>`;
  }
  const displayStatus = record.paymentConfirmedAt
    ? 'Payment Confirmed'
    : (record.status || 'Pending Review');
  if (displayStatus === 'Pending Review') {
    return `<button class="wf-status-button status-badge ${wfStatusClass(displayStatus)}" type="button"
      onclick="event.stopPropagation();openWorkforceReview('${wfAttr(record.id)}')">
      Pending Review
    </button>`;
  }
  return `<div class="wf-status-control">
    <button class="wf-status-button status-badge ${wfStatusClass(displayStatus)}" type="button"
      onclick="toggleWorkforceStatusMenu(event,'${wfAttr(record.id)}')">
      ${wfEscape(displayStatus)} <span>&#9662;</span>
    </button>
    <div class="wf-status-menu" id="wfStatusMenu-${wfAttr(record.id)}">
      ${['Pending Review', 'Approved', 'Denied', 'Paid', 'Payment Confirmed'].map(status =>
        `<button class="${wfStatusClass(status)}" type="button"
          onclick="chooseWorkforceStatus(event,'${wfAttr(record.id)}','${status}')">${status}</button>`
      ).join('')}
    </div>
  </div>`;
}

function wfClaimTotalMarkup(claims) {
  if (!Array.isArray(claims) || claims.length < 2) return '';
  const included = claims.filter(record => record.status !== 'Denied');
  const known = included
    .map(record => Number(record.amount))
    .filter(amount => Number.isFinite(amount));
  if (!known.length) return '<span class="wf-claim-total">Total to verify</span>';
  const total = known.reduce((sum, amount) => sum + amount, 0);
  const suffix = known.length < included.length ? ' + pending' : ' total';
  return `<span class="wf-claim-total">${wfMoney(total)}${suffix}</span>`;
}

function wfClaimDisplayStatus(record) {
  return record.paymentConfirmedAt
    ? 'Payment Confirmed'
    : (record.status || 'Pending Review');
}

function wfSubmissionStatusBadges(records) {
  const stateCounts = (records || []).reduce((summary, record) => {
    const status = wfClaimDisplayStatus(record);
    summary[status] = (summary[status] || 0) + 1;
    return summary;
  }, {});
  return ['Pending Review', 'Approved', 'Denied', 'Paid', 'Payment Confirmed']
    .filter(status => Number(stateCounts[status] || 0) > 0)
    .map(status =>
      `<span class="status-badge ${wfStatusClass(status)}">${status}: <strong>${Number(stateCounts[status] || 0)}</strong></span>`
    ).join('');
}

function wfClaimGroupControlId(eventId, subjectId) {
  return `${Number(eventId || 0)}-${String(subjectId || '').replace(/[^a-z0-9_-]/gi, '-')}`;
}

function wfClaimGroupStatusControl(claims, eventId, subjectId, controlKey = '') {
  if (!Array.isArray(claims) || claims.length < 2) return '';
  const reviewed = claims.every(record => Boolean(record.verifiedAt));
  const statuses = [...new Set(claims.map(wfClaimDisplayStatus))];
  const commonStatus = statuses.length === 1 ? statuses[0] : '';
  const instanceKey = String(controlKey || '').replace(/[^a-z0-9_-]/gi, '-');
  const menuId = `claim-group-${wfClaimGroupControlId(eventId, subjectId)}${instanceKey ? `-${instanceKey}` : ''}`;
  const buttonLabel = reviewed
    ? (commonStatus ? `All: ${commonStatus}` : 'Update all')
    : 'Review individually';
  return `<div class="wf-status-control wf-claim-group-status">
    <button class="wf-status-button status-badge ${commonStatus ? wfStatusClass(commonStatus) : 'status-mixed'}" type="button"
      ${reviewed ? `onclick="toggleWorkforceStatusMenu(event,'${wfAttr(menuId)}')"` : 'disabled'}
      title="${reviewed ? 'Update every claim in this group' : 'Review every claim individually before updating them together'}">
      ${wfEscape(buttonLabel)}${reviewed ? ' <span>&#9662;</span>' : ''}
    </button>
    ${reviewed ? `<div class="wf-status-menu" id="wfStatusMenu-${wfAttr(menuId)}">
      ${['Pending Review', 'Approved', 'Paid', 'Payment Confirmed'].map(status =>
        `<button class="${wfStatusClass(status)}" type="button"
          onclick="chooseWorkforceClaimGroupStatus(event,${Number(eventId || 0)},'${wfAttr(subjectId)}','${status}')">${status}</button>`
      ).join('')}
    </div>` : ''}
  </div>`;
}

function wfClaimDate(record) {
  return wfEscape(wfReviewDateLabel(record.claimDate) || 'Not provided');
}

function wfClaimCategory(record) {
  const category = String(record?.category || '').trim();
  return ['transport', 'crew transport', 'staff transport', 'cab', 'taxi', 'grab'].includes(category.toLowerCase())
    ? 'Crew Transport'
    : category;
}

function wfClaimCategoryBadge(record) {
  return `<span class="wf-document-claim-category">${wfEscape(wfClaimCategory(record) || 'Claim')}</span>`;
}

function wfSubmissionRow(record, kind) {
  return `<div class="wf-file-row">
    <div class="wf-file-details wf-file-title">
    ${record.clientOnly
      ? `<span class="wf-file-name" title="${wfAttr(record.originalName)}">${wfEscape(record.originalName || `${kind} upload`)}</span>`
      : `<button class="wf-file-name" type="button" onclick="openWorkforceReview('${wfAttr(record.id)}')"
          title="${wfAttr(record.originalName)}">${wfEscape(record.originalName || `${kind} upload`)}</button>`}
    ${kind === 'claim' ? wfClaimCategoryBadge(record) : ''}</div>
    <span class="wf-file-amount">${record.amount == null ? 'Amount to verify' : wfMoney(record.amount)}${kind === 'claim' ? `<span class="wf-claim-date">${wfClaimDate(record)}</span>` : ''}</span>
    ${wfStatusMenu(record)}
    ${record.clientOnly
      ? (record.status === 'Failed' ? `<button class="wf-icon-button danger" type="button" title="Dismiss failed upload" onclick="wfDismissPendingUpload('${wfAttr(record.id)}')">&times;</button>` : '<span></span>')
      : `<button class="wf-icon-button danger" type="button" title="Delete upload"
          onclick="deleteWorkforceSubmission('${wfAttr(record.id)}')">&times;</button>`}
  </div>`;
}

function wfPendingSubmissionRows(subjectId, kind) {
  return [...workforcePageState.pendingUploads.values()].filter(row => (
    Number(row.eventId) === Number(workforcePageState.eventId) &&
    String(row.subjectId) === String(subjectId) &&
    row.kind === kind
  ));
}

function wfSubmissionRowsMarkup(rows, subjectId, kind, emptyMarkup) {
  const combined = [...wfPendingSubmissionRows(subjectId, kind), ...(rows || [])];
  if (kind === 'claim') combined.sort((a, b) =>
    String(a.claimDate || '9999-12-31').localeCompare(String(b.claimDate || '9999-12-31'))
    || String(a.submittedAt || '').localeCompare(String(b.submittedAt || ''))
  );
  return combined.length
    ? combined.map(row => wfSubmissionRow(row, kind)).join('')
    : emptyMarkup;
}

function wfDismissPendingUpload(uploadId) {
  workforcePageState.pendingUploads.delete(uploadId);
  renderWorkforcePage();
}

function wfSlotControls(freelancerId, kind, limits) {
  const extra = Number(kind === 'invoice' ? limits.extraInvoices : limits.extraClaims);
  return `<span class="wf-upload-actions">
    <button class="wf-mini-button" type="button"
      ${Number(limits[`${kind}SlotsRemaining`]) <= 0 ? 'disabled' : ''}
      onclick="openAdminWorkforceUpload('${wfAttr(freelancerId)}','${kind}')">Upload</button>
    <button class="wf-mini-button subtle" type="button"
      onclick="changeWorkforceUploadSlots('${wfAttr(freelancerId)}','${kind}',1)">+ Slot</button>
    <button class="wf-mini-button subtle" type="button" ${extra <= 0 ? 'disabled' : ''}
      onclick="changeWorkforceUploadSlots('${wfAttr(freelancerId)}','${kind}',-1)">&minus; Slot</button>
  </span>`;
}

function wfSubmissionDropAttributes(subjectId, kind) {
  return `ondragenter="wfSubmissionDragOver(event)" ondragover="wfSubmissionDragOver(event)" ` +
    `ondragleave="wfSubmissionDragLeave(event)" ondrop="wfSubmissionDrop(event,'${wfAttr(subjectId)}','${wfAttr(kind)}')"`;
}

function wfSubmissionDragOver(event) {
  event.preventDefault();
  event.currentTarget.classList.add('is-file-dragging');
}

function wfSubmissionDragLeave(event) {
  if (event.currentTarget.contains(event.relatedTarget)) return;
  event.currentTarget.classList.remove('is-file-dragging');
}

function wfSubmissionDrop(event, subjectId, kind) {
  event.preventDefault();
  event.currentTarget.classList.remove('is-file-dragging');
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  if (workforcePageState.uploadActive) {
    showNotification('warning', 'Please wait for the current upload queue to finish');
    return;
  }
  openAdminWorkforceUpload(subjectId, kind);
  const input = document.getElementById('wfAdminUploadFile');
  if (!input) return;
  const transfer = new DataTransfer();
  files.forEach(file => transfer.items.add(file));
  input.files = transfer.files;
  updateAdminWorkforceDropzoneFiles();
  document.getElementById('wfAdminUploadForm')?.requestSubmit();
}

function wfWorkerHtml(freelancerId, assignments) {
  const freelancer = wfFindFreelancer(freelancerId) || { id: freelancerId, name: 'Unknown worker' };
  const submissions = workforcePageState.data.submissions?.[freelancerId] || { invoices: [], claims: [] };
  const limits = workforcePageState.data.uploadAllowances?.[freelancerId] || {
    invoiceLimit: 1, claimLimit: 5, activeInvoices: 0, activeClaims: 0,
    invoiceSlotsRemaining: 1, claimSlotsRemaining: 5, extraInvoices: 0, extraClaims: 0
  };
  const dateConflicts = assignments.flatMap(row => row.dateConflicts || []);
  const conflictTitle = wfConflictTooltipText(dateConflicts, { includeDate: true });
  const roles = assignments.map(row => `<span class="wf-assignment-chip">
    <button class="wf-assignment-edit" type="button" title="Edit assignment"
      onclick="openFreelancerAssignment('${wfAttr(freelancer.id)}','${wfAttr(row.department)}','${wfAttr(row.id)}')">
      ${wfRoomBadge(row)}${wfEscape(row.roleName || 'Role not set')} &middot; ${row.days} day${Number(row.days) === 1 ? '' : 's'} &middot; ${row.dailyRate == null ? 'Rate not set' : `${wfMoney(row.dailyRate)}/day`}
    </button>
    <button type="button" title="Remove role" onclick="event.stopPropagation();deleteWorkforceAssignment('${wfAttr(row.id)}')">&times;</button>
  </span>`).join('');
  return `<article class="wf-worker">
    <button class="wf-worker-identity wf-worker-open" type="button"
      onclick="openFreelancerHistory('${wfAttr(freelancer.id)}')"><div class="wf-worker-profile">
      <span class="wf-avatar">${wfEscape(wfInitials(freelancer.name))}</span>
      <div><strong>${wfEscape(freelancer.name)}${dateConflicts.length ? ` <span class="wf-worker-conflict wf-instant-tooltip" data-wf-tooltip="${wfAttr(conflictTitle)}" role="img" aria-label="${wfAttr(`Schedule conflict. ${conflictTitle}`)}">!</span>` : ''}</strong>
        <small>${wfEscape(wfFormatPhone(freelancer.phone) || 'No portal phone number')}</small></div>
    </div><small>View all events &rsaquo;</small></button>
    <div class="wf-worker-roles">
      <div class="wf-column-heading"><strong>Role(s)</strong>
        <button class="wf-link-button" type="button"
          onclick="openFreelancerAssignment('${wfAttr(freelancer.id)}','${wfAttr(assignments[0]?.department || '')}')">+ Add role</button></div>
      <div class="wf-assignment-list">${roles}</div>
    </div>
    <section class="wf-submission-box" ${wfSubmissionDropAttributes(freelancer.id, 'invoice')}><header><span>Invoice &middot; ${limits.activeInvoices}/${limits.invoiceLimit}</span>
      ${wfSlotControls(freelancer.id, 'invoice', limits)}</header>
      ${wfSubmissionRowsMarkup(submissions.invoices, freelancer.id, 'invoice', '<div class="wf-empty">No invoice submitted.</div>')}</section>
    <section class="wf-submission-box" ${wfSubmissionDropAttributes(freelancer.id, 'claim')}><header><span class="wf-claims-heading"><span>Claims &middot; ${limits.activeClaims}/${limits.claimLimit}</span>
      ${wfClaimTotalMarkup(submissions.claims || [])}
      ${wfClaimGroupStatusControl(submissions.claims || [], workforcePageState.eventId, freelancer.id, assignments[0]?.department)}</span>
      ${wfSlotControls(freelancer.id, 'claim', limits)}</header>
      ${wfSubmissionRowsMarkup(submissions.claims, freelancer.id, 'claim', '<div class="wf-empty">No claims submitted.</div>')}</section>
  </article>`;
}

function wfAppUserHtml(subjectId, assignments) {
  const username = String(assignments[0]?.userUsername || subjectId).replace(/^user:/, '');
  const user = wfFindAppUser(username) || {
    username,
    name: username || 'Unknown app user',
    phone: ''
  };
  const submissions = workforcePageState.data.submissions?.[subjectId] || {
    invoices: [], claims: []
  };
  const limits = workforcePageState.data.uploadAllowances?.[subjectId] || {
    invoiceLimit: 0, claimLimit: 5, activeInvoices: 0, activeClaims: 0,
    invoiceSlotsRemaining: 0, claimSlotsRemaining: 5,
    extraInvoices: 0, extraClaims: 0
  };
  const roles = assignments.map(row => `<span class="wf-assignment-chip">
    <button class="wf-assignment-edit" type="button" title="Edit assignment"
      onclick="openFullTimeStaffAssignment('${wfAttr(row.id)}')">
      ${wfRoomBadge(row)}${wfEscape(row.roleName || 'Role not set')} &middot; ${row.days} day${Number(row.days) === 1 ? '' : 's'} &middot; ${row.dailyRate == null ? 'Rate not set' : `${wfMoney(row.dailyRate)}/day`}
    </button>
    <button type="button" title="Remove assignment" onclick="event.stopPropagation();deleteWorkforceAssignment('${wfAttr(row.id)}')">&times;</button>
  </span>`).join('');
  return `<article class="wf-worker wf-app-user">
    <div class="wf-worker-identity"><div class="wf-worker-profile">
      <span class="wf-avatar staff">${wfEscape(wfInitials(user.name))}</span>
      <div><strong>${wfEscape(user.name)}</strong>
        <small>${wfEscape(wfFormatPhone(user.phone) || 'No phone number')}</small>
        <small>Full-time staff &middot; App user</small></div>
    </div></div>
    <div class="wf-worker-roles">
      <div class="wf-column-heading"><strong>Role(s)</strong>
        <button class="wf-link-button" type="button"
          onclick="openFullTimeStaffAssignment('', '${wfAttr(username)}', '${wfAttr(assignments[0]?.department || '')}')">+ Add role</button></div>
      <div class="wf-assignment-list">${roles}</div>
    </div>
    <section class="wf-submission-box" ${wfSubmissionDropAttributes(subjectId, 'invoice')}><header><span>Invoice &middot; ${limits.activeInvoices}/${limits.invoiceLimit}</span>
      ${wfSlotControls(subjectId, 'invoice', limits)}</header>
      ${wfSubmissionRowsMarkup(submissions.invoices, subjectId, 'invoice', '<div class="wf-empty">No invoice slot by default.</div>')}</section>
    <section class="wf-submission-box" ${wfSubmissionDropAttributes(subjectId, 'claim')}><header><span class="wf-claims-heading"><span>Claims &middot; ${limits.activeClaims}/${limits.claimLimit}</span>
      ${wfClaimTotalMarkup(submissions.claims || [])}
      ${wfClaimGroupStatusControl(submissions.claims || [], workforcePageState.eventId, subjectId, assignments[0]?.department)}</span>
      ${wfSlotControls(subjectId, 'claim', limits)}</header>
      ${wfSubmissionRowsMarkup(submissions.claims, subjectId, 'claim', '<div class="wf-empty">No claims submitted.</div>')}</section>
  </article>`;
}

function wfVendorHtml(vendorId, assignments) {
  const vendor = wfFindVendor(vendorId) || { id: vendorId, name: 'Unknown vendor' };
  const lastLogin = vendor.workerLastLoginAt
    ? `Last login: ${wfEscape(wfDateTime(vendor.workerLastLoginAt))} by ${wfEscape(vendor.workerLastLoginBy || 'Unknown member')}`
    : 'Last login: Never';
  const submissions = workforcePageState.data.submissions?.[vendorId] || { invoices: [], claims: [] };
  const limits = workforcePageState.data.uploadAllowances?.[vendorId] || {
    invoiceLimit: 1, activeInvoices: 0, invoiceSlotsRemaining: 1, extraInvoices: 0,
    claimLimit: 5, activeClaims: 0, claimSlotsRemaining: 5, extraClaims: 0
  };
  const assignmentChips = assignments.map(row => {
    const description = row.providerType === 'manpower'
      ? `${Number(row.pax || 0)} pax · ${wfMoney(row.ratePerPax)}/pax/day`
      : `${wfEscape(row.serviceName || row.roleName || 'Service')} · ${wfMoney(row.serviceCost)}`;
    return `<span class="wf-assignment-chip">
      <button class="wf-assignment-edit" type="button" title="Edit vendor assignment"
        onclick="openVendorAssignment('${wfAttr(vendor.id)}','${wfAttr(row.department)}','${wfAttr(row.id)}')">
        ${wfRoomBadge(row)}${description} · ${Number(row.days || 0)} day${Number(row.days) === 1 ? '' : 's'}
      </button>
      <button type="button" title="Remove assignment" onclick="event.stopPropagation();deleteWorkforceAssignment('${wfAttr(row.id)}')">&times;</button>
    </span>`;
  }).join('');
  return `<article class="wf-worker wf-vendor">
    <button class="wf-worker-identity wf-worker-open" type="button"
      onclick="openFreelancerHistory('${wfAttr(vendor.id)}')"><div class="wf-worker-profile">
      <span class="wf-avatar vendor">${wfEscape(wfInitials(vendor.name))}</span>
      <div><strong>${wfEscape(vendor.name)}</strong>
        <small>${Number(vendor.members?.length || 0)} portal member${Number(vendor.members?.length || 0) === 1 ? '' : 's'}</small>
        <small>${lastLogin}</small></div>
    </div><small>View all events &rsaquo;</small></button>
    <div class="wf-worker-roles">
      <div class="wf-column-heading"><strong>Event assignment(s)</strong>
        <button class="wf-link-button" type="button"
          onclick="openVendorAssignment('${wfAttr(vendor.id)}','${wfAttr(assignments[0]?.department || '')}')">+ Add assignment</button></div>
      <div class="wf-assignment-list">${assignmentChips}</div>
    </div>
    <section class="wf-submission-box wf-vendor-invoice" ${wfSubmissionDropAttributes(vendor.id, 'invoice')}><header><span>Vendor invoice · ${limits.activeInvoices}/${limits.invoiceLimit}</span>
      ${wfSlotControls(vendor.id, 'invoice', limits)}</header>
      ${wfSubmissionRowsMarkup(submissions.invoices, vendor.id, 'invoice', '<div class="wf-empty">No invoice submitted.</div>')}</section>
    <section class="wf-submission-box" ${wfSubmissionDropAttributes(vendor.id, 'claim')}><header><span class="wf-claims-heading"><span>Vendor claims &middot; ${limits.activeClaims || 0}/${limits.claimLimit || 5}</span>
      ${wfClaimTotalMarkup(submissions.claims || [])}
      ${wfClaimGroupStatusControl(submissions.claims || [], workforcePageState.eventId, vendor.id, assignments[0]?.department)}</span>
      ${wfSlotControls(vendor.id, 'claim', {
        claimLimit: limits.claimLimit || 5,
        activeClaims: limits.activeClaims || 0,
        claimSlotsRemaining: limits.claimSlotsRemaining ?? 5,
        extraClaims: limits.extraClaims || 0
      })}</header>
      ${wfSubmissionRowsMarkup(submissions.claims, vendor.id, 'claim', '<div class="wf-empty">No claims submitted.</div>')}</section>
  </article>`;
}

function wfDepartmentHtml(department, assignments) {
  const totals = workforcePageState.data.totals?.departments?.[department] || { invoice: 0, claims: 0, combined: 0 };
  const bySubject = {};
  assignments.forEach(row => {
    const subjectId = wfAssignmentSubjectId(row);
    if (subjectId) (bySubject[subjectId] ||= []).push(row);
  });
  const subjectIds = Object.keys(bySubject);
  const count = subjectIds.reduce((total, subjectId) => {
    const rows = bySubject[subjectId] || [];
    if (rows.some(row => row.vendorId || row.subjectType === 'vendor')) {
      return total + rows.reduce((pax, row) =>
        pax + (row.providerType === 'manpower' ? Number(row.pax || 0) : 0), 0);
    }
    return total + 1;
  }, 0);
  const departmentSubmissions = subjectIds.flatMap(freelancerId => {
    const submissions = workforcePageState.data.submissions?.[freelancerId] || {};
    return [...(submissions.invoices || []), ...(submissions.claims || [])];
  });
  const statusBadges = wfSubmissionStatusBadges(departmentSubmissions);
  const canRemoveDepartment = !(workforcePageState.data.assignments || [])
    .some(row => row.department === department);
  return `<details class="wf-department" data-department="${wfAttr(department)}" style="${wfDepartmentStyle(department)}">
    <summary><span class="wf-department-title"><span class="wf-department-label">${wfEscape(wfDepartmentMeta(department).name)} <small>${count} crew</small></span>
        <span class="wf-dept-status-summary">${statusBadges}</span></span>
      <span class="wf-department-header-actions">
        <button class="wf-button primary" type="button"
          onclick="event.preventDefault();event.stopPropagation();openWorkforceDayStaffPicker('','${wfAttr(department)}')">+ Add worker/vendor</button>
        ${canRemoveDepartment
          ? `<button class="wf-button danger" type="button"
              onclick="event.preventDefault();event.stopPropagation();deleteWorkforceDepartment('${wfAttr(department)}')">Remove department</button>`
          : ''}
      </span>
      <span class="wf-dept-total"><span>Invoices</span><strong>${wfMoney(totals.invoice)}</strong></span>
      <span class="wf-dept-total"><span>Claims</span><strong>${wfMoney(totals.claims)}</strong></span>
      <span class="wf-dept-total"><span>Combined</span><strong>${wfMoney(totals.combined)}</strong></span></summary>
    <div>${assignments.length ? Object.entries(bySubject).map(([id, rows]) =>
      rows.some(row => row.vendorId || row.subjectType === 'vendor')
        ? wfVendorHtml(id, rows)
        : rows.some(row => row.subjectType === 'app-user')
          ? wfAppUserHtml(id, rows)
          : wfWorkerHtml(id, rows)
    ).join('') : '<div class="wf-empty">No workers or vendors assigned to this department.</div>'}</div>
  </details>`;
}

function wfCrewTransportCategoryHtml() {
  const groups = workforcePageState.data?.transportCompanies || [];
  if (!groups.length) return '';
  const transportInvoices = groups.flatMap(group => [
    ...(Array.isArray(group.invoices)
      ? group.invoices
      : (group.invoice ? [group.invoice] : [])),
    ...(group.bookings || []).map(row => row.invoice).filter(Boolean)
  ]);
  const transportClaims = groups.flatMap(group =>
    (group.bookings || []).flatMap(row => Array.isArray(row.claims) ? row.claims : [])
  );
  const invoiceTotal = transportInvoices.reduce((sum, invoice) =>
    sum + (invoice.status === 'Denied' ? 0 : Number(invoice.amount || 0)), 0);
  const estimatedTotal = groups.reduce((sum, group) => sum + Number(group.estimatedCost || 0), 0);
  return `<details class="wf-department wf-transport-panel" data-department="transport">
    <summary><span class="wf-department-title"><span class="wf-department-label">Transport <small>${groups.length} compan${groups.length === 1 ? 'y' : 'ies'}</small></span>
        <span class="wf-dept-status-summary">${wfSubmissionStatusBadges([...transportInvoices, ...transportClaims])}</span></span>
      <span class="wf-department-header-actions"><button class="wf-button primary" type="button" onclick="event.preventDefault();event.stopPropagation();openEventWorkforce(${Number(workforcePageState.eventId)},'transport')">View Transport</button></span>
      <span class="wf-dept-total"><span>Invoices</span><strong>${wfMoney(invoiceTotal)}</strong></span>
      <span class="wf-dept-total"><span>Bookings</span><strong>${wfMoney(estimatedTotal)}</strong></span>
      <span class="wf-dept-total"><span>Transport cost</span><strong>${wfMoney(workforcePageState.data?.totals?.transport || 0)}</strong></span></summary>
    <div>${groups.map(wfTransportCompanyHtml).join('')}</div>
  </details>`;
}

function wfTransportCompanyHtml(group) {
  const bookings = group.bookings || [];
  const bookingId = group.invoiceBookingId || bookings[0]?.id || '';
  const companyInvoices = Array.isArray(group.invoices)
    ? group.invoices
    : (group.invoice ? [group.invoice] : []);
  const invoices = [
    ...companyInvoices,
    ...bookings.map(row => row.invoice).filter(Boolean)
  ];
  const fleetClaims = bookings.flatMap(row => Array.isArray(row.claims) ? row.claims : []);
  const submissions = group.isFleet ? fleetClaims : invoices;
  const submissionKind = group.isFleet ? 'claim' : 'invoice';
  const chips = bookings.map(booking => `<span class="wf-assignment-chip"><button class="wf-assignment-edit" type="button"
    onclick="openWorkforceTransportBooking('${wfAttr(booking.id)}')" title="View booking on Transport page">
    ${wfRoomBadge(booking)}${wfEscape([booking.departDate, booking.departTime, booking.vehicleNumber || booking.vehicleType].filter(Boolean).join(' · '))} · ${wfMoney(Number(booking.cost || 0) * (booking.twoWay ? 2 : 1))}
  </button></span>`).join('');
  return `<article class="wf-worker wf-vendor wf-transport-company">
    <div class="wf-worker-identity"><div class="wf-worker-profile"><span class="wf-avatar vendor">${wfEscape(wfInitials(group.company))}</span>
      <div><strong>${wfEscape(group.company)}</strong><small>${bookings.length} booking${bookings.length === 1 ? '' : 's'}</small><small>Transport cost: ${wfMoney(group.cost)}</small></div></div></div>
    <div class="wf-worker-roles"><div class="wf-column-heading"><strong>Event bookings</strong></div><div class="wf-assignment-list">${chips}</div></div>
    <section class="wf-submission-box wf-transport-company-invoice"
      ondragenter="wfSubmissionDragOver(event)" ondragover="wfSubmissionDragOver(event)" ondragleave="wfSubmissionDragLeave(event)"
      ondrop="${group.isFleet ? 'wfOwnFleetClaimDrop' : 'wfTransportCompanyInvoiceDrop'}(event,'${wfAttr(bookingId)}')">
      <header><span>${group.isFleet ? 'Claims' : 'Invoices'} · ${submissions.length}</span><label class="wf-mini-button">Upload ${submissionKind}<input type="file" accept="${group.isFleet ? ADMIN_CLAIM_FILE_ACCEPT : ADMIN_INVOICE_FILE_ACCEPT}" hidden onchange="${group.isFleet ? 'uploadOwnFleetTransportClaim' : 'uploadTransportCompanyInvoice'}('${wfAttr(bookingId)}',this)"></label></header>
      ${submissions.length
        ? submissions.map(record => wfSubmissionRow(record, submissionKind)).join('')
        : `<div class="wf-empty">${group.isFleet ? 'Upload parking receipts or other own-fleet claims.' : 'Upload an invoice for this company’s event bookings.'}</div>`}
    </section>
  </article>`;
}

function openWorkforceTransportBooking(bookingId) {
  workforcePageState.transportFocusBookingId = String(bookingId);
  openEventWorkforce(workforcePageState.eventId, 'transport');
}

async function uploadTransportCompanyInvoice(bookingId, input) {
  if (!input.files?.[0]) return;
  const form = new FormData();
  form.append('file', input.files[0]);
  input.disabled = true;
  try {
    const response = await apiCall(`/api/events/${workforcePageState.eventId}/workforce/transport/${encodeURIComponent(bookingId)}/company-invoice`, 'POST', form);
    workforcePageState.data = response.data;
    renderWorkforcePage();
    showNotification('success', 'Company invoice uploaded. Check the invoice total.');
  } catch (error) {
    showNotification('error', error.message);
  } finally {
    input.disabled = false;
    input.value = '';
  }
}

async function uploadOwnFleetTransportClaim(bookingId, input) {
  if (!input.files?.[0]) return;
  const form = new FormData();
  form.append('file', input.files[0]);
  input.disabled = true;
  try {
    const response = await apiCall(`/api/events/${workforcePageState.eventId}/workforce/transport/${encodeURIComponent(bookingId)}/claim`, 'POST', form);
    workforcePageState.data = response.data;
    renderWorkforcePage();
    showNotification('success', 'Own-fleet claim uploaded. Review its category and amount.');
  } catch (error) {
    showNotification('error', error.message);
  } finally {
    input.disabled = false;
    input.value = '';
  }
}

async function wfOwnFleetClaimDrop(event, bookingId) {
  event.preventDefault();
  event.stopPropagation();
  const area = event.currentTarget;
  area.classList.remove('is-file-dragging');
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  if (files.length > 1) {
    showNotification('warning', 'Upload one claim at a time.');
    return;
  }
  const input = area.querySelector('input[type="file"]');
  if (!input || input.disabled) return;
  await uploadOwnFleetTransportClaim(bookingId, { files, value: '', disabled: false });
}

async function wfTransportCompanyInvoiceDrop(event, bookingId) {
  event.preventDefault();
  event.stopPropagation();
  const area = event.currentTarget;
  area.classList.remove('is-file-dragging');
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  if (files.length > 1) {
    showNotification('warning', 'Upload one company invoice at a time.');
    return;
  }
  const input = area.querySelector('input[type="file"]');
  if (!input || input.disabled) return;
  input.disabled = true;
  try {
    await uploadTransportCompanyInvoice(bookingId, { files, value: '' });
  } finally {
    input.disabled = false;
  }
}

function wfTransportTripCard(booking, direction) {
  const isReturn = direction === 'return';
  const isLegacyReturn = isReturn && Boolean(booking.twoWay);
  const routeFrom = isLegacyReturn ? booking.locationTo : booking.locationFrom;
  const routeTo = isLegacyReturn ? booking.locationFrom : booking.locationTo;
  const routeFromAddress = isLegacyReturn ? booking.locationToAddress : booking.locationFromAddress;
  const routeToAddress = isLegacyReturn ? booking.locationFromAddress : booking.locationToAddress;
  const tripDate = isLegacyReturn ? booking.returnDate : booking.departDate;
  const tripTime = isLegacyReturn ? booking.returnTime : booking.departTime;
  return `<div class="wf-booking-leg ${isReturn ? 'is-return' : ''}">
    <div class="wf-booking-leg-heading"><span class="wf-trip-direction">${isReturn ? 'Return' : 'Depart'}</span>
      <span>${wfEscape(wfTransportDateLabel(tripDate))} <b>${wfEscape(wfTransportTimeLabel(tripTime))}</b></span></div>
    <div class="wf-booking-route">${wfLocationBadge(routeFrom, 'From', routeFromAddress)}<span class="wf-route-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"></path></svg></span>${wfLocationBadge(routeTo, 'To', routeToAddress)}</div>
  </div>`;
}

function wfFormatPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('65')) {
    return `+65 ${digits.slice(2, 6)} ${digits.slice(6)}`;
  }
  if (digits.length === 8) return `+65 ${digits.slice(0, 4)} ${digits.slice(4)}`;
  return String(value || '');
}

function wfLocationBadge(value, label, explicitAddress = '') {
  const { name, address } = wfLocationParts(value, explicitAddress);
  return `<span class="wf-location-badge"><span class="wf-location-heading"><small class="wf-location-direction">${label}</small><b>${wfEscape(name || '—')}</b></span>
    ${address ? `<em>${wfEscape(address)}</em>` : ''}</span>`;
}

function wfTransportCard(booking) {
  const isFleet = booking.sourceType === 'fleet';
  const isOnDemand = booking.profileType === 'on_demand';
  const invoice = booking.invoice;
  const companyGroup = (workforcePageState.data?.transportCompanies || []).find(group =>
    (group.bookings || []).some(row => String(row.id) === String(booking.id))
  );
  const companyInvoices = Array.isArray(companyGroup?.invoices)
    ? companyGroup.invoices
    : (companyGroup?.invoice ? [companyGroup.invoice] : []);
  const visibleInvoices = [
    ...(invoice ? [invoice] : []),
    ...companyInvoices
  ];
  const fleetClaims = Array.isArray(booking.claims) ? booking.claims : [];
  const contact = wfFormatPhone(booking.driverContact || booking.contactNumber);
  const phone = contact.replace(/[^\d+]/g, '');
  const cost = Number(booking.cost || 0) * (booking.twoWay ? 2 : 1);
  const invoiceDrop = `ondragenter="wfTransportInvoiceDragOver(event)" ondragover="wfTransportInvoiceDragOver(event)" ondragleave="wfTransportInvoiceDragLeave(event)" ondrop="${isFleet ? 'wfOwnFleetClaimDrop' : 'wfTransportCompanyInvoiceDrop'}(event,'${wfAttr(booking.id)}')"`;
  return `<details data-transport-booking-id="${wfAttr(booking.id)}" class="wf-transport-card wf-booking-card" ${invoiceDrop}>
    <summary class="wf-booking-heading" aria-label="View booking: ${wfAttr(wfTransportVehicleType(booking))}${booking.vehicleNumber ? `, ${wfAttr(booking.vehicleNumber)}` : ''}, ${wfAttr(wfTransportDateLabel(booking.departDate))}, ${wfAttr(wfTransportTimeLabel(booking.departTime))}">
      <div class="wf-booking-vehicle"><span class="wf-booking-icon">${wfMetricIconSvg('transport')}</span><div>
        <h4>${wfEscape(wfTransportVehicleType(booking))}</h4>
        <div class="wf-booking-provider">${booking.vehicleNumber ? `<strong>${wfEscape(booking.vehicleNumber)}</strong><span aria-hidden="true">·</span>` : ''}
          ${isOnDemand ? '<strong class="wf-on-demand-badge">On-demand</strong><span aria-hidden="true">·</span>' : ''}<span>${booking.twoWay ? 'Depart & return' : booking.tripType === 'return' ? 'Return' : 'Depart'}</span></div>
      </div></div>
      <div class="wf-booking-glance"><span>${wfEscape(wfLocationParts(booking.locationFrom, booking.locationFromAddress).name || 'From TBC')} <span aria-hidden="true">→</span> ${wfEscape(wfLocationParts(booking.locationTo, booking.locationToAddress).name || 'To TBC')}</span>
        <small>${wfEscape(wfSubprojectName(booking) || 'Subproject not assigned')}</small></div>
      <div class="wf-trip-cost"><strong>${wfMoney(cost)}</strong>${booking.twoWay ? '<small>2 trips</small>' : ''}</div>
      <span class="wf-booking-expand" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"></path></svg></span>
    </summary>
    <div class="wf-booking-body"><div class="wf-booking-legs">
      ${wfTransportTripCard(booking, booking.twoWay ? 'depart' : booking.tripType)}
      ${booking.twoWay ? wfTransportTripCard(booking, 'return') : ''}
      ${isFleet && (booking.useEndDate || booking.useEndTime) ? `<p class="wf-booking-use">Vehicle reserved until <strong>${wfEscape(wfTransportDateLabel(booking.useEndDate))} · ${wfEscape(wfTransportTimeLabel(booking.useEndTime))}</strong></p>` : ''}
    </div><dl class="wf-booking-details">
      <div><dt>Subproject</dt><dd>${wfEscape(wfSubprojectName(booking) || 'Not assigned')}</dd></div>
      <div><dt>Transport provider</dt><dd>${isFleet ? 'Own fleet' : wfEscape(booking.company || 'External transport')}</dd></div>
      <div><dt>Driver</dt><dd>${isOnDemand ? 'Assigned by provider' : wfEscape(booking.driver || booking.companyDriver || 'Driver TBC')}</dd></div>
      <div><dt>Contact number</dt><dd>${isOnDemand && !contact ? 'Available after dispatch' : (/\d/.test(phone) ? `<a href="tel:${wfAttr(phone)}">${wfEscape(contact)}</a>` : wfEscape(contact || 'Contact TBC'))}</dd></div>
      ${booking.twoWay ? `<div><dt>Cost per trip</dt><dd>${wfMoney(booking.cost)} × 2 trips</dd></div>` : ''}
    </dl></div>
    <footer class="wf-booking-footer"><div class="wf-booking-invoice">${isFleet ? `
      ${fleetClaims.length
        ? fleetClaims.map(record => `<button class="wf-link-button" type="button" onclick="openWorkforceReview('${wfAttr(record.id)}')">${wfEscape(record.originalName || 'View claim')}</button>`).join('')
        : '<span>No own-fleet claims uploaded</span>'}
      <label class="wf-link-button">Upload claim<input type="file" accept="${ADMIN_CLAIM_FILE_ACCEPT}" hidden onchange="uploadOwnFleetTransportClaim('${wfAttr(booking.id)}',this)"></label>` : `
      ${visibleInvoices.length
        ? visibleInvoices.map(record => `<button class="wf-link-button" type="button" onclick="openWorkforceReview('${wfAttr(record.id)}')">${wfEscape(record.originalName || 'View invoice')}</button>`).join('')
        : '<span>Invoice not uploaded</span>'}
      <label class="wf-link-button">Upload invoice<input type="file" accept="${ADMIN_INVOICE_FILE_ACCEPT}" hidden onchange="uploadTransportCompanyInvoice('${wfAttr(booking.id)}',this)"></label>`}</div>
      <div class="wf-booking-actions"><button class="wf-button" type="button" onclick="openTransportBooking('${wfAttr(booking.vendorId || '')}','${wfAttr(booking.id)}','${wfAttr(booking.sourceType || 'external')}')">Edit booking</button>
        <button class="wf-button danger" type="button" onclick="deleteTransportBooking('${wfAttr(booking.id)}')">Remove</button></div>
    </footer>
  </details>`;
}

// Use calendar dates without a local timezone conversion, including older YYYYMMDD values.
function wfTransportDateKey(value) {
  const raw = String(value || '').trim();
  const key = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return '';
  const date = new Date(`${key}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === key ? key : '';
}

function wfTransportDateLabel(value) {
  const key = wfTransportDateKey(value);
  return key ? new Date(`${key}T00:00:00Z`).toLocaleDateString('en-SG', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
  }) : 'Date TBC';
}

function wfTransportTimeKey(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value || '').trim());
  return match && Number(match[1]) < 24 && Number(match[2]) < 60
    ? `${match[1].padStart(2, '0')}:${match[2]}` : '';
}

function wfTransportTimeLabel(value) {
  return wfTransportTimeKey(value) || 'Time TBC';
}

function wfTransportVehicleType(booking) {
  return String(booking.vehicleType || '').trim().replace(/\s+/g, ' ') || 'Vehicle type TBC';
}

function wfTransportVehicleKey(booking) {
  const registration = String(booking.vehicleNumber || '').replace(/\s+/g, '').toUpperCase();
  if (registration) return `registration:${registration}`;
  if (booking.vehicleId) return `fleet:${booking.vehicleId}`;
  return `booking:${booking.id}`;
}

function wfTransportVehicleCounts(entries) {
  const types = new Map();
  entries.forEach(({ booking }) => {
    const label = wfTransportVehicleType(booking);
    const key = label.toLowerCase();
    if (!types.has(key)) types.set(key, { label, vehicles: new Set() });
    types.get(key).vehicles.add(wfTransportVehicleKey(booking));
  });
  return [...types.values()].sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }))
    .map(type => ({ label: type.label, count: type.vehicles.size }));
}

function wfTransportSchedule(bookings) {
  const days = new Map();
  bookings.forEach(booking => {
    const legs = [{ date: booking.departDate, time: booking.departTime, isReturnLeg: false }];
    if (booking.twoWay) legs.push({ date: booking.returnDate, time: booking.returnTime, isReturnLeg: true });
    legs.forEach(leg => {
      const date = wfTransportDateKey(leg.date);
      if (!days.has(date)) days.set(date, { date, entries: [], slots: [] });
      days.get(date).entries.push({ ...leg, time: wfTransportTimeKey(leg.time), booking });
    });
  });
  return [...days.values()].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')).map(day => {
    day.entries.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99')
      || wfTransportVehicleType(a.booking).localeCompare(wfTransportVehicleType(b.booking), 'en', { numeric: true })
      || String(a.booking.vehicleNumber || '').localeCompare(String(b.booking.vehicleNumber || ''))
      || Number(a.isReturnLeg) - Number(b.isReturnLeg));
    day.entries.forEach(entry => {
      let slot = day.slots[day.slots.length - 1];
      if (!slot || slot.time !== entry.time) {
        slot = { time: entry.time, entries: [] };
        day.slots.push(slot);
      }
      slot.entries.push(entry);
    });
    day.types = wfTransportVehicleCounts(day.entries);
    day.vehicleCount = new Set(day.entries.map(entry => wfTransportVehicleKey(entry.booking))).size;
    day.cost = day.entries.reduce((sum, entry) => sum + Number(entry.booking.cost || 0), 0);
    return day;
  });
}

function wfTransportEventDayLabel(date, event) {
  const start = wfTransportDateKey(event?.startDateValue) || wfTransportDateKey(event?.startDate);
  const end = wfTransportDateKey(event?.endDateValue) || wfTransportDateKey(event?.endDate) || start;
  if (!date || !start) return '';
  const dayNumber = value => new Date(`${value}T00:00:00Z`).getTime() / 86400000;
  if (date < start) {
    const days = dayNumber(start) - dayNumber(date);
    return `${days} day${days === 1 ? '' : 's'} before event`;
  }
  if (date > end) {
    const days = dayNumber(date) - dayNumber(end);
    return `${days} day${days === 1 ? '' : 's'} after event`;
  }
  return `Event day ${dayNumber(date) - dayNumber(start) + 1}`;
}

function wfTransportTypeChips(types) {
  return types.map(type => `<span class="wf-transport-type-chip"><b>${type.count} ×</b> ${wfEscape(type.label)}</span>`).join('');
}

function wfFocusTransportBooking(id) {
  const root = document.getElementById('transport-page-root');
  const card = [...(root?.querySelectorAll('[data-transport-booking-id]') || [])]
    .find(row => row.dataset.transportBookingId === String(id));
  if (card) card.open = true;
  card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card?.querySelector('summary')?.focus({ preventScroll: true });
}

function wfTransportDayHtml(day, event) {
  const eventDay = wfTransportEventDayLabel(day.date, event);
  return `<section class="wf-transport-day" id="wf-transport-day-${day.date || 'unscheduled'}" aria-label="${wfAttr(wfTransportDateLabel(day.date))}">
    <header class="wf-transport-day-heading"><div><h3>${wfEscape(wfTransportDateLabel(day.date))}</h3>
      <p>${eventDay ? `<span class="wf-transport-event-day">${wfEscape(eventDay)}</span>` : ''}${day.vehicleCount} vehicle${day.vehicleCount === 1 ? '' : 's'} · ${day.entries.length} trip${day.entries.length === 1 ? '' : 's'}</p></div>
      <div class="wf-transport-day-total"><span>Day trip cost</span><strong>${wfMoney(day.cost)}</strong></div></header>
    <div class="wf-transport-times">${day.slots.map(slot => `<section class="wf-transport-time-group">
      <header class="wf-transport-time-heading"><h4>${wfEscape(wfTransportTimeLabel(slot.time))}</h4><span>${slot.entries.length} trip${slot.entries.length === 1 ? '' : 's'}</span>
        ${slot.entries.length > 1 ? `<div class="wf-transport-type-list">${wfTransportTypeChips(wfTransportVehicleCounts(slot.entries))}</div>` : ''}</header>
      <div class="wf-transport-booking-list">${slot.entries.map(entry => entry.isReturnLeg
        ? `<div class="wf-transport-return-reference"><span class="wf-trip-direction">Return</span><span><strong>${wfEscape(wfTransportVehicleType(entry.booking))}${entry.booking.vehicleNumber ? ` · ${wfEscape(entry.booking.vehicleNumber)}` : ''}</strong><br>${wfEscape(entry.booking.locationTo || 'Location TBC')} → ${wfEscape(entry.booking.locationFrom || 'Location TBC')} · ${wfMoney(entry.booking.cost)}</span>
          <button type="button" class="wf-button" onclick="wfFocusTransportBooking('${wfAttr(entry.booking.id)}')">View booking</button></div>`
        : wfTransportCard(entry.booking)).join('')}</div>
    </section>`).join('')}</div>
  </section>`;
}

function captureWorkforceViewState(root) {
  const departmentNodes = [...root.querySelectorAll('.wf-department')];
  const scroller = root.closest('.content-area');
  return {
    hasDepartments: departmentNodes.length > 0,
    openDepartments: departmentNodes
      .filter(node => node.open)
      .map(node => node.dataset.department),
    scrollTop: scroller?.scrollTop ?? null,
    windowScrollY: window.scrollY
  };
}

function restoreWorkforceViewState(root, state) {
  if (!state?.hasDepartments) return;
  const openDepartments = new Set(state.openDepartments);
  root.querySelectorAll('.wf-department').forEach(node => {
    node.open = openDepartments.has(node.dataset.department);
  });
  const scroller = root.closest('.content-area');
  if (scroller && state.scrollTop !== null) {
    scroller.scrollTop = state.scrollTop;
  }
  requestAnimationFrame(() => {
    if (scroller && state.scrollTop !== null) {
      scroller.scrollTop = state.scrollTop;
    } else {
      window.scrollTo({ top: state.windowScrollY, behavior: 'auto' });
    }
  });
}

function wfManpowerEventPickerHtml(data, ariaLabel = 'Choose an event', context = 'workforce') {
  const event = data?.event || {};
  const eventDates = event.startDate === event.endDate
    ? wfEscape(event.startDate || '')
    : [event.startDate, event.endDate]
      .filter(Boolean)
      .map(wfEscape)
      .join(' &ndash; ');
  return `<button type="button" class="plan-event-select-wrap"
      aria-haspopup="dialog" aria-label="${wfAttr(ariaLabel)}"
      onclick="planOpenEventChooser('${wfAttr(context)}')">
    <div class="plan-event-icon" aria-hidden="true">${planMetricIconSvg('calendar')}</div>
    <div class="wf-event-picker-content">
      <div class="plan-event-title-row">
        <span class="plan-event-id">#${wfEscape(String(event.id || ''))}</span>
        <span class="plan-event-name">${wfEscape(planEventOptionLabel(event))}</span>
      </div>
      <div class="plan-event-meta">
        <span>${eventDates || '&mdash;'}</span>
        ${event.location ? `<span aria-hidden="true">&bull;</span><span>${wfEscape(event.location)}</span>` : ''}
        ${planEventTypeBadgeHtml(event)}
        ${planEventStateBadgeHtml(event)}
      </div>
    </div>
    <span class="plan-event-picker-chevron" aria-hidden="true">&#8964;</span>
  </button>`;
}

async function loadTransportPage() {
  const root = document.getElementById('transport-page-root');
  if (!root) return;
  if (!workforcePageState.eventId && typeof workflowRememberedEventId === 'function') {
    workforcePageState.eventId = workflowRememberedEventId();
  }
  const requestId = ++workforcePageState.loadRequestId;
  if (!workforcePageState.data) root.innerHTML = '<div class="loading">Loading transport workspace...</div>';
  try {
    if (!workforcePageState.eventOptions.length) {
      const optionLoad = await startProgressiveEventOptions(
        workforcePageState.eventId,
        loaded => {
          workforcePageState.eventOptions = loaded.slice().sort(planCompareEventsByEventIdDesc);
          if (planEventChooserState.context === 'transport') renderPlanEventChooser();
        }
      );
      workforcePageState.eventOptions = optionLoad.first.slice().sort(planCompareEventsByEventIdDesc);
      optionLoad.completion.then(loaded => {
        workforcePageState.eventOptions = loaded.slice().sort(planCompareEventsByEventIdDesc);
        if (planEventChooserState.context === 'transport') renderPlanEventChooser();
      }).catch(error => console.warn('Unable to load more event options:', error));
    }
    const selectedEventIsAvailable = workforcePageState.eventOptions.some(
      event => Number(event.id) === Number(workforcePageState.eventId)
    );
    if (!selectedEventIsAvailable) {
      workforcePageState.eventId = Number(workforcePageState.eventOptions[0]?.id || 0);
      workforcePageState.data = null;
      if (workforcePageState.eventId && typeof workflowRememberEvent === 'function') {
        workflowRememberEvent(workforcePageState.eventId);
      }
    }
    if (!workforcePageState.eventId) {
      root.innerHTML = '<div class="wf-panel wf-empty">Create an event before booking transport.</div>';
      return;
    }
    const eventId = Number(workforcePageState.eventId);
    const response = await apiCall(`/api/events/${eventId}/workforce`);
    if (requestId !== workforcePageState.loadRequestId) return;
    workforcePageState.data = response.data;
    renderTransportPage();
  } catch (error) {
    if (requestId === workforcePageState.loadRequestId) {
      root.innerHTML = `<div class="wf-panel wf-empty">Unable to load Transport: ${wfEscape(error.message)}</div>`;
    }
  }
}

async function changeTransportEvent(eventId) {
  const id = Number(eventId || 0);
  if (!id) return;
  closeModal('planEventChooserModal');
  workforcePageState.eventId = id;
  workforcePageState.data = null;
  workforcePageState.activeSubprojectId = 'all';
  if (typeof workflowRememberEvent === 'function') workflowRememberEvent(id);
  await loadTransportPage();
}

function renderTransportPage() {
  const root = document.getElementById('transport-page-root');
  const data = workforcePageState.data;
  if (!root || !data) return;
  const bookings = data.transportBookings || [];
  const openBookingIds = new Set([...root.querySelectorAll('details[data-transport-booking-id][open]')]
    .map(node => node.dataset.transportBookingId));
  const days = wfTransportSchedule(bookings);
  const tripCount = days.reduce((sum, day) => sum + day.entries.length, 0);
  const totalCost = days.reduce((sum, day) => sum + day.cost, 0);
  root.innerHTML = `
    <div class="plan-page-heading wf-manpower-page-heading">
      <div><h2>Transport</h2><p>Your event’s vehicles, organised by day and time.</p></div>
      <div class="wf-manpower-heading-actions">
        <button class="wf-button" type="button" onclick="openLocationsManager()">Manage locations</button>
        <button class="wf-button" type="button" onclick="openTransportDirectory()">Manage transport</button>
        <button class="wf-button primary" type="button" onclick="openTransportBooking()">Book transport</button>
      </div>
    </div>
    <div class="plan-event-bar">
      ${wfManpowerEventPickerHtml(data, 'Choose an event for transport', 'transport')}
      <div class="plan-metrics">
        <div class="plan-metric"><div class="plan-metric-icon wf-metric-transport">${wfMetricIconSvg('transport')}</div><div><strong>${bookings.length}</strong><span>Bookings</span></div></div>
        <div class="plan-metric"><div class="plan-metric-icon">${wfMetricIconSvg('transport')}</div><div><strong>${tripCount}</strong><span>Scheduled trips</span></div></div>
        <div class="plan-metric"><div class="plan-metric-icon">${wfMetricIconSvg('invoice')}</div><div><strong>${days.filter(day => day.date).length}</strong><span>Booked days</span></div></div>
        <div class="plan-metric"><div class="plan-metric-icon wf-metric-combined">${wfMetricIconSvg('combined')}</div><div><strong>${wfMoney(totalCost)}</strong><span>Booked Cost</span></div></div>
      </div>
    </div>
    ${bookings.length ? `<section class="wf-transport-overview" aria-label="Transport by day">
      <div class="wf-transport-overview-heading"><h3>Transport by day</h3><p>Each vehicle counted once per day · Select a date to jump to its bookings.</p></div>
      <nav class="wf-transport-day-links" aria-label="Jump to a booking date">${days.map(day => `<a href="#wf-transport-day-${day.date || 'unscheduled'}" onclick="event.preventDefault();document.getElementById(this.hash.slice(1))?.scrollIntoView({block:'start',behavior:'smooth'})">
        <span class="wf-transport-overview-date">${wfEscape(wfTransportDateLabel(day.date))}<small class="wf-transport-overview-context">${wfEscape(wfTransportEventDayLabel(day.date, data.event) || (day.date ? '' : 'Date to confirm'))}</small></span>
        <span class="wf-transport-type-list">${wfTransportTypeChips(day.types)}</span>
        <span class="wf-transport-overview-total">${day.vehicleCount} vehicle${day.vehicleCount === 1 ? '' : 's'} · ${day.entries.length} trip${day.entries.length === 1 ? '' : 's'}<span aria-hidden="true">↓</span></span>
      </a>`).join('')}</nav>
    </section><div class="wf-transport-schedule-heading"><h3>Bookings</h3><p>Select a booking for driver, contact and full trip details.</p></div><div class="wf-transport-schedule">${days.map(day => wfTransportDayHtml(day, data.event)).join('')}</div>`
      : `<section class="wf-panel wf-transport-empty"><span class="wf-booking-icon">${wfMetricIconSvg('transport')}</span><h3>No transport booked yet</h3>
        <p>Book a vehicle to start this event’s daily transport schedule.</p><button class="wf-button primary" type="button" onclick="openTransportBooking()">Book transport</button></section>`}`;
  root.querySelectorAll('details[data-transport-booking-id]').forEach(node => {
    node.open = openBookingIds.has(node.dataset.transportBookingId);
  });
  if (workforcePageState.transportFocusBookingId) {
    const targetId = workforcePageState.transportFocusBookingId;
    workforcePageState.transportFocusBookingId = '';
    requestAnimationFrame(() => wfFocusTransportBooking(targetId));
  }
}

function renderWorkforcePage() {
  if (document.getElementById('transport-section')?.classList.contains('active')) {
    renderTransportPage();
    return;
  }
  const root = document.getElementById('workforce-page-root');
  const data = workforcePageState.data;
  if (!root || !data) return;
  const viewState = captureWorkforceViewState(root);
  const validSubprojectIds = new Set([
    'all',
    ...wfSubprojects().map(room => String(room.id))
  ]);
  if (!validSubprojectIds.has(String(workforcePageState.activeSubprojectId))) {
    workforcePageState.activeSubprojectId = 'all';
  }
  if (
    workforcePageState.viewMode === 'schedule' &&
    typeof renderWorkforceSchedulePage === 'function'
  ) {
    renderWorkforceSchedulePage(root, data);
    return;
  }
  const activeSubprojectId = String(workforcePageState.activeSubprojectId);
  const visibleAssignments = activeSubprojectId === 'all'
    ? data.assignments
    : data.assignments.filter(row =>
      wfEffectiveSubprojectId(row) === activeSubprojectId
    );
  const grouped = Object.fromEntries(
    (data.departments || []).map(row => [row.code, []])
  );
  visibleAssignments.forEach(row => {
    const department = row.department || (row.subjectType === 'app-user' ? 'FT' : 'Unassigned');
    (grouped[department] ||= []).push(row);
  });
  const departments = Object.entries(grouped)
    .sort(([a], [b]) => wfDepartmentMeta(a).name.localeCompare(wfDepartmentMeta(b).name))
    .map(([department, rows]) =>
      wfDepartmentHtml(department, rows)
    ).join('');
  const totals = data.totals || {};
  root.innerHTML = `
    <div class="plan-page-heading wf-manpower-page-heading">
      <div><div class="wf-manpower-title-row"><h2>Crew &amp; Vendors</h2>
        ${canCurrentUserViewAllInvoiceClaims() ? `<button class="wf-button primary" type="button" onclick="showSection('invoice-claims')">
          View all invoices &amp; claims
        </button>` : ''}
      </div>
      <p>Assign workers and vendors, then review their invoices and claims.</p></div>
      <div class="wf-manpower-heading-actions">
        ${typeof wfWorkforceViewSwitchHtml === 'function' ? wfWorkforceViewSwitchHtml() : ''}
      </div>
    </div>

    <div class="wf-plan-layout">
      <div class="wf-plan-primary">
        <div class="plan-event-bar">
          ${wfManpowerEventPickerHtml(data, 'Choose an event for crew and vendors')}

          <div class="plan-metrics">
            <div class="plan-metric">
              <div class="plan-metric-icon wf-metric-invoice">${wfMetricIconSvg('invoice')}</div>
              <div><strong>${wfMoney(totals.invoice)}</strong><span>Invoices</span></div>
            </div>
            <div class="plan-metric">
              <div class="plan-metric-icon wf-metric-claims">${wfMetricIconSvg('claims')}</div>
              <div><strong>${wfMoney(totals.claims)}</strong><span>Claims</span></div>
            </div>
            <div class="plan-metric">
              <div class="plan-metric-icon wf-metric-transport">${wfMetricIconSvg('combined')}</div>
              <div><strong>${visibleAssignments.length}</strong><span>Assignments</span></div>
            </div>
            <div class="plan-metric">
              <div class="plan-metric-icon wf-metric-combined">${wfMetricIconSvg('combined')}</div>
              <div><strong>${Object.keys(grouped).length + ((data.transportBookings || []).length ? 1 : 0)}</strong><span>Departments</span></div>
            </div>
          </div>
        </div>

        ${wfSubprojectTabsHtml()}

        <section class="wf-panel wf-manpower-panel">
          <header class="wf-panel-header">
            <div>
              <h3>Crew &amp; Vendors</h3>
              <p>Departments are created automatically from this event’s outgoing assets.</p>
            </div>
            <div class="wf-toolbar">
              <a class="wf-button" href="/api/events/${data.event.id}/workforce/download/invoices">Download invoices (.zip)</a>
              <a class="wf-button" href="/api/events/${data.event.id}/workforce/download/claims">Download claims (.zip)</a>
              <button class="wf-button" type="button" onclick="openManualDepartment()">+ Department</button>
              <button class="wf-button primary" type="button" onclick="openFreelancerDirectory('manage')">Manage Worker/Vendor</button>
            </div>
          </header>
          <div>${departments || ((data.transportBookings || []).length ? '' : '<div class="wf-empty">No asset departments detected. Add one manually to begin.</div>')}${wfCrewTransportCategoryHtml()}</div>
        </section>
      </div>

    </div>
  `;
  restoreWorkforceViewState(root, viewState);
  if (document.getElementById('wfFreelancerDirectoryModal')?.classList.contains('open')) {
    renderFreelancerDirectory(
      document.getElementById('wfFreelancerSearch')?.value || ''
    );
  }
  if (workforcePageState.focusTarget === 'transport') {
    workforcePageState.focusTarget = '';
    requestAnimationFrame(() => {
      const panel = root.querySelector('.wf-transport-panel');
      panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  } else if (workforcePageState.focusTarget.startsWith('review-claim:')) {
    const submissionId = workforcePageState.focusTarget.slice('review-claim:'.length);
    workforcePageState.focusTarget = '';
    requestAnimationFrame(() => openWorkforceReview(submissionId));
  }
}

function wfModal(id, title, body, footer = '', wide = false) {
  return `<div class="wf-modal" id="${id}" aria-hidden="true"><div class="wf-modal-backdrop" onclick="closeWorkforceModal('${id}')"></div>
    <section class="wf-modal-card ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <header class="wf-modal-header"><h3 id="${id}Title">${title}</h3>
        <button class="wf-icon-button" type="button" onclick="closeWorkforceModal('${id}')">&times;</button></header>
      <div class="wf-modal-scroll">${body}</div>${footer}</section></div>`;
}

function ensureWorkforceModals() {
  if (document.getElementById('wfFreelancerDirectoryModal')) return;
  document.body.insertAdjacentHTML('beforeend',
    wfModal('wfFreelancerDirectoryModal', 'Manage Worker/Vendor', `<div class="wf-modal-body">
      <div class="wf-directory-toolbar"><input class="wf-search" id="wfFreelancerSearch" type="search" placeholder="Search workers, vendors, phones or email" oninput="renderFreelancerDirectory(this.value)">
        <div><button class="wf-button" type="button" onclick="openVendorProfile()">Enroll New Vendor</button>
          <button class="wf-button primary" type="button" onclick="openFreelancerProfile()">Enroll new worker</button></div></div>
      <div class="wf-directory-list wf-directory-grid" id="wfFreelancerDirectoryList"></div></div>`, '', true) +
    wfModal('wfFreelancerHistoryModal', 'Worker Overview', `<div class="wf-modal-body" id="wfFreelancerHistoryContent"></div>`, '', true) +
    wfModal('wfFreelancerProfileModal', 'Enroll New Worker', `<form id="wfFreelancerProfileForm">
      <div class="wf-modal-body"><div class="wf-form-grid">
        <label class="wf-field full"><span>Full name *</span><input id="wfFreelancerName" required maxlength="120"></label>
        <label class="wf-field"><span>Phone number</span><input id="wfFreelancerPhone" type="tel"></label>
        <label class="wf-field"><span>Email</span><input id="wfFreelancerEmail" type="email"></label>
        <input id="wfFreelancerCompany" type="hidden">
        <label class="wf-field full"><span>Notes</span><textarea id="wfFreelancerNotes"></textarea></label>
        <label class="wf-check full"><input id="wfFreelancerActive" type="checkbox" checked> Active profile</label>
        <div class="wf-worker-login full" id="wfWorkerLoginControls" hidden>
          <div><span>Worker portal login</span><strong id="wfWorkerLoginStatus">Setup required</strong>
            <small id="wfWorkerLastLogin">Last login: Never</small></div>
          <button class="wf-button danger" id="wfResetWorkerLogin" type="button"
            onclick="resetFreelancerLogin()">Reset worker login</button>
        </div>
      </div><div class="wf-error" id="wfFreelancerProfileError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button danger wf-modal-danger-action" id="wfDeleteFreelancerButton" type="button" onclick="deleteFreelancerProfile()" hidden>Delete Worker</button>
        <button class="wf-button" type="button" onclick="closeWorkforceModal('wfFreelancerProfileModal')">Cancel</button>
        <button class="wf-button primary" type="submit">Save Worker</button></footer></form>`) +
    wfModal('wfAssignmentModal', 'Event Assignment', `<form id="wfAssignmentForm">
      <div class="wf-modal-body"><p class="wf-form-intro" id="wfAssignmentFreelancerName"></p><div class="wf-form-grid">
        <label class="wf-field"><span>Department *</span><select id="wfAssignmentDepartment" data-department-select="true" required></select></label>
        <label class="wf-field wf-room-field"><span>Room / Sub-project *</span><select id="wfAssignmentSubproject"></select></label>
        <label class="wf-field"><span>Role / Position</span><input id="wfAssignmentRole" maxlength="100"></label>
        <label class="wf-field"><span>Daily rate ($)</span><input id="wfAssignmentRate" type="number" min="0" step=".01"></label>
        <div class="wf-field full"><span>Working dates *</span><div class="wf-date-calendar" id="wfAssignmentDates"></div></div>
      </div><div class="wf-error" id="wfAssignmentError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfAssignmentModal')">Cancel</button>
        <button class="wf-button primary" type="submit">Add Assignment</button></footer></form>`, '', true) +
    wfModal('wfVendorProfileModal', 'Enroll New Vendor', `<form id="wfVendorProfileForm">
      <div class="wf-modal-body"><div class="wf-form-grid">
        <label class="wf-field full"><span>Vendor name *</span><input id="wfVendorName" required maxlength="120"></label>
        <div class="wf-field full"><span>Members with portal access</span>
          <p class="wf-help">Members use their own phone and PIN/password. The same person may belong to several vendors.</p>
          <div class="wf-member-search-row"><input class="wf-search" id="wfVendorMemberSearch" type="search" placeholder="Search workers or personnel"
              oninput="renderVendorMemberPicker(this.value)">
            <button class="wf-button" type="button" onclick="openVendorPersonnel()">+ Add Personnel</button></div>
          <div class="wf-member-picker" id="wfVendorMemberPicker"></div>
        </div>
        <label class="wf-field full"><span>Notes</span><textarea id="wfVendorNotes"></textarea></label>
        <label class="wf-check full"><input id="wfVendorActive" type="checkbox" checked> Active vendor</label>
      </div><div class="wf-error" id="wfVendorProfileError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button danger wf-modal-danger-action" id="wfDeleteVendorButton" type="button" onclick="deleteVendorProfile()" hidden>Delete Vendor</button>
        <button class="wf-button" type="button" onclick="closeWorkforceModal('wfVendorProfileModal')">Cancel</button>
        <button class="wf-button primary" type="submit">Save Vendor</button></footer></form>`, '', true) +
    wfModal('wfVendorPersonnelModal', 'Add Personnel', `<form id="wfVendorPersonnelForm">
      <div class="wf-modal-body"><div class="wf-form-grid">
        <label class="wf-field full"><span>Full name *</span><input id="wfPersonnelName" required maxlength="120"></label>
        <label class="wf-field"><span>Phone number *</span><input id="wfPersonnelPhone" type="tel" required></label>
        <label class="wf-field"><span>Email</span><input id="wfPersonnelEmail" type="email"></label>
        <label class="wf-field full"><span>Notes</span><textarea id="wfPersonnelNotes"></textarea></label>
      </div><div class="wf-error" id="wfVendorPersonnelError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfVendorPersonnelModal')">Cancel</button>
        <button class="wf-button primary" type="submit">Add Personnel</button></footer></form>`) +
    wfModal('wfVendorAssignmentModal', 'Vendor Event Assignment', `<form id="wfVendorAssignmentForm">
      <div class="wf-modal-body"><p class="wf-form-intro" id="wfVendorAssignmentName"></p><div class="wf-form-grid">
        <label class="wf-field"><span>Department *</span><select id="wfVendorAssignmentDepartment" data-department-select="true" required></select></label>
        <label class="wf-field wf-room-field"><span>Room / Sub-project *</span><select id="wfVendorAssignmentSubproject"></select></label>
        <div class="wf-field"><span>Providing *</span><div class="wf-provider-choice">
          <label><input type="radio" name="wfProviderType" value="manpower" checked onchange="syncVendorAssignmentFields()"> Crew &amp; Vendors</label>
          <label><input type="radio" name="wfProviderType" value="service" onchange="syncVendorAssignmentFields()"> Service</label>
        </div></div>
        <div class="wf-field full"><span>Working dates *</span><div class="wf-date-calendar" id="wfVendorAssignmentDates"></div></div>
        <div class="wf-form-grid full" id="wfVendorManpowerFields">
          <label class="wf-field"><span>Number of pax *</span><input id="wfVendorPax" type="number" min="1" step="1"></label>
          <label class="wf-field"><span>Rate per pax / day ($) *</span><input id="wfVendorRatePerPax" type="number" min="0" step=".01"></label>
        </div>
        <div class="wf-form-grid full" id="wfVendorServiceFields" hidden>
          <label class="wf-field"><span>Name of service *</span><input id="wfVendorServiceName" maxlength="120"></label>
          <label class="wf-field"><span>Cost ($) *</span><input id="wfVendorServiceCost" type="number" min="0" step=".01"></label>
        </div>
      </div><div class="wf-error" id="wfVendorAssignmentError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfVendorAssignmentModal')">Cancel</button>
        <button class="wf-button primary" type="submit">Add Assignment</button></footer></form>`, '', true) +
    wfModal('wfDepartmentModal', 'Add Department', `<form id="wfDepartmentForm"><div class="wf-modal-body"><div class="wf-form-grid">
      <label class="wf-field full"><span>Configured department</span><select id="wfDepartmentPreset" data-department-select="true" onchange="syncDepartmentPreset()"></select></label>
      <label class="wf-field"><span>Department code *</span><input id="wfDepartmentCode" maxlength="12" required></label>
      <label class="wf-field"><span>Department name</span><input id="wfDepartmentName" maxlength="80"></label>
      </div><div class="wf-error" id="wfDepartmentError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfDepartmentModal')">Cancel</button>
      <button class="wf-button primary" type="submit">Add Department</button></footer></form>`) +
    wfModal('wfTransportDirectoryModal', 'Manage Transport', `<div class="wf-modal-body">
      <div class="wf-directory-toolbar"><input class="wf-search" id="wfTransportSearch" type="search" placeholder="Search vehicle or provider" oninput="renderTransportDirectory(this.value)">
        <div><button class="wf-button" type="button" onclick="openLocationsManager()">Manage Locations</button>
          <button class="wf-button fleet" type="button" onclick="manageOwnVehicles()">Manage own vehicles</button>
          <button class="wf-button primary" type="button" onclick="openTransportProfile()">Add vehicle or provider</button></div></div>
      <div class="wf-directory-list wf-directory-grid" id="wfTransportDirectoryList"></div></div>`, '', true) +
    wfModal('wfTransportProfileModal', 'Add New Transport', `<form id="wfTransportProfileForm"><div class="wf-modal-body">
      <input id="wfProfileType" type="hidden" value="vehicle">
      <div class="wf-form-grid"><div class="wf-field full"><span>What are you saving?</span><div class="wf-segmented">
          <button type="button" id="wfProfileTypeVehicle" class="active" onclick="setTransportProfileType('vehicle')">Known vehicle</button>
          <button type="button" id="wfProfileTypeOnDemand" onclick="setTransportProfileType('on_demand')">On-demand provider</button>
        </div><small class="wf-field-help" id="wfProfileTypeHelp">Save a vehicle that you expect to book again.</small></div>
        <label class="wf-field" id="wfProfileVehicleTypeField"><span id="wfProfileVehicleTypeLabel">Vehicle type *</span><input id="wfProfileVehicleType" required></label>
        <label class="wf-field"><span id="wfProfileCompanyLabel">Company</span><input id="wfProfileCompany"></label>
        <label class="wf-field"><span>Contact number</span><input id="wfProfileContact" type="tel"></label>
        <label class="wf-field full" id="wfProfileVehicleNumberField"><span>Vehicle / Lorry number</span><input id="wfProfileVehicleNumber"></label>
      </div><div class="wf-error" id="wfTransportProfileError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfTransportProfileModal')">Cancel</button>
        <button class="wf-button primary" type="submit">Save Transport</button></footer></form>`) +
    wfModal('wfLocationsModal', 'Manage Locations', `<div class="wf-modal-body">
      <form class="wf-inline-form wf-location-form" id="wfLocationForm"><input class="wf-search" id="wfLocationName" placeholder="Location label" aria-label="Location label" required>
        <input class="wf-search" id="wfLocationAddress" placeholder="Exact address (optional)" aria-label="Exact address">
        <button class="wf-button primary" id="wfLocationSubmit" type="submit">Add Location</button>
        <button class="wf-button" id="wfLocationCancelEdit" type="button" hidden onclick="cancelTransportLocationEdit()">Cancel</button></form>
      <div class="wf-directory-list" id="wfLocationsList"></div><div class="wf-error" id="wfLocationError"></div></div>`) +
    wfModal('wfTransportBookingModal', 'Add Transport to Event', `<form id="wfTransportBookingForm"><div class="wf-modal-body">
      <div class="wf-transport-choice-row single">
        <div><span>Trip</span><div class="wf-segmented">
          <button type="button" id="wfTripDepart" class="active" onclick="setTransportTripType('depart')">Depart</button>
          <button type="button" id="wfTripReturn" onclick="setTransportTripType('return')">Return</button>
        </div></div>
      </div>
      <input id="wfTransportTripType" type="hidden" value="depart">
      <input id="wfTransportSourceType" type="hidden" value="">
      <div class="wf-form-grid">
        <label class="wf-field wf-room-field full"><span>Room / Sub-project *</span><select id="wfTransportSubproject"></select></label>
        <div class="wf-form-grid wf-single-driver-fields full" id="wfSingleDriverFields">
          <label class="wf-field"><span>Driver</span><span class="wf-location-combobox wf-driver-combobox" onfocusout="wfTransportDriverFocusOut(event)">
            <input id="wfTransportDriver" placeholder="Driver name" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="wfTransportDriverSuggestions"
              onfocus="wfShowTransportDriverSuggestions(this)" oninput="wfTransportDriverInput(this)" onkeydown="wfTransportDriverSuggestionKeydown(event)">
            <span class="wf-location-suggestions wf-driver-suggestions" id="wfTransportDriverSuggestions" role="listbox"></span>
          </span></label>
          <label class="wf-field"><span>Driver phone</span><input id="wfTransportDriverContact" type="tel" placeholder="+65 9123 4567" oninput="wfTransportDriverPhoneInput(this)"></label>
        </div>
        <label class="wf-field"><span>Trip Date *</span><input id="wfDepartDate" type="date" required oninput="syncTransportUsageDate()"></label>
        <label class="wf-field"><span>Depart Time *</span><input id="wfDepartTime" type="time" required oninput="scheduleTransportAvailability()"></label>
        <div class="wf-return-fields wf-fleet-window full" id="wfFleetUsageFields">
          <label class="wf-field"><span>Vehicle Return Date</span><input id="wfVehicleUseEndDate" type="date" oninput="scheduleTransportAvailability()"></label>
          <label class="wf-field"><span>Vehicle Return Time</span><input id="wfVehicleUseEndTime" type="time" oninput="scheduleTransportAvailability()"></label>
          <small>Return time is required for company vehicles. The return date defaults to the trip date.</small>
        </div>
        <label class="wf-field"><span>From label *</span><span class="wf-location-combobox"><input id="wfLocationFrom" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="wfLocationFromSuggestions" required onfocus="wfShowBookingLocationSuggestions('from',this.value)" oninput="wfBookingLocationInput('from')" onkeydown="wfBookingLocationSuggestionKeydown(event,'from')" onblur="setTimeout(()=>wfCloseBookingLocationSuggestions('from'),120)"><span class="wf-location-suggestions" id="wfLocationFromSuggestions" role="listbox"></span></span></label>
        <label class="wf-field"><span>From address</span><input id="wfLocationFromAddress" placeholder="Street address"></label>
        <label class="wf-field"><span>To label *</span><span class="wf-location-combobox"><input id="wfLocationTo" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="wfLocationToSuggestions" required onfocus="wfShowBookingLocationSuggestions('to',this.value)" oninput="wfBookingLocationInput('to')" onkeydown="wfBookingLocationSuggestionKeydown(event,'to')" onblur="setTimeout(()=>wfCloseBookingLocationSuggestions('to'),120)"><span class="wf-location-suggestions" id="wfLocationToSuggestions" role="listbox"></span></span></label>
        <label class="wf-field"><span>To address</span><input id="wfLocationToAddress" placeholder="Street address"></label>
        <label class="wf-check full"><input id="wfSaveBookingLocations" type="checkbox" checked> Save these locations for future bookings</label>
        <label class="wf-field full"><span>Cost (per trip, $)</span><input id="wfTransportCost" type="number" min="0" step=".01" value="0"></label>
      </div>
      <section class="wf-booking-vehicle-section">
        <div class="wf-booking-vehicle-heading"><div><h4>Choose vehicles or an on-demand provider</h4><p>Selected vehicles will share the trip details above.</p></div>
          <button class="wf-button" type="button" onclick="openTransportProfileForBooking()">+ Add transport</button></div>
        <div class="wf-booking-selection-summary" id="wfBookingSelectionSummary">No vehicles selected</div>
        <div class="wf-on-demand-booking" id="wfOnDemandBookingFields" hidden>
          <div><strong id="wfOnDemandProviderName">On-demand provider</strong><small>Driver and registration details are assigned by the provider for each trip.</small></div>
          <div class="wf-form-grid">
            <label class="wf-field"><span>Vehicle type *</span><input id="wfOnDemandVehicleType" placeholder="e.g. 10ft lorry" oninput="setTransportBookingSource('external')"></label>
            <label class="wf-field" id="wfOnDemandQuantityField"><span>Number of vehicles *</span><input id="wfOnDemandQuantity" type="number" min="1" max="50" step="1" value="1" oninput="setTransportBookingSource('external')"></label>
          </div>
        </div>
        <input id="wfBookingVendor" type="hidden">
        <input id="wfBookingFleetVehicle" type="hidden">
        <div class="wf-booking-source-group"><div class="wf-booking-source-title"><strong>Own fleet</strong>
          <button class="wf-link-button" type="button" onclick="manageOwnVehicles()">Manage own vehicles</button></div>
          <div id="wfFleetVehicleChoices" class="wf-booking-vehicle-grid"></div></div>
        <div class="wf-booking-source-group"><div class="wf-booking-source-title"><strong>External transport</strong></div>
          <div id="wfExternalVehicleChoices" class="wf-booking-vehicle-grid"></div></div>
        <section class="wf-booking-drivers" id="wfBookingDrivers" hidden></section>
      </section>
      <div class="wf-error" id="wfTransportBookingError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfTransportBookingModal')">Cancel</button>
        <button class="wf-button primary" id="wfTransportBookingSubmit" type="submit">Add to Event</button></footer></form>`) +
    wfModal('wfAdminUploadModal', 'Upload for Crew', `<form id="wfAdminUploadForm">
      <input id="wfAdminUploadFreelancerId" type="hidden"><input id="wfAdminUploadKind" name="kind" type="hidden">
      <div class="wf-modal-body"><p class="wf-form-intro" id="wfAdminUploadSubtitle"></p>
        <div id="wfAdminInvoiceFields"><p class="wf-help">Invoice details will be read when supported and verified during review.</p></div>
        <div id="wfAdminClaimFields" hidden><p class="wf-help">Claim amount and date will be analysed after upload. Verify them during review.</p></div>
        <label class="wf-field wf-admin-dropzone" id="wfAdminUploadDropzone"><span id="wfAdminUploadFileLabel">Invoice PDF *</span><input id="wfAdminUploadFile" name="files" type="file" required><strong id="wfAdminUploadDropPrompt">Drag &amp; drop or choose a file</strong><div class="wf-admin-selected-files" id="wfAdminUploadSelectedFiles">No file selected</div></label>
        <div class="wf-error" id="wfAdminUploadError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfAdminUploadModal')">Cancel</button>
        <button class="wf-button primary" type="submit">Upload File</button></footer></form>`) +
    wfModal('wfReviewModal', 'Review Submission', `<div id="wfReviewContent"></div>`, '', true) +
    wfModal('wfDenialReasonModal', 'Deny Submission', `<form id="wfDenialReasonForm">
      <div class="wf-modal-body">
        <p class="wf-form-intro">You may explain why this submission was denied. The worker can view this reason.</p>
        <label class="wf-field"><span>Reason (optional)</span>
          <textarea id="wfDenialReason" maxlength="500" placeholder="e.g. Incorrect billing company or unreadable receipt"></textarea>
        </label>
        <div class="wf-error" id="wfDenialReasonError"></div>
      </div>
      <footer class="wf-modal-actions">
        <button class="wf-button" type="button" onclick="cancelWorkforceDenial()">Cancel</button>
        <button class="wf-button danger" type="submit">Deny Submission</button>
      </footer>
    </form>`)
  );
  document.getElementById('wfFreelancerProfileForm').addEventListener('submit', saveFreelancerProfile);
  document.getElementById('wfAssignmentForm').addEventListener('submit', saveFreelancerAssignment);
  document.getElementById('wfVendorProfileForm').addEventListener('submit', saveVendorProfile);
  document.getElementById('wfVendorPersonnelForm').addEventListener('submit', saveVendorPersonnel);
  document.getElementById('wfVendorAssignmentForm').addEventListener('submit', saveVendorAssignment);
  document.getElementById('wfDepartmentForm').addEventListener('submit', saveManualDepartment);
  document.getElementById('wfTransportProfileForm').addEventListener('submit', saveTransportProfile);
  document.getElementById('wfLocationForm').addEventListener('submit', saveTransportLocation);
  document.getElementById('wfTransportBookingForm').addEventListener('submit', saveTransportBooking);
  document.getElementById('wfAdminUploadForm').addEventListener('submit', submitAdminWorkforceUpload);
  setupAdminWorkforceDropzone();
  document.getElementById('wfDenialReasonForm').addEventListener('submit', saveWorkforceDenialReason);
}

function setupAdminWorkforceDropzone() {
  const zone = document.getElementById('wfAdminUploadDropzone');
  const input = document.getElementById('wfAdminUploadFile');
  if (!zone || !input || zone.dataset.dropReady === 'true') return;
  zone.dataset.dropReady = 'true';
  ['dragenter', 'dragover'].forEach(name => zone.addEventListener(name, event => {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach(name => zone.addEventListener(name, event => {
    event.preventDefault();
    event.stopPropagation();
    zone.classList.remove('dragging');
  }));
  zone.addEventListener('drop', event => {
    const incoming = [...(event.dataTransfer?.files || [])];
    if (!incoming.length) return;
    const chosen = input.multiple ? incoming : incoming.slice(0, 1);
    const transfer = new DataTransfer();
    chosen.forEach(file => transfer.items.add(file));
    input.files = transfer.files;
    updateAdminWorkforceDropzoneFiles();
  });
  input.addEventListener('change', updateAdminWorkforceDropzoneFiles);
}

function updateAdminWorkforceDropzoneFiles() {
  const input = document.getElementById('wfAdminUploadFile');
  const label = document.getElementById('wfAdminUploadSelectedFiles');
  if (!input || !label) return;
  const files = [...input.files];
  if (!files.length) {
    label.textContent = 'No file selected';
    return;
  }
  label.innerHTML = files.map(file => {
    return `<span class="wf-admin-selected-file">
      <strong title="${wfAttr(file.name)}">${wfEscape(file.name)}</strong>
      <small>Ready</small>
    </span>`;
  }).join('');
}

function wfUpdatePendingUploadProgress(row) {
  const percent = Math.max(0, Math.min(100, Number(row.uploadProgress || 0)));
  const label = row.status === 'Uploading' ? `${Math.round(percent)}%` : row.status;
  document.querySelectorAll(`[data-wf-upload-progress="${CSS.escape(row.id)}"]`)
    .forEach(node => { node.style.width = `${percent}%`; });
  document.querySelectorAll(`[data-wf-upload-label="${CSS.escape(row.id)}"]`)
    .forEach(node => { node.textContent = label; });
}

function openWorkforceModal(id) {
  ensureWorkforceModals();
  const modal = document.getElementById(id);
  const openModals = [...document.querySelectorAll('.wf-modal.open')]
    .filter(row => row !== modal);
  const topLayer = Math.max(2000, ...openModals.map(row =>
    Number(row.style.zIndex) || 2000
  ));
  modal.style.zIndex = openModals.length ? String(topLayer + 1) : '';
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeWorkforceModal(id) {
  const modal = document.getElementById(id);
  const returnToHistory = Boolean(
    modal?.classList.contains('open') &&
    ['wfReviewModal', 'wfAdminUploadModal'].includes(id) &&
    workforcePageState.historyReturnFreelancerId
  );
  const returnToFreelancerWorkspace = Boolean(
    modal?.classList.contains('open') &&
    ['wfAssignmentModal', 'wfVendorAssignmentModal'].includes(id) &&
    workforcePageState.freelancerWorkspaceReturnId
  );
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    modal.style.zIndex = '';
  }
  if (!document.querySelector('.wf-modal.open')) document.body.style.overflow = '';
  if (returnToHistory) {
    const returnId = workforcePageState.historyReturnFreelancerId;
    workforcePageState.historyReturnFreelancerId = null;
    openFreelancerHistory(returnId);
  }
  if (returnToFreelancerWorkspace) {
    const returnId = workforcePageState.freelancerWorkspaceReturnId;
    workforcePageState.freelancerWorkspaceReturnId = null;
    openFreelancerHistory(returnId);
  }
}

function wfError(id, message = '') {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('show', Boolean(message));
}

function openWorkforceEventChooser() {
  planOpenEventChooser('workforce');
  refreshWorkforceEventChooserOptions();
}

async function refreshWorkforceEventChooserOptions() {
  const requestId = ++workforceEventChooserState.requestId;
  const renderIfOpen = () => {
    if (
      requestId === workforceEventChooserState.requestId &&
      planEventChooserState.context === 'workforce' &&
      document.getElementById('planEventChooserModal')?.classList.contains('active')
    ) renderPlanEventChooser();
  };
  try {
    const eventOptionsLoad = await startProgressiveEventOptions(
      workforcePageState.eventId,
      loaded => {
        if (requestId !== workforceEventChooserState.requestId) return;
        workforcePageState.eventOptions = loaded.slice().sort(planCompareEventsByStartDate);
        renderIfOpen();
      }
    );
    if (requestId !== workforceEventChooserState.requestId) return;
    workforcePageState.eventOptions = eventOptionsLoad.first
      .slice()
      .sort(planCompareEventsByStartDate);
    renderIfOpen();
    const loaded = await eventOptionsLoad.completion;
    if (requestId !== workforceEventChooserState.requestId) return;
    workforcePageState.eventOptions = loaded.slice().sort(planCompareEventsByStartDate);
    renderIfOpen();
  } catch (error) {
    console.warn('Unable to refresh event options:', error);
  }
}

function wfDirectorySummaryBadges(summary = {}) {
  return [
    ['needsInvoice', 'awaiting invoice', 'invoice', 'No active invoice has been uploaded'],
    ['needsReview', 'to review', 'review', 'A submission is ready for review'],
    ['needsPayment', 'to pay', 'payment', 'An approved submission is awaiting payment'],
    ['needsReceipt', 'awaiting confirmation', 'confirmation', 'Payment is awaiting recipient confirmation'],
  ].map(([key, label, tone, help]) => {
    const count = Number(summary[key] || 0);
    return count > 0
      ? `<small class="wf-summary-badge is-${tone}" title="${wfAttr(help)}"><b>${count}</b> ${label}</small>`
      : '';
  }).join('');
}

function openFreelancerDirectory(mode = 'manage', department = '') {
  ensureWorkforceModals();
  workforcePageState.directoryMode = mode;
  workforcePageState.directoryDepartment = department;
  document.getElementById('wfFreelancerDirectoryModalTitle').textContent =
    mode === 'assign' ? `Add Worker or Full-time Staff to ${department}` : 'Manage Worker/Vendor';
  document.getElementById('wfFreelancerSearch').value = '';
  renderFreelancerDirectory('');
  openWorkforceModal('wfFreelancerDirectoryModal');
}

function renderFreelancerDirectory(search) {
  const query = String(search || '').toLowerCase();
  const workers = wfDirectoryFreelancers().filter(row =>
    !row.personnelOnly &&
    `${row.name} ${row.phone || ''} ${row.email || ''} ${row.company || ''}`.toLowerCase().includes(query));
  const appUsers = workforcePageState.directoryMode === 'assign'
    ? (workforcePageState.data?.appUsers || []).filter(row =>
      `${row.name || ''} ${row.username || ''} ${row.phone || ''}`.toLowerCase().includes(query)
    )
    : [];
  const vendors = workforcePageState.directoryMode === 'manage'
    ? wfDirectoryVendors().filter(row =>
      `${row.name} ${(row.members || []).map(member => `${member.name} ${member.phone || ''}`).join(' ')}`
        .toLowerCase().includes(query)
    )
    : [];
  const outstanding = row => {
    const summary = row.submissionSummary || {};
    return ['needsInvoice', 'needsReview', 'needsPayment', 'needsReceipt']
      .reduce((total, key) => total + Number(summary[key] || 0), 0);
  };
  const entries = [
    ...appUsers.map(row => ({ type: 'app-user', row })),
    ...workers.map(row => ({ type: 'worker', row })),
    ...vendors.map(row => ({ type: 'vendor', row }))
  ];
  if (workforcePageState.directoryMode === 'manage') {
    entries.sort((left, right) =>
      outstanding(right.row) - outstanding(left.row) ||
      String(left.row.name || '').localeCompare(String(right.row.name || ''))
    );
  }
  const cards = entries.map(({ type, row }) => {
    const summary = row.submissionSummary || {};
    if (type === 'app-user') {
      const name = row.name || row.username || 'App user';
      return `<article class="wf-directory-row wf-directory-card"
        onclick="openFullTimeStaffAssignment('','${wfAttr(row.username)}','${wfAttr(workforcePageState.directoryDepartment)}')">
        <span class="wf-avatar staff">${wfEscape(wfInitials(name))}</span>
        <span><strong>${wfEscape(name)}</strong>
          <small class="wf-directory-phone">Full-time staff${row.phone ? ` &middot; ${wfEscape(wfFormatPhone(row.phone))}` : ''}</small></span>
        <span class="wf-directory-action">Select &rsaquo;</span>
      </article>`;
    }
    if (type === 'vendor') {
      const lastLogin = row.workerLastLoginAt
        ? `Last login: ${wfEscape(wfDateTime(row.workerLastLoginAt))} by ${wfEscape(row.workerLastLoginBy || 'Unknown member')}`
        : 'Last login: Never';
      const telegramAccounts = row.telegramAccounts || [];
      const telegramBadges = telegramAccounts.map(account => {
        const identity = account.telegramUsername
          ? `@${account.telegramUsername}`
          : (account.displayName || 'Telegram linked');
        const title = account.memberName
          ? `${account.memberName}'s linked Telegram account`
          : 'Linked Telegram account';
        return `<span class="wf-login-indicator telegram" title="${wfAttr(title)}">${wfEscape(identity)}</span>`;
      }).join('');
      return `<article class="wf-directory-row wf-directory-card wf-vendor-directory-card"
        onclick="openFreelancerHistory('${wfAttr(row.id)}')">
        <span class="wf-avatar vendor">${wfEscape(wfInitials(row.name))}</span>
        <span><strong>${wfEscape(row.name)}</strong>
          <small class="wf-directory-phone">${Number(row.members?.length || 0)} member${Number(row.members?.length || 0) === 1 ? '' : 's'} with portal access ${telegramBadges}</small>
          <span class="wf-worker-summary">
            ${wfDirectorySummaryBadges(summary)}
          </span>
        </span>
        <button class="wf-mini-button" type="button"
          onclick="event.stopPropagation();openVendorProfile('${wfAttr(row.id)}')">Edit</button>
        <small class="wf-last-login">${lastLogin}</small>
      </article>`;
    }
    const telegram = row.telegram || {};
    const telegramIdentity = telegram.telegramUsername
      ? `@${telegram.telegramUsername}`
      : (telegram.displayName || 'Telegram linked');
    const telegramBadge = telegram.connected
      ? `<span class="wf-login-indicator telegram" title="Linked Telegram account">${wfEscape(telegramIdentity)}</span>`
      : '';
    const loginBadge = workforcePageState.directoryMode === 'manage'
      ? (telegramBadge || `<span class="wf-login-indicator ${row.workerLoginConfigured ? 'configured' : ''}">
          ${row.workerLoginConfigured ? 'Login set' : 'Setup required'}
        </span>`)
      : '';
    return `<article class="wf-directory-row wf-directory-card" onclick="${workforcePageState.directoryMode === 'assign'
      ? `openFreelancerAssignment('${wfAttr(row.id)}','${wfAttr(workforcePageState.directoryDepartment)}')`
      : `openFreelancerHistory('${wfAttr(row.id)}')`}">
      <span class="wf-avatar">${wfEscape(wfInitials(row.name))}</span><span><strong>${wfEscape(row.name)}</strong>
      <small class="wf-directory-phone">${wfEscape(wfFormatPhone(row.phone) || 'No phone')} ${loginBadge}</small>
      ${workforcePageState.directoryMode === 'manage' ? `<span class="wf-worker-summary">
        ${wfDirectorySummaryBadges(summary)}
      </span>` : ''}</span>
      ${workforcePageState.directoryMode === 'assign'
        ? '<span class="wf-directory-action">Select &rsaquo;</span>'
        : `<button class="wf-mini-button" type="button" onclick="event.stopPropagation();openFreelancerProfile('${wfAttr(row.id)}')">Edit</button>`}
      <small class="wf-last-login">Last login: ${row.workerLastLoginAt ? wfEscape(wfDateTime(row.workerLastLoginAt)) : 'Never'}</small>
    </article>`;
  }).join('');
  document.getElementById('wfFreelancerDirectoryList').innerHTML =
    cards || '<div class="wf-empty">No matching workers or vendors.</div>';
}

function openVendorProfile(id = '') {
  ensureWorkforceModals();
  const vendor = wfFindVendor(id);
  workforcePageState.editingVendorId = vendor?.id || null;
  workforcePageState.vendorMemberSelection = new Set(
    (vendor?.memberIds || []).map(String)
  );
  document.getElementById('wfVendorProfileModalTitle').textContent =
    vendor ? 'Edit Vendor' : 'Enroll New Vendor';
  document.getElementById('wfVendorProfileForm').reset();
  document.getElementById('wfVendorName').value = vendor?.name || '';
  document.getElementById('wfVendorNotes').value = vendor?.notes || '';
  document.getElementById('wfVendorActive').checked = vendor?.active !== false;
  document.getElementById('wfVendorMemberSearch').value = '';
  const deleteButton = document.getElementById('wfDeleteVendorButton');
  if (deleteButton) {
    deleteButton.hidden = !vendor;
    deleteButton.disabled = false;
  }
  renderVendorMemberPicker('');
  wfError('wfVendorProfileError');
  openWorkforceModal('wfVendorProfileModal');
}

function updateVendorMemberSelection(input) {
  if (input.checked) workforcePageState.vendorMemberSelection.add(String(input.value));
  else workforcePageState.vendorMemberSelection.delete(String(input.value));
}

function renderVendorMemberPicker(search = '') {
  const query = String(search || '').trim().toLowerCase();
  const rows = wfDirectoryFreelancers().filter(row =>
    `${row.name} ${row.phone || ''} ${row.email || ''}`.toLowerCase().includes(query)
  );
  document.getElementById('wfVendorMemberPicker').innerHTML = rows.map(row =>
    `<label class="wf-member-option">
      <input type="checkbox" value="${wfAttr(row.id)}"
        ${workforcePageState.vendorMemberSelection.has(String(row.id)) ? 'checked' : ''}
        onchange="updateVendorMemberSelection(this)">
      <span class="wf-avatar">${wfEscape(wfInitials(row.name))}</span>
      <span><strong>${wfEscape(row.name)}</strong>
        <small>${wfEscape(wfFormatPhone(row.phone) || 'No phone number')}</small></span>
    </label>`
  ).join('') || '<div class="wf-empty">No matching workers.</div>';
}

async function saveVendorProfile(event) {
  event.preventDefault();
  const id = workforcePageState.editingVendorId;
  try {
    await apiCall(
      id ? `/api/workforce/vendors/${encodeURIComponent(id)}` : '/api/workforce/vendors',
      id ? 'PUT' : 'POST',
      {
        name: document.getElementById('wfVendorName').value,
        memberIds: [...workforcePageState.vendorMemberSelection],
        notes: document.getElementById('wfVendorNotes').value,
        active: document.getElementById('wfVendorActive').checked
      }
    );
    await refreshWorkforcePage();
    closeWorkforceModal('wfVendorProfileModal');
    if (document.getElementById('wfFreelancerDirectoryModal')?.classList.contains('open')) {
      renderFreelancerDirectory(document.getElementById('wfFreelancerSearch').value);
    }
    showNotification('success', 'Vendor saved');
    if (
      id &&
      String(workforcePageState.historyFreelancerId) === String(id) &&
      document.getElementById('freelancer-workspace-section')?.classList.contains('active')
    ) {
      workforcePageState.freelancerWorkspaceData = null;
      await loadFreelancerWorkspace();
    }
  } catch (error) {
    wfError('wfVendorProfileError', error.message);
  }
}

async function deleteVendorProfile() {
  const id = workforcePageState.editingVendorId;
  const vendor = wfFindVendor(id);
  if (!id || !vendor) return;
  const confirmed = await showAppConfirm({
    title: 'Delete vendor?',
    message: `This removes ${vendor.name || 'this vendor'} from this company, including event assignments and uploaded invoice or claim files for this company.`,
    confirmText: 'Delete Vendor',
    variant: 'danger'
  });
  if (!confirmed) return;
  const button = document.getElementById('wfDeleteVendorButton');
  if (button) button.disabled = true;
  wfError('wfVendorProfileError');
  try {
    const response = await apiCall(`/api/workforce/vendors/${encodeURIComponent(id)}`, 'DELETE');
    await refreshWorkforcePage();
    closeWorkforceModal('wfVendorProfileModal');
    if (
      String(workforcePageState.historyFreelancerId) === String(id) &&
      document.getElementById('freelancer-workspace-section')?.classList.contains('active')
    ) {
      workforcePageState.historyFreelancerId = null;
      workforcePageState.freelancerWorkspaceData = null;
      showSection('workforce');
    }
    const removedUploads = Number(response.cleanup?.submissionsRemoved || 0);
    showNotification('success', removedUploads
      ? `Vendor deleted. ${removedUploads} uploaded file${removedUploads === 1 ? '' : 's'} removed.`
      : 'Vendor deleted');
  } catch (error) {
    if (button) button.disabled = false;
    wfError('wfVendorProfileError', error.message);
  }
}

function openVendorPersonnel() {
  ensureWorkforceModals();
  document.getElementById('wfVendorPersonnelForm').reset();
  wfError('wfVendorPersonnelError');
  openWorkforceModal('wfVendorPersonnelModal');
}

async function saveVendorPersonnel(event) {
  event.preventDefault();
  try {
    const response = await apiCall('/api/workforce/personnel', 'POST', {
      name: document.getElementById('wfPersonnelName').value,
      phone: document.getElementById('wfPersonnelPhone').value,
      email: document.getElementById('wfPersonnelEmail').value,
      notes: document.getElementById('wfPersonnelNotes').value
    });
    const person = response.data;
    const rows = workforcePageState.data.freelancers || [];
    const existingIndex = rows.findIndex(row => String(row.id) === String(person.id));
    if (existingIndex >= 0) rows[existingIndex] = person;
    else rows.push(person);
    workforcePageState.vendorMemberSelection.add(String(person.id));
    closeWorkforceModal('wfVendorPersonnelModal');
    renderVendorMemberPicker(document.getElementById('wfVendorMemberSearch').value);
    showNotification(
      'success',
      response.existing
        ? 'Existing worker or personnel linked to this vendor'
        : 'Personnel added and selected'
    );
  } catch (error) {
    wfError('wfVendorPersonnelError', error.message);
  }
}

function wfHistoryDisplayStatus(record) {
  if (record.processingState === 'Queued' || record.submissionStage === 'Queued') return 'Queued';
  if (record.processingState === 'Processing') return 'Processing';
  if (record.submissionStage === 'Details Required') return 'Details Required';
  if (record.paymentConfirmedAt) return 'Payment Confirmed';
  return record.status || 'Pending Review';
}

function wfHistorySubmissionSummary(rows) {
  if (!rows.length) return 'Not submitted';
  const statuses = rows.map(wfHistoryDisplayStatus);
  const summaryPriority = [
    'Payment Confirmed',
    'Paid',
    'Approved',
    'Processing',
    'Details Required',
    'Pending Review',
    'Denied'
  ];
  return summaryPriority.find(status => statuses.includes(status)) || statuses[0];
}

function wfHistoryStatusControl(event, freelancerId, record, returnFreelancerId = freelancerId) {
  const status = wfHistoryDisplayStatus(record);
  if (['Queued', 'Processing'].includes(status)) {
    return `<span class="upload-status"><span class="wf-status-button status-badge ${wfStatusClass(status)}">${wfEscape(status)}</span>
      <span class="upload-progress-track processing"><span></span></span><small>${status === 'Queued' ? 'Waiting' : 'Analysing'}</small></span>`;
  }
  if (['Processing', 'Details Required'].includes(status) || !record.verifiedAt) {
    return `<button type="button" class="wf-status-button status-badge ${wfStatusClass(status)}"
      onclick="openFreelancerHistorySubmission(${Number(event.id)},'${wfAttr(freelancerId)}','${wfAttr(record.id)}','${wfAttr(returnFreelancerId)}')">
      ${wfEscape(status)}
    </button>`;
  }
  return `<div class="wf-status-control">
    <button type="button" class="wf-status-button status-badge ${wfStatusClass(status)}"
      onclick="toggleWorkforceStatusMenu(event,'history-${wfAttr(record.id)}')">
      ${wfEscape(status)} <span>&#9662;</span>
    </button>
    <div class="wf-status-menu" id="wfStatusMenu-history-${wfAttr(record.id)}">
      ${['Pending Review', 'Approved', 'Denied', 'Paid', 'Payment Confirmed'].map(nextStatus =>
        `<button class="${wfStatusClass(nextStatus)}" type="button"
          onclick="chooseFreelancerHistoryStatus(event,${Number(event.id)},'${wfAttr(freelancerId)}','${wfAttr(record.id)}','${nextStatus}','${wfAttr(returnFreelancerId)}')">${nextStatus}</button>`
      ).join('')}
    </div>
  </div>`;
}

function wfHistorySubmissionRows(event, freelancerId, rows, kind, returnFreelancerId = freelancerId) {
  if (!rows.length) return `<div class="wf-history-empty">No ${kind} submitted.</div>`;
  return rows.map(record => {
    return `<div class="wf-history-file">
      <button type="button" class="wf-history-file-name"
        onclick="openFreelancerHistorySubmission(${Number(event.id)},'${wfAttr(freelancerId)}','${wfAttr(record.id)}','${wfAttr(returnFreelancerId)}')">
        ${wfEscape(record.originalName || `${kind} upload`)}
      </button>
      <span>${record.amount == null ? 'Amount to verify' : wfMoney(record.amount)}</span>
      ${wfHistoryStatusControl(event, freelancerId, record, returnFreelancerId)}
      <button type="button" class="wf-icon-button danger" title="Delete upload"
        onclick="deleteFreelancerHistorySubmission('${wfAttr(record.id)}','${wfAttr(returnFreelancerId)}')">&times;</button>
    </div>`;
  }).join('');
}

function wfHistoryRoleRows(event, freelancerId, subjectType = 'worker', returnFreelancerId = freelancerId) {
  const rows = event.roles || [];
  const roleRows = rows.map(row => `<span class="wf-worker-role-row">
    <span class="wf-department-role" style="${wfDepartmentStyle(row.department)}">
      ${wfEscape(row.department || 'General')}
    </span>
    <span>${wfEscape(row.role || 'Worker')} · ${Number(row.days || 0)} day${Number(row.days || 0) === 1 ? '' : 's'}</span>
    <button type="button" title="Edit role"
      onclick="event.preventDefault();event.stopPropagation();openFreelancerWorkspaceAssignment(${Number(event.id)},'${wfAttr(freelancerId)}','${wfAttr(row.id)}','${wfAttr(subjectType)}','${wfAttr(returnFreelancerId)}')">Edit</button>
    <button type="button" class="danger" title="Remove role"
      onclick="event.preventDefault();event.stopPropagation();removeFreelancerWorkspaceAssignment(${Number(event.id)},'${wfAttr(freelancerId)}','${wfAttr(row.id)}','${wfAttr(returnFreelancerId)}')">&times;</button>
  </span>`).join('');
  return `${roleRows}<button class="wf-add-worker-role" type="button"
    onclick="event.preventDefault();event.stopPropagation();openFreelancerWorkspaceAssignment(${Number(event.id)},'${wfAttr(freelancerId)}','','${wfAttr(subjectType)}','${wfAttr(returnFreelancerId)}')">+ Add assignment</button>`;
}

function wfHistoryEventCard(event, freelancerId, subjectType = 'worker', returnFreelancerId = freelancerId, sourceName = '') {
  const invoiceStatus = wfHistorySubmissionSummary(event.invoices || []);
  const claimStatus = wfHistorySubmissionSummary(event.claims || []);
  const dates = event.startDate === event.endDate
    ? event.startDate
    : `${event.startDate} – ${event.endDate}`;
  return `<details class="wf-history-event">
    <summary>
      <div class="wf-history-event-name"><strong>#${Number(event.id)} ${wfEscape(event.name)}</strong><span>${wfEscape(event.location || 'Location TBC')}</span>
        ${subjectType === 'vendor' && sourceName ? `<span class="wf-history-vendor-source">Vendor submission · ${wfEscape(sourceName)}</span>` : ''}</div>
      <div class="wf-history-event-date"><strong>${wfEscape(dates)}</strong><span class="wf-worker-role-list">${wfHistoryRoleRows(event, freelancerId, subjectType, returnFreelancerId)}</span></div>
      <div><span>Invoice</span><strong>${event.invoices.length}/${event.invoiceLimit}</strong>
        <em class="wf-status-button status-badge ${wfStatusClass(invoiceStatus)}">${wfEscape(invoiceStatus)}</em></div>
      <div><span>Claims</span><strong>${event.claims.length}/${event.claimLimit}</strong>
        <em class="wf-status-button status-badge ${wfStatusClass(claimStatus)}">${wfEscape(claimStatus)}</em></div>
      <div class="wf-history-event-total"><span>Total</span><strong>${wfMoney(Number(event.invoiceTotal || 0) + Number(event.claimTotal || 0))}</strong></div>
      <b class="wf-history-chevron">⌄</b>
    </summary>
    <div class="wf-history-submissions">
      <section><header><strong>Invoices</strong>
        <span class="wf-history-actions">
          <button class="wf-mini-button" type="button" ${event.invoiceSlotsRemaining <= 0 ? 'disabled' : ''}
            onclick="openFreelancerHistoryUpload(${Number(event.id)},'${wfAttr(freelancerId)}','invoice','${wfAttr(returnFreelancerId)}')">Upload</button>
          <button class="wf-mini-button subtle" type="button"
            onclick="changeFreelancerHistoryUploadSlots(${Number(event.id)},'${wfAttr(freelancerId)}','invoice',1,'${wfAttr(returnFreelancerId)}')">+ Slot</button>
          <button class="wf-mini-button subtle" type="button" ${Number(event.extraInvoices || 0) <= 0 ? 'disabled' : ''}
            onclick="changeFreelancerHistoryUploadSlots(${Number(event.id)},'${wfAttr(freelancerId)}','invoice',-1,'${wfAttr(returnFreelancerId)}')">&minus; Slot</button>
        </span></header>
        ${wfHistorySubmissionRows(event, freelancerId, event.invoices || [], 'invoice', returnFreelancerId)}
      </section>
      <section><header><strong>Claims</strong>
        <span class="wf-history-actions">
          <button class="wf-mini-button" type="button" ${event.claimSlotsRemaining <= 0 ? 'disabled' : ''}
            onclick="openFreelancerHistoryUpload(${Number(event.id)},'${wfAttr(freelancerId)}','claim','${wfAttr(returnFreelancerId)}')">Upload</button>
          <button class="wf-mini-button subtle" type="button"
            onclick="changeFreelancerHistoryUploadSlots(${Number(event.id)},'${wfAttr(freelancerId)}','claim',1,'${wfAttr(returnFreelancerId)}')">+ Slot</button>
          <button class="wf-mini-button subtle" type="button" ${Number(event.extraClaims || 0) <= 0 ? 'disabled' : ''}
            onclick="changeFreelancerHistoryUploadSlots(${Number(event.id)},'${wfAttr(freelancerId)}','claim',-1,'${wfAttr(returnFreelancerId)}')">&minus; Slot</button>
        </span></header>
        ${wfHistorySubmissionRows(event, freelancerId, event.claims || [], 'claim', returnFreelancerId)}
      </section>
    </div>
  </details>`;
}

async function openFreelancerHistory(id) {
  const changingSubject = String(workforcePageState.historyFreelancerId || '') !== String(id || '');
  workforcePageState.historyFreelancerId = id;
  workforcePageState.freelancerWorkspaceData = null;
  if (changingSubject) workforcePageState.freelancerWorkspaceIncludeVendors = false;
  closeWorkforceModal('wfFreelancerDirectoryModal');
  showSection('freelancer-workspace');
}

async function loadFreelancerWorkspace() {
  const root = document.getElementById('freelancer-workspace-root');
  if (!root) return;
  const id = workforcePageState.historyFreelancerId;
  if (!id) {
    root.innerHTML = `<div class="plan-page-heading"><h2>Worker Submissions</h2>
      <p>Select a worker from Crew &amp; Vendors to view their events.</p></div>
      <button class="wf-button" type="button" onclick="showSection('workforce')">&larr; Back to Crew &amp; Vendors</button>`;
    return;
  }
  root.innerHTML = '<div class="loading">Loading worker workspace…</div>';
  try {
    const response = await apiCall(`/api/workforce/subjects/${encodeURIComponent(id)}/history`);
    workforcePageState.freelancerWorkspaceData = response.data;
    workforcePageState.freelancerWorkspaceSearch = '';
    renderFreelancerWorkspace();
  } catch (error) {
    root.innerHTML = `<div class="wf-error show">${wfEscape(error.message)}</div>`;
  }
}

function wfFreelancerWorkspaceVendorMemberships(data = workforcePageState.freelancerWorkspaceData) {
  return (data?.vendorMemberships || []).filter(vendor => vendor?.id);
}

function wfFreelancerWorkspaceEvents(data = workforcePageState.freelancerWorkspaceData, includeVendors = workforcePageState.freelancerWorkspaceIncludeVendors) {
  if (!data) return [];
  const subject = data.subject || data.freelancer || {};
  const rows = (data.events || []).map(event => ({
    ...event,
    workspaceSubjectId: subject.id,
    workspaceSubjectType: data.subjectType || subject.subjectType || 'worker',
    workspaceSubjectName: subject.name || ''
  }));
  if (includeVendors && data.subjectType !== 'vendor') {
    wfFreelancerWorkspaceVendorMemberships(data).forEach(vendor => {
      (vendor.events || []).forEach(event => rows.push({
        ...event,
        workspaceSubjectId: vendor.id,
        workspaceSubjectType: 'vendor',
        workspaceSubjectName: vendor.name || 'Vendor'
      }));
    });
  }
  return rows.sort((left, right) => (
    String(right.startDate || '').localeCompare(String(left.startDate || '')) ||
    Number(right.id || 0) - Number(left.id || 0) ||
    String(left.workspaceSubjectName || '').localeCompare(String(right.workspaceSubjectName || ''))
  ));
}

function toggleFreelancerWorkspaceVendors() {
  const hasVendors = wfFreelancerWorkspaceVendorMemberships().length > 0;
  workforcePageState.freelancerWorkspaceIncludeVendors = hasVendors &&
    !workforcePageState.freelancerWorkspaceIncludeVendors;
  renderFreelancerWorkspace();
}

function renderFreelancerWorkspace() {
  const root = document.getElementById('freelancer-workspace-root');
  const data = workforcePageState.freelancerWorkspaceData;
  if (!root || !data) return;
  const { company, events } = data;
  const freelancer = data.subject || data.freelancer;
  const subjectType = data.subjectType || freelancer.subjectType || 'worker';
  const isVendor = subjectType === 'vendor';
  const vendorMemberships = isVendor ? [] : wfFreelancerWorkspaceVendorMemberships(data);
  const includeVendors = vendorMemberships.length > 0 && workforcePageState.freelancerWorkspaceIncludeVendors;
  const visibleEvents = wfFreelancerWorkspaceEvents(data, includeVendors);
  const invoiceCount = visibleEvents.reduce((total, item) => total + item.invoices.length, 0);
  const claimCount = visibleEvents.reduce((total, item) => total + item.claims.length, 0);
  const vendorNames = vendorMemberships.map(vendor => vendor.name).filter(Boolean).join(', ');
  root.innerHTML = `<div class="plan-page-heading wf-freelancer-page-heading">
      <div><button class="wf-back" type="button" onclick="showSection('workforce')">&larr; Back to Crew &amp; Vendors</button>
        <h2>${isVendor ? 'Vendor' : 'Worker'} Submissions</h2>
        <p>Review assignments, invoices and claims for ${wfEscape(company?.name || 'this company')}.</p></div>
      <div class="wf-freelancer-heading-actions">
        ${isVendor ? '' : '<button class="wf-button" type="button" onclick="openWorkerScheduleExport()">Export PDF</button>'}
        <button class="wf-button" type="button" onclick="${isVendor ? 'openVendorProfile' : 'openFreelancerProfile'}('${wfAttr(freelancer.id)}')">Edit ${isVendor ? 'Vendor' : 'Worker'}</button>
      </div>
    </div>
    <div class="plan-event-bar wf-worker-selector-bar">
      <button type="button" class="plan-event-select-wrap" onclick="openFreelancerDirectory('manage')">
        <span class="wf-avatar ${isVendor ? 'vendor' : ''}">${wfEscape(wfInitials(freelancer.name))}</span>
        <span class="wf-worker-selector-copy"><strong>${wfEscape(freelancer.name)}</strong>
          <small>${isVendor
            ? `${Number(freelancer.members?.length || 0)} portal member${Number(freelancer.members?.length || 0) === 1 ? '' : 's'}`
            : `${wfEscape(wfFormatPhone(freelancer.phone) || 'No phone')} · Last login: ${freelancer.workerLastLoginAt ? wfEscape(wfDateTime(freelancer.workerLastLoginAt)) : 'Never'}`}</small></span>
        <span class="plan-event-picker-chevron">&#8964;</span>
      </button>
      <div class="plan-metrics">
        <div class="plan-metric"><div><strong>${visibleEvents.length}</strong><span>Events</span></div></div>
        <div class="plan-metric"><div><strong>${invoiceCount}</strong><span>Invoices</span></div></div>
        <div class="plan-metric"><div><strong>${claimCount}</strong><span>Claims</span></div></div>
      </div>
    </div>
    <section class="wf-panel wf-freelancer-events-panel">
      <header class="wf-panel-header"><div><h3>Events &amp; Submissions</h3>
        <p>Most recent events are shown first. Expand an event to manage its files.</p></div>
        <div class="wf-worker-history-actions">
          ${vendorMemberships.length ? `<button class="wf-history-vendor-toggle ${includeVendors ? 'is-on' : ''}" type="button"
            role="switch" aria-checked="${includeVendors}" onclick="toggleFreelancerWorkspaceVendors()"
            title="${wfAttr(vendorNames)}"><i aria-hidden="true"></i><span><strong>Include vendor submissions</strong>
              <small>${wfEscape(vendorNames)}</small></span></button>` : ''}
          <input class="wf-search wf-event-history-search" type="search"
            placeholder="Search event name, location, date or role"
            value="${wfAttr(workforcePageState.freelancerWorkspaceSearch)}"
            oninput="renderFreelancerWorkspaceEvents(this.value)">
        </div>
      </header>
      <div class="wf-history-table-head"><span>Event &amp; Location</span><span>Date &amp; Role</span>
        <span>Invoice</span><span>Claims</span><span>Total</span><span></span></div>
      <div class="wf-history-list" id="wfFreelancerWorkspaceEvents"></div>
    </section>`;
  renderFreelancerWorkspaceEvents(workforcePageState.freelancerWorkspaceSearch);
}

function workforceLocalDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function ensureWorkerScheduleExportModal() {
  ensureWorkforceModals();
  if (document.getElementById('wfWorkerScheduleExportModal')) return;
  document.body.insertAdjacentHTML('beforeend', wfModal(
    'wfWorkerScheduleExportModal',
    'Export Worker Schedule',
    `<form id="wfWorkerScheduleExportForm" onsubmit="exportWorkerPeriodSchedule(event)">
      <div class="wf-modal-body">
        <p class="wf-worker-export-help">Choose the assignments to include in the worker's schedule.</p>
        <div class="wf-form-grid">
          <label class="wf-field"><span>From date *</span><input id="wfWorkerScheduleStartDate" type="date" required></label>
          <label class="wf-field"><span>To date *</span><input id="wfWorkerScheduleEndDate" type="date" required></label>
          <label class="wf-check full"><input id="wfWorkerScheduleShowRates" type="checkbox"> Include rates</label>
          <label class="wf-check full" id="wfWorkerScheduleVendorOption" hidden>
            <input id="wfWorkerScheduleIncludeVendor" type="checkbox" onchange="updateWorkerScheduleExportDateRange()">
            <span id="wfWorkerScheduleVendorLabel">Include vendor</span>
          </label>
        </div>
        <div class="wf-error" id="wfWorkerScheduleExportError"></div>
      </div>
      <div class="wf-modal-actions">
        <button class="wf-button" type="button" onclick="closeWorkforceModal('wfWorkerScheduleExportModal')">Cancel</button>
        <button class="wf-button primary" type="submit">Export PDF</button>
      </div>
    </form>`
  ));
}

function wfWorkerScheduleAssignmentDates(includeVendors = false) {
  return wfFreelancerWorkspaceEvents(
    workforcePageState.freelancerWorkspaceData,
    includeVendors
  ).flatMap(event =>
    (event.roles || []).flatMap(role => role.workDates || [])
  ).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))).sort();
}

function updateWorkerScheduleExportDateRange() {
  const includeVendors = Boolean(
    document.getElementById('wfWorkerScheduleIncludeVendor')?.checked
  );
  const assignmentDates = wfWorkerScheduleAssignmentDates(includeVendors);
  const today = workforceLocalDateValue();
  document.getElementById('wfWorkerScheduleStartDate').value = assignmentDates[0] || today;
  document.getElementById('wfWorkerScheduleEndDate').value = assignmentDates.at(-1) || today;
}

function openWorkerScheduleExport() {
  const data = workforcePageState.freelancerWorkspaceData;
  const subject = data?.subject || data?.freelancer;
  if (!subject?.id || data?.subjectType === 'vendor') return;
  ensureWorkerScheduleExportModal();
  document.getElementById('wfWorkerScheduleShowRates').checked = false;
  const vendorMemberships = wfFreelancerWorkspaceVendorMemberships(data);
  const vendorOption = document.getElementById('wfWorkerScheduleVendorOption');
  const vendorInput = document.getElementById('wfWorkerScheduleIncludeVendor');
  const vendorLabel = document.getElementById('wfWorkerScheduleVendorLabel');
  vendorOption.hidden = vendorMemberships.length === 0;
  vendorOption.title = vendorMemberships.map(vendor => vendor.name).filter(Boolean).join(', ');
  vendorInput.checked = vendorMemberships.length > 0 &&
    workforcePageState.freelancerWorkspaceIncludeVendors;
  vendorInput.disabled = vendorMemberships.length === 0;
  vendorLabel.textContent = vendorMemberships.length > 1 ? 'Include vendors' : 'Include vendor';
  updateWorkerScheduleExportDateRange();
  document.getElementById('wfWorkerScheduleExportError').textContent = '';
  openWorkforceModal('wfWorkerScheduleExportModal');
}

function exportWorkerPeriodSchedule(event) {
  event.preventDefault();
  const data = workforcePageState.freelancerWorkspaceData;
  const subject = data?.subject || data?.freelancer;
  const startDate = document.getElementById('wfWorkerScheduleStartDate')?.value || '';
  const endDate = document.getElementById('wfWorkerScheduleEndDate')?.value || '';
  const error = document.getElementById('wfWorkerScheduleExportError');
  if (!subject?.id || !startDate || !endDate || endDate < startDate) {
    if (error) error.textContent = endDate < startDate
      ? 'To date must be on or after the from date.'
      : 'Choose a valid date range.';
    return;
  }
  const params = new URLSearchParams({ startDate, endDate });
  if (document.getElementById('wfWorkerScheduleShowRates')?.checked) {
    params.set('showRates', '1');
  }
  if (document.getElementById('wfWorkerScheduleIncludeVendor')?.checked) {
    params.set('showVendor', '1');
  }
  window.open(`/api/workforce/subjects/${encodeURIComponent(subject.id)}/schedule.pdf?${params}`, '_blank', 'noopener');
  closeWorkforceModal('wfWorkerScheduleExportModal');
}

function renderFreelancerWorkspaceEvents(search = '') {
  const node = document.getElementById('wfFreelancerWorkspaceEvents');
  const data = workforcePageState.freelancerWorkspaceData;
  if (!node || !data) return;
  const query = String(search || '').trim().toLowerCase();
  workforcePageState.freelancerWorkspaceSearch = query;
  const rootSubject = data.subject || data.freelancer || {};
  const rows = wfFreelancerWorkspaceEvents(data).filter(event => {
    const text = [
      event.name, event.location, event.startDate, event.endDate,
      event.workspaceSubjectName,
      ...(event.roles || []).flatMap(role => [role.department, role.role])
    ].join(' ').toLowerCase();
    return !query || text.includes(query);
  });
  node.innerHTML = rows.map(event =>
    wfHistoryEventCard(
      event,
      event.workspaceSubjectId,
      event.workspaceSubjectType,
      rootSubject.id,
      event.workspaceSubjectName
    )
  ).join('') || '<div class="wf-empty">No matching events for this worker or vendor.</div>';
}

async function openFreelancerWorkspaceAssignment(eventId, freelancerId, assignmentId = '', subjectType = 'worker', returnFreelancerId = freelancerId) {
  workforcePageState.freelancerWorkspaceReturnId = returnFreelancerId;
  await loadFreelancerHistoryEvent(eventId);
  if (subjectType === 'vendor') {
    openVendorAssignment(freelancerId, '', assignmentId);
  } else {
    openFreelancerAssignment(freelancerId, '', assignmentId);
  }
}

async function removeFreelancerWorkspaceAssignment(eventId, freelancerId, assignmentId, returnFreelancerId = freelancerId) {
  try {
    await loadFreelancerHistoryEvent(eventId);
    await deleteWorkforceAssignmentRequest(eventId, assignmentId);
    await openFreelancerHistory(returnFreelancerId);
  } catch (error) {
    showNotification('error', error.message);
  }
}

async function loadFreelancerHistoryEvent(eventId) {
  if (Number(workforcePageState.eventId) !== Number(eventId)) {
    const response = await apiCall(`/api/events/${Number(eventId)}/workforce`);
    workforcePageState.eventId = Number(eventId);
    workforcePageState.data = response.data;
    renderWorkforcePage();
  }
}

async function openFreelancerHistorySubmission(eventId, freelancerId, submissionId, returnFreelancerId = freelancerId) {
  workforcePageState.historyReturnFreelancerId = returnFreelancerId;
  await loadFreelancerHistoryEvent(eventId);
  closeWorkforceModal('wfFreelancerHistoryModal');
  await openWorkforceReview(submissionId);
}

async function openFreelancerHistoryUpload(eventId, freelancerId, kind, returnFreelancerId = freelancerId) {
  workforcePageState.historyReturnFreelancerId = returnFreelancerId;
  await loadFreelancerHistoryEvent(eventId);
  closeWorkforceModal('wfFreelancerHistoryModal');
  openAdminWorkforceUpload(freelancerId, kind);
}

async function chooseFreelancerHistoryStatus(event, eventId, freelancerId, submissionId, status, returnFreelancerId = freelancerId) {
  event.stopPropagation();
  closeWorkforceStatusMenus();
  await loadFreelancerHistoryEvent(eventId);
  if (status === 'Denied') {
    workforcePageState.historyReturnFreelancerId = returnFreelancerId;
    closeWorkforceModal('wfFreelancerHistoryModal');
    openWorkforceDenialReason(submissionId);
    return;
  }
  const changed = await applyWorkforceStatus(submissionId, status);
  if (changed) await openFreelancerHistory(returnFreelancerId);
}

async function changeFreelancerHistoryUploadSlots(eventId, freelancerId, kind, delta, returnFreelancerId = freelancerId) {
  try {
    await apiCall(
      `/api/events/${Number(eventId)}/workforce/allowances/${encodeURIComponent(freelancerId)}`,
      'POST',
      { kind, delta }
    );
    await openFreelancerHistory(returnFreelancerId);
  } catch (error) {
    showNotification('error', error.message);
  }
}

async function deleteFreelancerHistorySubmission(submissionId, freelancerId) {
  if (!await confirmWorkforceSubmissionDeletion(submissionId)) return;
  try {
    await apiCall(`/api/workforce/submissions/${encodeURIComponent(submissionId)}`, 'DELETE');
    await openFreelancerHistory(freelancerId);
  } catch (error) {
    showNotification('error', error.message);
  }
}

function openFreelancerProfile(id = '') {
  ensureWorkforceModals();
  const row = wfFindFreelancer(id) || (
    String(workforcePageState.freelancerWorkspaceData?.freelancer?.id) === String(id)
      ? workforcePageState.freelancerWorkspaceData.freelancer
      : null
  );
  workforcePageState.editingFreelancerId = row?.id || null;
  document.getElementById('wfFreelancerProfileModalTitle').textContent = row ? 'Edit Worker' : 'Enroll New Worker';
  document.getElementById('wfFreelancerProfileForm').reset();
  document.getElementById('wfFreelancerName').value = row?.name || '';
  document.getElementById('wfFreelancerPhone').value = wfFormatPhone(row?.phone || '');
  document.getElementById('wfFreelancerEmail').value = row?.email || '';
  document.getElementById('wfFreelancerCompany').value = row?.company || '';
  document.getElementById('wfFreelancerNotes').value = row?.notes || '';
  document.getElementById('wfFreelancerActive').checked = row?.active !== false;
  const loginControls = document.getElementById('wfWorkerLoginControls');
  const resetButton = document.getElementById('wfResetWorkerLogin');
  loginControls.hidden = !row;
  document.getElementById('wfWorkerLoginStatus').textContent =
    row?.workerLoginConfigured
      ? `${row.workerCredentialType === 'pin' ? 'PIN' : 'Password'} configured`
      : 'Setup required';
  document.getElementById('wfWorkerLastLogin').textContent =
    `Last login: ${row?.workerLastLoginAt ? wfDateTime(row.workerLastLoginAt) : 'Never'}`;
  resetButton.hidden = !row?.workerLoginConfigured;
  resetButton.disabled = false;
  const deleteButton = document.getElementById('wfDeleteFreelancerButton');
  if (deleteButton) {
    deleteButton.hidden = !row;
    deleteButton.disabled = false;
  }
  wfError('wfFreelancerProfileError');
  openWorkforceModal('wfFreelancerProfileModal');
}

async function resetFreelancerLogin() {
  const id = workforcePageState.editingFreelancerId;
  if (!id) return;
  const button = document.getElementById('wfResetWorkerLogin');
  button.disabled = true;
  wfError('wfFreelancerProfileError');
  try {
    await apiCall(
      `/api/workforce/freelancers/${encodeURIComponent(id)}/reset-login`,
      'POST',
      {}
    );
    await refreshWorkforcePage();
    openFreelancerProfile(id);
    showNotification(
      'success',
      'Worker login reset. A new PIN or password is required.'
    );
  } catch (error) {
    button.disabled = false;
    wfError('wfFreelancerProfileError', error.message);
  }
}

async function saveFreelancerProfile(event) {
  event.preventDefault();
  const id = workforcePageState.editingFreelancerId;
  const payload = {
    name: document.getElementById('wfFreelancerName').value,
    phone: document.getElementById('wfFreelancerPhone').value,
    email: document.getElementById('wfFreelancerEmail').value,
    company: document.getElementById('wfFreelancerCompany').value,
    notes: document.getElementById('wfFreelancerNotes').value,
    active: document.getElementById('wfFreelancerActive').checked
  };
  try {
    await apiCall(id ? `/api/workforce/freelancers/${encodeURIComponent(id)}` : '/api/workforce/freelancers', id ? 'PUT' : 'POST', payload);
    await refreshWorkforcePage();
    closeWorkforceModal('wfFreelancerProfileModal');
    closeWorkforceModal('wfFreelancerDirectoryModal');
    showNotification('success', 'Worker saved');
    if (
      id &&
      document.getElementById('freelancer-workspace-section')?.classList.contains('active')
    ) {
      workforcePageState.freelancerWorkspaceData = null;
      await loadFreelancerWorkspace();
    }
  } catch (error) {
    wfError('wfFreelancerProfileError', error.message);
  }
}

async function deleteFreelancerProfile() {
  const id = workforcePageState.editingFreelancerId;
  const row = wfFindFreelancer(id) || (
    String(workforcePageState.freelancerWorkspaceData?.freelancer?.id) === String(id)
      ? workforcePageState.freelancerWorkspaceData.freelancer
      : null
  );
  if (!id || !row) return;
  const confirmed = await showAppConfirm({
    title: 'Delete worker?',
    message: `This removes ${row.name || 'this worker'} from this company, including vendor access links, event assignments, and uploaded invoice or claim files for this company.`,
    confirmText: 'Delete Worker',
    variant: 'danger'
  });
  if (!confirmed) return;
  const button = document.getElementById('wfDeleteFreelancerButton');
  if (button) button.disabled = true;
  wfError('wfFreelancerProfileError');
  try {
    const response = await apiCall(`/api/workforce/freelancers/${encodeURIComponent(id)}`, 'DELETE');
    await refreshWorkforcePage();
    closeWorkforceModal('wfFreelancerProfileModal');
    closeWorkforceModal('wfFreelancerDirectoryModal');
    if (
      String(workforcePageState.historyFreelancerId) === String(id) &&
      document.getElementById('freelancer-workspace-section')?.classList.contains('active')
    ) {
      workforcePageState.historyFreelancerId = null;
      workforcePageState.freelancerWorkspaceData = null;
      showSection('workforce');
    }
    const removedUploads = Number(response.cleanup?.submissionsRemoved || 0);
    showNotification('success', removedUploads
      ? `Worker deleted. ${removedUploads} uploaded file${removedUploads === 1 ? '' : 's'} removed.`
      : 'Worker deleted');
  } catch (error) {
    if (button) button.disabled = false;
    wfError('wfFreelancerProfileError', error.message);
  }
}

function wfEventDateOptions() {
  const start = new Date(`${workforcePageState.data.event.startDateValue}T12:00:00`);
  const end = new Date(`${workforcePageState.data.event.endDateValue}T12:00:00`);
  const dates = [];
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return dates;
  for (const current = new Date(start); current <= end; current.setDate(current.getDate() + 1)) {
    dates.push(current.toISOString().slice(0, 10));
  }
  return dates;
}

function wfDateCalendarHtml(selectedDates = [], conflictsByDate = {}) {
  const allowedDates = wfEventDateOptions();
  const allowed = new Set(allowedDates);
  const adjacentDates = new Set();
  if (allowedDates.length) {
    const before = new Date(`${allowedDates[0]}T12:00:00`);
    const after = new Date(`${allowedDates[allowedDates.length - 1]}T12:00:00`);
    before.setDate(before.getDate() - 1);
    after.setDate(after.getDate() + 1);
    adjacentDates.add(before.toISOString().slice(0, 10));
    adjacentDates.add(after.toISOString().slice(0, 10));
  }
  const selectableDates = new Set([...allowed, ...adjacentDates]);
  const selected = new Set((selectedDates || []).filter(date =>
    /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
  ));
  const months = [];
  const orderedSelectableDates = [...selectableDates].sort();
  const first = orderedSelectableDates.length
    ? new Date(`${orderedSelectableDates[0]}T12:00:00`)
    : null;
  const last = orderedSelectableDates.length
    ? new Date(`${orderedSelectableDates[orderedSelectableDates.length - 1]}T12:00:00`)
    : null;
  for (const cursor = first ? new Date(first.getFullYear(), first.getMonth(), 1, 12) : null;
    cursor && cursor <= last; cursor.setMonth(cursor.getMonth() + 1)) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const mondayOffset = (new Date(year, month, 1).getDay() + 6) % 7;
    const cells = Array.from({ length: mondayOffset }, () =>
      '<span class="wf-calendar-blank"></span>'
    );
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (!selectableDates.has(date)) {
        cells.push(`<span class="wf-calendar-day outside">${day}</span>`);
      } else {
        const conflicts = conflictsByDate?.[date] || [];
        const conflictTitle = conflicts.map(row => `Event #${row.eventId} ${row.eventName || ''}`).join(', ');
        const dateClass = allowed.has(date) ? 'event-date' : 'adjacent-date';
        cells.push(`<button class="wf-calendar-day ${dateClass} ${selected.has(date) ? 'selected' : ''} ${conflicts.length ? 'has-conflict' : ''}"
          type="button" data-date="${date}" aria-pressed="${selected.has(date)}"
          ${conflicts.length
            ? `title="Already assigned to ${wfAttr(conflictTitle)}"`
            : (!allowed.has(date) ? 'title="Adjacent work date"' : '')}
          onclick="toggleWorkforceCalendarDate(this)">${day}</button>`);
      }
    }
    months.push(`<section class="wf-calendar-month">
      <header>${cursor.toLocaleDateString('en-SG', { month: 'long', year: 'numeric' })}</header>
      <div class="wf-calendar-weekdays">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day => `<span>${day}</span>`).join('')}</div>
      <div class="wf-calendar-days">${cells.join('')}</div>
    </section>`);
  }
  const otherDates = [...selected].filter(date => !selectableDates.has(date)).sort();
  return `<div class="wf-calendar-toolbar" data-conflicts="${wfAttr(JSON.stringify(conflictsByDate || {}))}"><span>Event dates are highlighted. Other work dates can be added below.</span>
      <div><button class="wf-link-button" type="button" onclick="setWorkforceCalendarSelection(this,true)">Select all</button>
        <button class="wf-link-button" type="button" onclick="setWorkforceCalendarSelection(this,false)">Clear</button></div>
    </div>
    <div class="wf-calendar-extra-row"><label><span>Additional work date</span><input type="date" class="wf-calendar-extra-input"></label>
      <button class="wf-button" type="button" onclick="addWorkforceCalendarDate(this)">Add date</button>
      <div class="wf-calendar-extra-dates">${otherDates.map(date => wfCalendarExtraDateChipHtml(date, conflictsByDate?.[date] || [])).join('')}</div>
    </div>
    ${months.length ? `<div class="wf-calendar-months">${months.join('')}</div>` : '<div class="wf-empty">Event dates are unavailable. Add the required working dates above.</div>'}`;
}

function wfCalendarExtraDateChipHtml(date, conflicts = []) {
  const parsed = new Date(`${date}T12:00:00`);
  const label = Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
  const conflictTitle = conflicts.map(row => `Event #${row.eventId} ${row.eventName || ''}`).join(', ');
  return `<button type="button" class="wf-calendar-extra-date selected ${conflicts.length ? 'has-conflict' : ''}"
    data-date="${wfAttr(date)}" ${conflicts.length ? `title="Already assigned to ${wfAttr(conflictTitle)}"` : ''}
    onclick="removeWorkforceCalendarDate(this)"><span>${wfEscape(label)}</span><b aria-hidden="true">&times;</b></button>`;
}

function addWorkforceCalendarDate(button) {
  const calendar = button.closest('.wf-date-calendar');
  const input = calendar?.querySelector('.wf-calendar-extra-input');
  const date = String(input?.value || '');
  if (!calendar || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    input?.focus();
    return;
  }
  const eventDate = calendar.querySelector(`.wf-calendar-day[data-date="${date}"]`);
  if (eventDate) {
    eventDate.classList.add('selected');
    eventDate.setAttribute('aria-pressed', 'true');
  } else if (!calendar.querySelector(`.wf-calendar-extra-date[data-date="${date}"]`)) {
    let conflicts = {};
    try {
      conflicts = JSON.parse(calendar.querySelector('.wf-calendar-toolbar')?.dataset.conflicts || '{}');
    } catch (_error) {
      conflicts = {};
    }
    calendar.querySelector('.wf-calendar-extra-dates')?.insertAdjacentHTML(
      'beforeend', wfCalendarExtraDateChipHtml(date, conflicts?.[date] || [])
    );
  }
  input.value = '';
}

function removeWorkforceCalendarDate(button) {
  button.remove();
}

function toggleWorkforceCalendarDate(button) {
  button.classList.toggle('selected');
  button.setAttribute('aria-pressed', String(button.classList.contains('selected')));
}

function setWorkforceCalendarSelection(button, selected) {
  const calendar = button.closest('.wf-date-calendar');
  calendar?.querySelectorAll('.wf-calendar-day.event-date').forEach(day => {
    day.classList.toggle('selected', selected);
    day.setAttribute('aria-pressed', String(selected));
  });
  if (!selected) {
    calendar?.querySelectorAll('.wf-calendar-extra-date').forEach(day => day.remove());
  }
}

function wfSelectedCalendarDates(id) {
  return [...new Set(
    [...document.querySelectorAll(`#${id} [data-date].selected`)]
      .map(button => button.dataset.date)
      .filter(Boolean)
  )].sort();
}

function openFreelancerAssignment(freelancerId, department = '', assignmentId = '') {
  ensureWorkforceModals();
  const freelancer = wfFindFreelancer(freelancerId);
  if (!freelancer) return;
  const assignment = (workforcePageState.data.assignments || [])
    .find(row => String(row.id) === String(assignmentId));
  workforcePageState.selectedFreelancerId = freelancerId;
  workforcePageState.editingAssignmentId = assignment?.id || null;
  document.getElementById('wfAssignmentForm').reset();
  document.getElementById('wfAssignmentFreelancerName').textContent = freelancer.name;
  wfPopulateSubprojectSelect(
    'wfAssignmentSubproject', assignment?.subprojectId
  );
  const departmentSelect = document.getElementById('wfAssignmentDepartment');
  departmentSelect.innerHTML = wfDepartmentOptions(assignment?.department || department);
  wfTintDepartmentSelect(departmentSelect);
  document.getElementById('wfAssignmentRole').value = assignment?.roleName || '';
  document.getElementById('wfAssignmentRate').value = assignment?.dailyRate ?? '';
  const allDates = wfEventDateOptions();
  const selectedDates = new Set(
    assignment?.workDates?.length
      ? assignment.workDates
      : (workforcePageState.assignmentPrefillDates.length
        ? workforcePageState.assignmentPrefillDates
        : allDates.slice(0, Number(assignment?.days || 1)))
  );
  workforcePageState.assignmentPrefillDates = [];
  document.getElementById('wfAssignmentDates').innerHTML =
    wfDateCalendarHtml(
      [...selectedDates],
      workforcePageState.data?.workerDateConflicts?.[freelancerId] || {}
    );
  document.getElementById('wfAssignmentModalTitle').textContent =
    assignment ? 'Edit Event Assignment' : 'Event Assignment';
  document.querySelector('#wfAssignmentForm [type="submit"]').textContent =
    assignment ? 'Save Assignment' : 'Add Assignment';
  wfError('wfAssignmentError');
  closeWorkforceModal('wfFreelancerDirectoryModal');
  openWorkforceModal('wfAssignmentModal');
}

async function saveFreelancerAssignment(event) {
  event.preventDefault();
  try {
    const workDates = wfSelectedCalendarDates('wfAssignmentDates');
    if (!workDates.length) {
      wfError('wfAssignmentError', 'Select at least one working date.');
      return;
    }
    const assignmentId = workforcePageState.editingAssignmentId;
    const url = assignmentId
      ? `/api/events/${workforcePageState.eventId}/workforce/assignments/${encodeURIComponent(assignmentId)}`
      : `/api/events/${workforcePageState.eventId}/workforce/assignments`;
    const response = await apiCall(url, assignmentId ? 'PUT' : 'POST', {
      freelancerId: workforcePageState.selectedFreelancerId,
      subprojectId: document.getElementById('wfAssignmentSubproject').value,
      department: document.getElementById('wfAssignmentDepartment').value,
      customRole: document.getElementById('wfAssignmentRole').value,
      saveRole: false,
      days: workDates.length,
      workDates,
      dailyRate: document.getElementById('wfAssignmentRate').value
    });
    workforcePageState.data = response.data;
    closeWorkforceModal('wfAssignmentModal');
    renderWorkforcePage();
    showNotification('success', assignmentId ? 'Event assignment updated' : 'Event assignment added');
  } catch (error) {
    wfError('wfAssignmentError', error.message);
  }
}

function openVendorAssignment(vendorId, department = '', assignmentId = '') {
  ensureWorkforceModals();
  const vendor = wfFindVendor(vendorId);
  if (!vendor) return;
  const assignment = (workforcePageState.data.assignments || [])
    .find(row => String(row.id) === String(assignmentId));
  workforcePageState.selectedVendorId = vendorId;
  workforcePageState.editingVendorAssignmentId = assignment?.id || null;
  document.getElementById('wfVendorAssignmentForm').reset();
  document.getElementById('wfVendorAssignmentName').textContent = vendor.name;
  wfPopulateSubprojectSelect(
    'wfVendorAssignmentSubproject', assignment?.subprojectId
  );
  const departmentSelect = document.getElementById('wfVendorAssignmentDepartment');
  departmentSelect.innerHTML = wfDepartmentOptions(assignment?.department || department);
  wfTintDepartmentSelect(departmentSelect);
  const providerType = assignment?.providerType || 'manpower';
  document.querySelectorAll('[name="wfProviderType"]').forEach(input => {
    input.checked = input.value === providerType;
  });
  document.getElementById('wfVendorPax').value = assignment?.pax || '';
  document.getElementById('wfVendorRatePerPax').value = assignment?.ratePerPax ?? '';
  document.getElementById('wfVendorServiceName').value = assignment?.serviceName || '';
  document.getElementById('wfVendorServiceCost').value = assignment?.serviceCost ?? '';
  const allDates = wfEventDateOptions();
  const selectedDates = assignment?.workDates?.length
    ? assignment.workDates
    : (workforcePageState.assignmentPrefillDates.length
      ? workforcePageState.assignmentPrefillDates
      : allDates.slice(0, Number(assignment?.days || 1)));
  workforcePageState.assignmentPrefillDates = [];
  document.getElementById('wfVendorAssignmentDates').innerHTML =
    wfDateCalendarHtml(selectedDates);
  syncVendorAssignmentFields();
  document.getElementById('wfVendorAssignmentModalTitle').textContent =
    assignment ? 'Edit Vendor Event Assignment' : 'Vendor Event Assignment';
  document.querySelector('#wfVendorAssignmentForm [type="submit"]').textContent =
    assignment ? 'Save Assignment' : 'Add Assignment';
  wfError('wfVendorAssignmentError');
  closeWorkforceModal('wfScheduleDayStaffModal');
  openWorkforceModal('wfVendorAssignmentModal');
}

function syncVendorAssignmentFields() {
  const providerType = document.querySelector('[name="wfProviderType"]:checked')?.value || 'manpower';
  const manpower = providerType === 'manpower';
  document.getElementById('wfVendorManpowerFields').hidden = !manpower;
  document.getElementById('wfVendorServiceFields').hidden = manpower;
  document.getElementById('wfVendorPax').required = manpower;
  document.getElementById('wfVendorRatePerPax').required = manpower;
  document.getElementById('wfVendorServiceName').required = !manpower;
  document.getElementById('wfVendorServiceCost').required = !manpower;
}

async function saveVendorAssignment(event) {
  event.preventDefault();
  const workDates = wfSelectedCalendarDates('wfVendorAssignmentDates');
  if (!workDates.length) {
    wfError('wfVendorAssignmentError', 'Select at least one working date.');
    return;
  }
  const assignmentId = workforcePageState.editingVendorAssignmentId;
  const providerType = document.querySelector('[name="wfProviderType"]:checked')?.value || '';
  const url = assignmentId
    ? `/api/events/${workforcePageState.eventId}/workforce/assignments/${encodeURIComponent(assignmentId)}`
    : `/api/events/${workforcePageState.eventId}/workforce/assignments`;
  try {
    const response = await apiCall(url, assignmentId ? 'PUT' : 'POST', {
      vendorId: workforcePageState.selectedVendorId,
      subprojectId: document.getElementById('wfVendorAssignmentSubproject').value,
      department: document.getElementById('wfVendorAssignmentDepartment').value,
      providerType,
      workDates,
      days: workDates.length,
      pax: document.getElementById('wfVendorPax').value,
      ratePerPax: document.getElementById('wfVendorRatePerPax').value,
      serviceName: document.getElementById('wfVendorServiceName').value,
      serviceCost: document.getElementById('wfVendorServiceCost').value
    });
    workforcePageState.data = response.data;
    closeWorkforceModal('wfVendorAssignmentModal');
    renderWorkforcePage();
    showNotification('success', assignmentId ? 'Vendor assignment updated' : 'Vendor added to event');
  } catch (error) {
    wfError('wfVendorAssignmentError', error.message);
  }
}

async function deleteWorkforceAssignment(id) {
  try {
    const response = await deleteWorkforceAssignmentRequest(workforcePageState.eventId, id);
    workforcePageState.data = response.data;
    renderWorkforcePage();
  } catch (error) {
    showNotification('error', error.message);
  }
}

async function deleteWorkforceAssignmentRequest(eventId, assignmentId, confirmedUploads = false, date = '') {
  const params = new URLSearchParams();
  if (confirmedUploads) params.set('deleteUploads', '1');
  if (date) params.set('date', date);
  const suffix = params.size ? `?${params}` : '';
  try {
    return await apiCall(
      `/api/events/${Number(eventId)}/workforce/assignments/${encodeURIComponent(assignmentId)}${suffix}`,
      'DELETE'
    );
  } catch (error) {
    if (error.payload?.requiresUploadRemovalConfirmation && !confirmedUploads) {
      const uploadCount = Number(error.payload.uploadCount || 0);
      const confirmed = await showAppConfirm({
        title: 'Remove uploaded files?',
        message: `This person has ${uploadCount} uploaded file${uploadCount === 1 ? '' : 's'} for this event. Removing their last assignment will delete those files too.`,
        confirmText: 'Remove and Delete Files',
        variant: 'danger'
      });
      if (confirmed) {
        return deleteWorkforceAssignmentRequest(eventId, assignmentId, true, date);
      }
    }
    throw error;
  }
}

function openManualDepartment() {
  ensureWorkforceModals();
  document.getElementById('wfDepartmentForm').reset();
  document.getElementById('wfDepartmentPreset').innerHTML = '<option value="">Custom department</option>' +
    (workforcePageState.data.allDepartments || []).filter(isSelectableCompanyDepartment).map(row =>
      `<option value="${wfAttr(row.code)}" data-name="${wfAttr(row.name)}">${wfEscape(row.name)} (${wfEscape(row.code)})</option>`).join('');
  wfError('wfDepartmentError');
  openWorkforceModal('wfDepartmentModal');
}

function syncDepartmentPreset() {
  const select = document.getElementById('wfDepartmentPreset');
  const option = select.selectedOptions[0];
  if (!select.value) return;
  document.getElementById('wfDepartmentCode').value = select.value;
  document.getElementById('wfDepartmentName').value = option.dataset.name || '';
}

async function saveManualDepartment(event) {
  event.preventDefault();
  try {
    const response = await apiCall(`/api/events/${workforcePageState.eventId}/workforce/departments`, 'POST', {
      code: document.getElementById('wfDepartmentCode').value,
      name: document.getElementById('wfDepartmentName').value
    });
    workforcePageState.data = response.data;
    closeWorkforceModal('wfDepartmentModal');
    renderWorkforcePage();
  } catch (error) {
    wfError('wfDepartmentError', error.message);
  }
}

async function deleteWorkforceDepartment(code) {
  const response = await apiCall(`/api/events/${workforcePageState.eventId}/workforce/departments/${encodeURIComponent(code)}`, 'DELETE');
  workforcePageState.data = response.data;
  renderWorkforcePage();
}

async function changeWorkforceUploadSlots(freelancerId, kind, delta) {
  const response = await apiCall(
    `/api/events/${workforcePageState.eventId}/workforce/allowances/${encodeURIComponent(freelancerId)}`,
    'POST', { kind, delta });
  workforcePageState.data = response.data;
  renderWorkforcePage();
}

function openAdminWorkforceUpload(freelancerId, kind) {
  ensureWorkforceModals();
  const appUsername = String(freelancerId || '').replace(/^user:/, '');
  const freelancer = wfFindFreelancer(freelancerId) ||
    wfFindVendor(freelancerId) || wfFindAppUser(appUsername);
  if (!freelancer) return;
  const claim = kind === 'claim';
  const form = document.getElementById('wfAdminUploadForm');
  form.reset();
  document.getElementById('wfAdminUploadFreelancerId').value = freelancerId;
  document.getElementById('wfAdminUploadKind').value = kind;
  const vendorUpload = Boolean(wfFindVendor(freelancerId));
  document.getElementById('wfAdminUploadModalTitle').textContent = claim
    ? `Upload Claim for ${vendorUpload ? 'Vendor' : 'Crew'}`
    : `Upload Invoice for ${wfFindVendor(freelancerId) ? 'Vendor' : 'Crew'}`;
  document.getElementById('wfAdminUploadSubtitle').textContent = freelancer.name;
  document.getElementById('wfAdminInvoiceFields').hidden = claim;
  document.getElementById('wfAdminClaimFields').hidden = !claim;
  const file = document.getElementById('wfAdminUploadFile');
  file.accept = claim
    ? '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg'
    : ADMIN_INVOICE_FILE_ACCEPT;
  file.multiple = true;
  document.getElementById('wfAdminUploadFileLabel').textContent = claim
    ? 'Claim files (PDF, PNG or JPG) *'
    : 'Invoice files (PDF, PNG, JPG or Excel) *';
  document.getElementById('wfAdminUploadDropPrompt').textContent = claim ? 'Drag & drop or choose claim files' : 'Drag & drop or choose invoice files';
  updateAdminWorkforceDropzoneFiles();
  const submit = document.querySelector('#wfAdminUploadForm .wf-button.primary');
  submit.type = 'submit';
  submit.onclick = null;
  submit.disabled = false;
  submit.textContent = 'Upload Files';
  wfError('wfAdminUploadError');
  openWorkforceModal('wfAdminUploadModal');
}

async function submitAdminWorkforceUpload(event) {
  event.preventDefault();
  if (workforcePageState.uploadActive) return;
  const id = document.getElementById('wfAdminUploadFreelancerId').value;
  const kind = document.getElementById('wfAdminUploadKind').value;
  const files = [...document.getElementById('wfAdminUploadFile').files];
  if (!files.length) return;
  const pendingRows = files.map((file, index) => {
    const uploadId = `admin-upload-${Date.now()}-${++workforcePageState.uploadSequence}-${index}`;
    const row = {
      id: uploadId,
      eventId: workforcePageState.eventId,
      subjectId: id,
      kind,
      originalName: file.name,
      amount: null,
      status: 'Queued',
      processingState: 'Queued',
      uploadProgress: 0,
      clientOnly: true,
      file
    };
    workforcePageState.pendingUploads.set(uploadId, row);
    return row;
  });
  renderWorkforcePage();
  workforcePageState.uploadActive = true;
  closeWorkforceModal('wfAdminUploadModal');
  let uploaded = 0;
  let failed = 0;
  for (let index = 0; index < pendingRows.length; index += 1) {
    const row = pendingRows[index];
    row.status = 'Uploading';
    row.processingState = '';
    renderWorkforcePage();
    const formData = new FormData();
    formData.append('kind', kind);
    formData.append('files', row.file);
    try {
      const response = await wfUploadWithProgress(
        `/api/events/${row.eventId}/workforce/submissions/${encodeURIComponent(id)}`,
        formData,
        (value, phase) => {
          const previousStatus = row.status;
          row.uploadProgress = value;
          row.status = phase === 'queueing' ? 'Queueing' : 'Uploading';
          if (row.status !== previousStatus) renderWorkforcePage();
          else wfUpdatePendingUploadProgress(row);
        }
      );
      row.status = 'Queued';
      row.processingState = 'Queued';
      row.uploadProgress = 100;
      workforcePageState.pendingUploads.delete(row.id);
      workforcePageState.data = response.data;
      uploaded += 1;
    } catch (error) {
      row.status = 'Failed';
      row.processingState = 'Failed';
      row.processingError = error.message || 'Upload failed';
      failed += 1;
    }
    renderWorkforcePage();
  }
  workforcePageState.uploadActive = false;
  if (uploaded) showNotification('success', `${uploaded} file${uploaded === 1 ? '' : 's'} queued for processing`);
  if (failed) showNotification('error', `${failed} file${failed === 1 ? '' : 's'} could not be uploaded. Check the failed file rows.`);
}

function wfUploadWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) {
        const percent = (event.loaded / event.total) * 100;
        onProgress(percent, percent >= 100 ? 'processing' : 'uploading');
      }
    };
    xhr.upload.onload = () => onProgress(100, 'queueing');
    xhr.onload = () => {
      let payload = {};
      try { payload = JSON.parse(xhr.responseText || '{}'); } catch (_error) {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new Error(payload.error || 'The upload could not be completed.'));
    };
    xhr.onerror = () => reject(new Error('The upload could not be completed.'));
    xhr.send(formData);
  });
}

function openTransportDirectory() {
  ensureWorkforceModals();
  document.getElementById('wfTransportSearch').value = '';
  renderTransportDirectory('');
  openWorkforceModal('wfTransportDirectoryModal');
}

function renderTransportDirectory(search) {
  const query = String(search || '').toLowerCase();
  const rows = (workforcePageState.data?.transportVendors || []).filter(row =>
    `${row.vehicleType || ''} ${row.company || ''} ${row.vehicleNumber || ''}`.toLowerCase().includes(query));
  document.getElementById('wfTransportDirectoryList').innerHTML = rows.map(row => {
    const isOnDemand = row.profileType === 'on_demand';
    const title = isOnDemand
      ? (row.company || 'On-demand provider')
      : [row.vehicleType || 'Vehicle', row.vehicleNumber].filter(Boolean).join(' · ');
    const details = isOnDemand
      ? [row.vehicleType ? `Default: ${row.vehicleType}` : 'Choose vehicle type per booking', row.contactNumber].filter(Boolean).join(' · ')
      : [row.company, row.contactNumber].filter(Boolean).join(' · ');
    return `<div class="wf-directory-row"><button class="wf-directory-main" type="button" onclick="openTransportBooking('${wfAttr(row.id)}')">
      <span class="wf-avatar">${wfMetricIconSvg('transport')}</span><span><strong>${wfEscape(title)}</strong>
      <small>${isOnDemand ? '<b class="wf-on-demand-badge">On-demand</b>' : ''}${wfEscape(details)}</small></span></button>
      <button class="wf-button" type="button" onclick="openTransportProfile('${wfAttr(row.id)}')">Edit</button></div>`;
  }).join('') ||
      '<div class="wf-empty">No saved transport profiles. Add one to begin.</div>';
}

function setTransportProfileType(type) {
  const value = type === 'on_demand' ? 'on_demand' : 'vehicle';
  const isOnDemand = value === 'on_demand';
  document.getElementById('wfProfileType').value = value;
  document.getElementById('wfProfileTypeVehicle').classList.toggle('active', !isOnDemand);
  document.getElementById('wfProfileTypeOnDemand').classList.toggle('active', isOnDemand);
  document.getElementById('wfProfileVehicleType').required = !isOnDemand;
  document.getElementById('wfProfileCompany').required = isOnDemand;
  document.getElementById('wfProfileVehicleNumberField').hidden = isOnDemand;
  document.getElementById('wfProfileVehicleTypeLabel').textContent =
    isOnDemand ? 'Default vehicle type' : 'Vehicle type *';
  document.getElementById('wfProfileCompanyLabel').textContent =
    isOnDemand ? 'Provider name *' : 'Company';
  document.getElementById('wfProfileTypeHelp').textContent = isOnDemand
    ? 'For services such as Lalamove or GoGoX. Choose the vehicle type and quantity for each booking.'
    : 'Save a specific vehicle that you expect to book again.';
}

function openTransportProfile(id = '', returnToBooking = false) {
  ensureWorkforceModals();
  const row = workforcePageState.data.transportVendors.find(item => String(item.id) === String(id));
  workforcePageState.returnToTransportBooking = Boolean(returnToBooking);
  workforcePageState.editingTransportProfileId = row?.id || null;
  document.getElementById('wfTransportProfileForm').reset();
  document.getElementById('wfTransportProfileModalTitle').textContent = row ? 'Edit Transport' : 'Add New Transport';
  setTransportProfileType(row?.profileType || 'vehicle');
  document.getElementById('wfProfileVehicleType').value = row?.vehicleType || '';
  document.getElementById('wfProfileCompany').value = row?.company || '';
  document.getElementById('wfProfileContact').value = row?.contactNumber || '';
  document.getElementById('wfProfileVehicleNumber').value = row?.vehicleNumber || '';
  wfError('wfTransportProfileError');
  openWorkforceModal('wfTransportProfileModal');
}

async function saveTransportProfile(event) {
  event.preventDefault();
  const id = workforcePageState.editingTransportProfileId;
  try {
    const response = await apiCall(id ? `/api/workforce/transport-profiles/${encodeURIComponent(id)}` : '/api/workforce/transport-profiles', id ? 'PUT' : 'POST', {
      profileType: document.getElementById('wfProfileType').value,
      vehicleType: document.getElementById('wfProfileVehicleType').value,
      company: document.getElementById('wfProfileCompany').value,
      contactNumber: document.getElementById('wfProfileContact').value,
      vehicleNumber: document.getElementById('wfProfileVehicleNumber').value
    });
    const returnToBooking = workforcePageState.returnToTransportBooking;
    workforcePageState.returnToTransportBooking = false;
    await refreshWorkforcePage();
    closeWorkforceModal('wfTransportProfileModal');
    if (returnToBooking) {
      renderExternalTransportChoices(response.data?.id || '');
      selectTransportVehicle('external', response.data?.id || '');
    } else {
      renderTransportDirectory('');
    }
    showNotification('success', 'Transport profile saved');
  } catch (error) {
    wfError('wfTransportProfileError', error.message);
  }
}

function openLocationsManager() {
  ensureWorkforceModals();
  cancelTransportLocationEdit();
  renderTransportLocations();
  openWorkforceModal('wfLocationsModal');
}

function wfLocationParts(value, explicitAddress = '') {
  const raw = String(value || '').trim();
  const suppliedAddress = String(explicitAddress || '').trim();
  const openingBracket = raw.indexOf(' (');
  const hasCombinedAddress = !suppliedAddress && openingBracket > 0 && raw.endsWith(')');
  return {
    name: hasCombinedAddress ? raw.slice(0, openingBracket).trim() : raw,
    address: suppliedAddress || (hasCombinedAddress ? raw.slice(openingBracket + 2, -1).trim() : ''),
  };
}

function wfSavedTransportLocations() {
  return (workforcePageState.data?.transportLocations || []).map(row => ({
    ...row,
    ...wfLocationParts(row.name, row.address),
  }));
}

function renderTransportLocations() {
  document.getElementById('wfLocationsList').innerHTML = wfSavedTransportLocations().map(row =>
    `<div class="wf-directory-row wf-location-directory-row"><span><strong>${wfEscape(row.name)}</strong>
      ${row.address ? `<small>${wfEscape(row.address)}</small>` : ''}</span>
      <span class="wf-location-row-actions"><button class="wf-button" type="button" onclick="editTransportLocation('${wfAttr(row.id)}')">Edit</button>
      <button class="wf-button danger" type="button" onclick="deleteTransportLocation('${wfAttr(row.id)}')">Remove</button></span></div>`).join('') ||
      '<div class="wf-empty">No saved locations yet.</div>';
}

function editTransportLocation(id) {
  const location = wfSavedTransportLocations().find(row => String(row.id) === String(id));
  if (!location) return;
  workforcePageState.editingLocationId = String(id);
  document.getElementById('wfLocationName').value = location.name;
  document.getElementById('wfLocationAddress').value = location.address;
  document.getElementById('wfLocationSubmit').textContent = 'Save Changes';
  document.getElementById('wfLocationCancelEdit').hidden = false;
  document.getElementById('wfLocationName').focus();
}

function cancelTransportLocationEdit() {
  workforcePageState.editingLocationId = null;
  const nameInput = document.getElementById('wfLocationName');
  const addressInput = document.getElementById('wfLocationAddress');
  const submit = document.getElementById('wfLocationSubmit');
  const cancel = document.getElementById('wfLocationCancelEdit');
  if (nameInput) nameInput.value = '';
  if (addressInput) addressInput.value = '';
  if (submit) submit.textContent = 'Add Location';
  if (cancel) cancel.hidden = true;
}

function wfSyncBookingLocation(side) {
  const isFrom = side === 'from';
  const nameInput = document.getElementById(isFrom ? 'wfLocationFrom' : 'wfLocationTo');
  const addressInput = document.getElementById(isFrom ? 'wfLocationFromAddress' : 'wfLocationToAddress');
  if (!nameInput || !addressInput) return;
  const selected = wfSavedTransportLocations().find(row => (
    String(row.name || '').trim().toLocaleLowerCase() === nameInput.value.trim().toLocaleLowerCase()
  ));
  if (selected) addressInput.value = selected.address || '';
}

function wfBookingLocationElements(side) {
  const isFrom = side === 'from';
  return {
    input: document.getElementById(isFrom ? 'wfLocationFrom' : 'wfLocationTo'),
    address: document.getElementById(isFrom ? 'wfLocationFromAddress' : 'wfLocationToAddress'),
    results: document.getElementById(isFrom ? 'wfLocationFromSuggestions' : 'wfLocationToSuggestions'),
  };
}

function wfShowBookingLocationSuggestions(side, value = '') {
  const { input, results } = wfBookingLocationElements(side);
  if (!input || !results) return;
  const query = String(value || '').trim().toLocaleLowerCase();
  const options = wfSavedTransportLocations().filter(row => (
    !query || [row.name, row.address].some(field => (
      String(field || '').toLocaleLowerCase().includes(query)
    ))
  )).slice(0, 8);
  results.innerHTML = options.map(row => `
    <button type="button" role="option" data-location-id="${wfAttr(row.id)}" onmousedown="event.preventDefault()" onclick="wfChooseBookingLocation('${wfAttr(side)}',this.dataset.locationId)">
      <span class="wf-location-suggestion-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 21s6-5.1 6-11a6 6 0 1 0-12 0c0 5.9 6 11 6 11Z"></path><circle cx="12" cy="10" r="2"></circle></svg></span>
      <span><strong>${wfEscape(row.name)}</strong>${row.address ? `<small>${wfEscape(row.address)}</small>` : '<small>No address saved</small>'}</span>
    </button>
  `).join('');
  const open = options.length > 0;
  results.classList.toggle('open', open);
  input.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function wfCloseBookingLocationSuggestions(side) {
  const { input, results } = wfBookingLocationElements(side);
  results?.classList.remove('open');
  input?.setAttribute('aria-expanded', 'false');
}

function wfBookingLocationInput(side) {
  wfSyncBookingLocation(side);
  const { input } = wfBookingLocationElements(side);
  wfShowBookingLocationSuggestions(side, input?.value || '');
}

function wfChooseBookingLocation(side, id) {
  const location = wfSavedTransportLocations().find(row => String(row.id) === String(id));
  const { input, address } = wfBookingLocationElements(side);
  if (!location || !input || !address) return false;
  input.value = location.name;
  address.value = location.address || '';
  wfCloseBookingLocationSuggestions(side);
  return true;
}

function wfBookingLocationSuggestionKeydown(event, side) {
  const { results } = wfBookingLocationElements(side);
  if (event.key === 'Escape') {
    wfCloseBookingLocationSuggestions(side);
    return;
  }
  if (event.key !== 'ArrowDown' || !results?.classList.contains('open')) return;
  event.preventDefault();
  results.querySelector('button')?.focus();
}

async function saveTransportLocation(event) {
  event.preventDefault();
  try {
    const editingId = workforcePageState.editingLocationId;
    await apiCall(editingId
      ? `/api/workforce/transport-locations/${encodeURIComponent(editingId)}`
      : '/api/workforce/transport-locations', editingId ? 'PUT' : 'POST', {
      name: document.getElementById('wfLocationName').value,
      address: document.getElementById('wfLocationAddress').value
    });
    cancelTransportLocationEdit();
    await refreshWorkforcePage();
    renderTransportLocations();
    showNotification('success', editingId ? 'Location updated' : 'Location added');
  } catch (error) {
    wfError('wfLocationError', error.message);
  }
}

async function deleteTransportLocation(id) {
  await apiCall(`/api/workforce/transport-locations/${encodeURIComponent(id)}`, 'DELETE');
  if (String(workforcePageState.editingLocationId || '') === String(id)) {
    cancelTransportLocationEdit();
  }
  await refreshWorkforcePage();
  renderTransportLocations();
}

function wfTransportDepartureForReturn() {
  const editingId = String(workforcePageState.editingTransportId || '');
  const selectedVehicleIds = workforcePageState.transportVehicleSelections.fleet;
  const selectedVendorIds = workforcePageState.transportVehicleSelections.external;
  const departures = (workforcePageState.data?.transportBookings || [])
    .filter(booking => (
      String(booking.id || '') !== editingId &&
      booking.tripType !== 'return' &&
      booking.locationFrom &&
      booking.locationTo
    ))
    .map((booking, index) => {
      const sameVehicle = selectedVehicleIds.has(String(booking.vehicleId || ''));
      const sameVendor = selectedVendorIds.has(String(booking.vendorId || ''));
      return { booking, index, preferred: sameVehicle || sameVendor };
    })
    .sort((left, right) => (
      Number(right.preferred) - Number(left.preferred) ||
      right.index - left.index
    ));
  return departures[0]?.booking || null;
}

function applyTransportReturnDefaults() {
  const tripDate = document.getElementById('wfDepartDate');
  const eventEndDate = workforcePageState.data?.event?.endDateValue || '';
  if (tripDate && eventEndDate) {
    tripDate.value = eventEndDate;
    syncTransportUsageDate();
  }

  const departure = wfTransportDepartureForReturn();
  if (!departure) return;
  const fromLocation = wfLocationParts(
    departure.locationToName || departure.locationTo,
    departure.locationToAddress
  );
  const toLocation = wfLocationParts(
    departure.locationFromName || departure.locationFrom,
    departure.locationFromAddress
  );
  document.getElementById('wfLocationFrom').value = fromLocation.name;
  document.getElementById('wfLocationFromAddress').value = fromLocation.address;
  document.getElementById('wfLocationTo').value = toLocation.name;
  document.getElementById('wfLocationToAddress').value = toLocation.address;
}

function setTransportTripType(type, applyDefaults = true) {
  const value = type === 'return' ? 'return' : 'depart';
  document.getElementById('wfTransportTripType').value = value;
  document.getElementById('wfTripDepart').classList.toggle('active', value === 'depart');
  document.getElementById('wfTripReturn').classList.toggle('active', value === 'return');
  if (value === 'return' && applyDefaults) applyTransportReturnDefaults();
}

function wfSelectedTransportVehicles() {
  const selections = workforcePageState.transportVehicleSelections;
  return [
    ...[...selections.fleet].map(id => ({ sourceType: 'fleet', id })),
    ...[...selections.external].map(id => ({ sourceType: 'external', id }))
  ];
}

function wfTransportSelectionKey(sourceType, id) {
  return `${sourceType}:${id}`;
}

function wfTransportSelectionProfile(selection) {
  if (selection?.sourceType !== 'external') return null;
  return (workforcePageState.data?.transportVendors || [])
    .find(row => String(row.id) === String(selection.id)) || null;
}

function wfTransportSelectionIsOnDemand(selection) {
  return wfTransportSelectionProfile(selection)?.profileType === 'on_demand';
}

function wfTransportSelectionLabel(selection) {
  if (selection.sourceType === 'fleet') {
    const vehicle = (workforcePageState.data?.vehicles || [])
      .find(row => String(row.id) === String(selection.id));
    return {
      title: vehicle?.registrationNumber || vehicle?.name || 'Company vehicle',
      subtitle: vehicle?.name || vehicle?.vehicleType || 'Own fleet'
    };
  }
  const profile = (workforcePageState.data?.transportVendors || [])
    .find(row => String(row.id) === String(selection.id));
  if (profile?.profileType === 'on_demand') {
    return {
      title: profile.company || 'On-demand provider',
      subtitle: profile.vehicleType
        ? `Default: ${profile.vehicleType}`
        : 'Vehicle type chosen per booking'
    };
  }
  return {
    title: [profile?.vehicleType, profile?.vehicleNumber].filter(Boolean).join(' - ') || 'External transport',
    subtitle: profile?.company || 'External vehicle'
  };
}

function updateTransportVehicleDriver(encodedKey, field, value) {
  const key = decodeURIComponent(encodedKey);
  const details = workforcePageState.transportDriverDetails.get(key) || {};
  details[field === 'contact' ? 'contact' : 'driver'] = value;
  workforcePageState.transportDriverDetails.set(key, details);
}

function wfRememberTransportDriver(encodedKey, field, value) {
  let key = encodedKey;
  if (!key) {
    const selections = wfSelectedTransportVehicles();
    if (selections.length !== 1) return;
    key = encodeURIComponent(wfTransportSelectionKey(
      selections[0].sourceType, selections[0].id
    ));
  }
  updateTransportVehicleDriver(key, field, value);
}

function wfTransportDriverSuggestionsRoot(input) {
  return input?.closest('.wf-driver-combobox') || null;
}

function wfShowTransportDriverSuggestions(input) {
  const root = wfTransportDriverSuggestionsRoot(input);
  const results = root?.querySelector('.wf-driver-suggestions');
  if (!results) return;
  const query = String(input.value || '').trim().toLocaleLowerCase();
  const users = (workforcePageState.data?.appUsers || [])
    .filter(row => [row.name, row.username, row.phone].some(value =>
      String(value || '').toLocaleLowerCase().includes(query)
    ))
    .slice(0, 8);
  results.innerHTML = users.map(row => {
    const name = row.name || row.username || 'App user';
    return `<button type="button" role="option" data-username="${wfAttr(row.username)}"
      onmousedown="event.preventDefault()" onclick="wfChooseTransportDriver(this)"
      onkeydown="wfTransportDriverOptionKeydown(event)">
      <span class="wf-driver-suggestion-avatar" aria-hidden="true">${wfEscape(wfInitials(name))}</span>
      <span><strong>${wfEscape(name)}</strong>
        <small>${wfEscape(row.username)}${row.phone ? ` · ${wfEscape(wfFormatPhone(row.phone))}` : ''}</small></span>
    </button>`;
  }).join('');
  results.classList.toggle('open', users.length > 0);
  const inputBounds = input.getBoundingClientRect?.();
  const bodyBounds = input.closest('.wf-modal-body')?.getBoundingClientRect?.();
  results.classList.toggle(
    'open-upward',
    Boolean(inputBounds && bodyBounds &&
      bodyBounds.bottom - inputBounds.bottom < 220 &&
      inputBounds.top - bodyBounds.top > bodyBounds.bottom - inputBounds.bottom)
  );
  input.setAttribute('aria-expanded', users.length ? 'true' : 'false');
}

function wfCloseTransportDriverSuggestions(root) {
  if (!root) return;
  root.querySelector('.wf-driver-suggestions')?.classList.remove('open');
  root.querySelector('input[role="combobox"]')?.setAttribute('aria-expanded', 'false');
}

function wfTransportDriverFocusOut(event) {
  const root = event.currentTarget;
  if (!root.contains(event.relatedTarget)) wfCloseTransportDriverSuggestions(root);
}

function wfTransportDriverInput(input) {
  const root = wfTransportDriverSuggestionsRoot(input);
  const encodedKey = root?.dataset.driverKey || '';
  if (root?.dataset.selectedUsername) {
    const selected = wfFindAppUser(root.dataset.selectedUsername);
    if (input.value !== (selected?.name || selected?.username || '')) {
      const phone = encodedKey
        ? root.closest('.wf-booking-driver-row')?.querySelector('[data-driver-contact]')
        : document.getElementById('wfTransportDriverContact');
      if (phone) phone.value = '';
      wfRememberTransportDriver(encodedKey, 'contact', '');
      root.dataset.selectedUsername = '';
    }
  }
  wfRememberTransportDriver(encodedKey, 'driver', input.value);
  wfShowTransportDriverSuggestions(input);
}

function wfTransportDriverPhoneInput(input) {
  wfRememberTransportDriver(input.dataset.driverKey || '', 'contact', input.value);
}

function wfChooseTransportDriver(option) {
  const user = wfFindAppUser(option.dataset.username);
  const root = option.closest('.wf-driver-combobox');
  const input = root?.querySelector('input[role="combobox"]');
  if (!user || !input) return;
  const encodedKey = root.dataset.driverKey || '';
  const phone = encodedKey
    ? root.closest('.wf-booking-driver-row')?.querySelector('[data-driver-contact]')
    : document.getElementById('wfTransportDriverContact');
  input.value = user.name || user.username;
  if (phone) phone.value = user.phone || '';
  root.dataset.selectedUsername = user.username;
  wfRememberTransportDriver(encodedKey, 'driver', input.value);
  wfRememberTransportDriver(encodedKey, 'contact', user.phone || '');
  wfCloseTransportDriverSuggestions(root);
  input.focus();
}

function wfTransportDriverSuggestionKeydown(event) {
  const root = wfTransportDriverSuggestionsRoot(event.currentTarget);
  if (event.key === 'Escape') {
    wfCloseTransportDriverSuggestions(root);
    return;
  }
  if (event.key !== 'ArrowDown') return;
  const first = root?.querySelector('.wf-driver-suggestions.open button');
  if (!first) return;
  event.preventDefault();
  first.focus();
}

function wfTransportDriverOptionKeydown(event) {
  const root = event.currentTarget.closest('.wf-driver-combobox');
  if (event.key === 'Escape') {
    wfCloseTransportDriverSuggestions(root);
    root?.querySelector('input[role="combobox"]')?.focus();
    return;
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  const buttons = [...(root?.querySelectorAll('.wf-driver-suggestions button') || [])];
  const index = buttons.indexOf(event.currentTarget);
  const next = buttons[index + (event.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function renderTransportVehicleDrivers() {
  const root = document.getElementById('wfBookingDrivers');
  const singleFields = document.getElementById('wfSingleDriverFields');
  if (!root || !singleFields) return;
  const selections = wfSelectedTransportVehicles();
  const usesOnDemandProvider = selections.length === 1
    && wfTransportSelectionIsOnDemand(selections[0]);
  const usesIndividualDrivers = selections.length > 1;
  root.hidden = !usesIndividualDrivers;
  singleFields.hidden = usesIndividualDrivers || usesOnDemandProvider;
  if (!usesIndividualDrivers) {
    if (selections.length === 1) {
      const selection = selections[0];
      const details = workforcePageState.transportDriverDetails.get(
        wfTransportSelectionKey(selection.sourceType, selection.id)
      ) || {};
      document.getElementById('wfTransportDriver').value = details.driver || '';
      document.getElementById('wfTransportDriverContact').value = details.contact || '';
    }
    root.innerHTML = '';
    return;
  }
  root.innerHTML = `<div class="wf-booking-drivers-heading"><h5>Drivers</h5><p>Assign a different driver to each selected vehicle.</p></div>
    <div class="wf-booking-driver-list">${selections.map((selection, index) => {
      const key = wfTransportSelectionKey(selection.sourceType, selection.id);
      const details = workforcePageState.transportDriverDetails.get(key) || {};
      const label = wfTransportSelectionLabel(selection);
      const encodedKey = encodeURIComponent(key);
      return `<article class="wf-booking-driver-row">
        <div><strong>${wfEscape(label.title)}</strong><small>${wfEscape(label.subtitle)}</small></div>
        <label class="wf-field"><span>Driver *</span><span class="wf-location-combobox wf-driver-combobox" data-driver-key="${wfAttr(encodedKey)}" onfocusout="wfTransportDriverFocusOut(event)">
          <input required value="${wfAttr(details.driver || '')}" placeholder="Driver name" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="wfTransportDriverSuggestions-${index}"
            onfocus="wfShowTransportDriverSuggestions(this)" oninput="wfTransportDriverInput(this)" onkeydown="wfTransportDriverSuggestionKeydown(event)">
          <span class="wf-location-suggestions wf-driver-suggestions" id="wfTransportDriverSuggestions-${index}" role="listbox"></span>
        </span></label>
        <label class="wf-field"><span>Driver phone</span><input type="tel" data-driver-contact data-driver-key="${wfAttr(encodedKey)}" value="${wfAttr(details.contact || '')}" placeholder="+65 9123 4567" oninput="wfTransportDriverPhoneInput(this)"></label>
      </article>`;
    }).join('')}</div>`;
}

function syncOnDemandBookingFields() {
  const selections = wfSelectedTransportVehicles();
  const selection = selections.length === 1 ? selections[0] : null;
  const profile = wfTransportSelectionIsOnDemand(selection)
    ? wfTransportSelectionProfile(selection)
    : null;
  const root = document.getElementById('wfOnDemandBookingFields');
  const typeInput = document.getElementById('wfOnDemandVehicleType');
  const quantityInput = document.getElementById('wfOnDemandQuantity');
  const quantityField = document.getElementById('wfOnDemandQuantityField');
  if (!root || !typeInput || !quantityInput || !quantityField) return null;
  root.hidden = !profile;
  typeInput.required = Boolean(profile);
  quantityInput.required = Boolean(profile) && !workforcePageState.editingTransportId;
  quantityField.hidden = Boolean(workforcePageState.editingTransportId);
  if (!profile) {
    typeInput.dataset.profileId = '';
    return null;
  }
  document.getElementById('wfOnDemandProviderName').textContent =
    profile.company || 'On-demand provider';
  if (typeInput.dataset.profileId !== String(profile.id)) {
    typeInput.value = profile.vehicleType || '';
    typeInput.dataset.profileId = String(profile.id);
  }
  if (!quantityInput.value || Number(quantityInput.value) < 1) {
    quantityInput.value = '1';
  }
  return profile;
}

function setTransportBookingSource(source) {
  const selections = workforcePageState.transportVehicleSelections;
  const selectedSources = [
    selections.fleet.size ? 'fleet' : '',
    selections.external.size ? 'external' : ''
  ].filter(Boolean);
  const value = selectedSources.length === 1 ? selectedSources[0] : (selectedSources.length ? 'multiple' : '');
  const isFleet = selections.fleet.size > 0;
  document.getElementById('wfTransportSourceType').value = value;
  document.getElementById('wfBookingFleetVehicle').value = [...selections.fleet].join(',');
  document.getElementById('wfBookingVendor').value = [...selections.external].join(',');
  document.getElementById('wfVehicleUseEndDate').required = isFleet;
  document.getElementById('wfVehicleUseEndTime').required = isFleet;
  document.querySelectorAll('.wf-booking-vehicle-option').forEach(option => {
    option.classList.toggle(
      'selected',
      selections[option.dataset.source]?.has(String(option.dataset.id))
    );
  });
  const onDemandProfile = syncOnDemandBookingFields();
  const count = selections.fleet.size + selections.external.size;
  const quantity = onDemandProfile
    ? Math.max(1, Math.min(50, Number(document.getElementById('wfOnDemandQuantity').value) || 1))
    : count;
  const summary = document.getElementById('wfBookingSelectionSummary');
  if (summary) summary.textContent = onDemandProfile
    ? `${onDemandProfile.company || 'On-demand provider'} · ${quantity} vehicle${quantity === 1 ? '' : 's'}`
    : (count ? `${count} vehicle${count === 1 ? '' : 's'} selected` : 'No vehicles selected');
  const submit = document.getElementById('wfTransportBookingSubmit');
  if (submit && !workforcePageState.editingTransportId) {
    submit.textContent = quantity > 1 ? `Add ${quantity} to Event` : 'Add to Event';
  }
  renderTransportVehicleDrivers();
}

function openTransportBooking(profileId = '', bookingId = '', preferredSource = '') {
  ensureWorkforceModals();
  const profiles = workforcePageState.data.transportVendors || [];
  const vehicles = workforcePageState.data.vehicles || [];
  const booking = (workforcePageState.data.transportBookings || [])
    .find(row => String(row.id) === String(bookingId));
  const source = booking?.sourceType || preferredSource || (profileId ? 'external' : '');
  const profile = profiles.find(row =>
    String(row.id) === String(booking?.vendorId || profileId));
  const vehicle = vehicles.find(row =>
    String(row.id) === String(booking?.vehicleId));
  workforcePageState.selectedTransportProfileId = profile?.id || null;
  workforcePageState.selectedFleetVehicleId = vehicle?.id || null;
  workforcePageState.editingTransportId = booking?.id || null;
  workforcePageState.transportVehicleSelections = {
    fleet: new Set(vehicle?.id ? [String(vehicle.id)] : []),
    external: new Set(profile?.id ? [String(profile.id)] : [])
  };
  workforcePageState.transportDriverDetails = new Map();
  const initialSelection = vehicle?.id
    ? { sourceType: 'fleet', id: String(vehicle.id) }
    : (profile?.id ? { sourceType: 'external', id: String(profile.id) } : null);
  if (initialSelection) {
    workforcePageState.transportDriverDetails.set(
      wfTransportSelectionKey(initialSelection.sourceType, initialSelection.id),
      {
        driver: booking?.driver || '',
        contact: booking?.driverContact || booking?.contactNumber || ''
      }
    );
  }
  document.getElementById('wfTransportBookingForm').reset();
  document.getElementById('wfTransportBookingModalTitle').textContent =
    booking ? 'Edit Event Transport' : 'Add Transport to Event';
  wfPopulateSubprojectSelect(
    'wfTransportSubproject', booking?.subprojectId
  );
  document.getElementById('wfBookingVendor').value = profile?.id || '';
  document.getElementById('wfBookingFleetVehicle').value = vehicle?.id || '';
  document.getElementById('wfTransportDriver').value = booking?.driver || '';
  document.getElementById('wfTransportDriverContact').value =
    booking?.driverContact || booking?.contactNumber || '';
  const driverCombobox = document.getElementById('wfTransportDriver')
    .closest('.wf-driver-combobox');
  driverCombobox.dataset.selectedUsername = '';
  wfCloseTransportDriverSuggestions(driverCombobox);
  const fromLocation = wfLocationParts(booking?.locationFromName || booking?.locationFrom, booking?.locationFromAddress);
  const toLocation = wfLocationParts(booking?.locationToName || booking?.locationTo, booking?.locationToAddress);
  document.getElementById('wfLocationFrom').value = fromLocation.name;
  document.getElementById('wfLocationFromAddress').value = fromLocation.address;
  document.getElementById('wfLocationTo').value = toLocation.name;
  document.getElementById('wfLocationToAddress').value = toLocation.address;
  const tripType = booking?.tripType || 'depart';
  const tripDateInput = document.getElementById('wfDepartDate');
  tripDateInput.value =
    booking?.departDate ||
    (tripType === 'return'
      ? workforcePageState.data.event.endDateValue
      : workforcePageState.data.event.startDateValue) || '';
  tripDateInput.dataset.previousValue = tripDateInput.value;
  document.getElementById('wfDepartTime').value = booking?.departTime || '';
  document.getElementById('wfVehicleUseEndDate').value =
    booking?.useEndDate || tripDateInput.value;
  document.getElementById('wfVehicleUseEndTime').value = booking?.useEndTime || '';
  document.getElementById('wfTransportCost').value = booking?.cost ?? 0;
  const onDemandTypeInput = document.getElementById('wfOnDemandVehicleType');
  const isOnDemandProfile = profile?.profileType === 'on_demand';
  onDemandTypeInput.value = isOnDemandProfile
    ? (booking?.vehicleType || profile?.vehicleType || '')
    : '';
  onDemandTypeInput.dataset.profileId = isOnDemandProfile
    ? String(profile.id)
    : '';
  document.getElementById('wfOnDemandQuantity').value = '1';
  document.getElementById('wfSaveBookingLocations').checked = true;
  setTransportTripType(tripType, false);
  renderExternalTransportChoices(profile?.id || '');
  renderFleetTransportChoices(
    vehicles.filter(row => row.active !== false),
    false,
    vehicle?.id || ''
  );
  setTransportBookingSource(source);
  wfError('wfTransportBookingError');
  closeWorkforceModal('wfTransportDirectoryModal');
  openWorkforceModal('wfTransportBookingModal');
  scheduleTransportAvailability(true);
}

function manageOwnVehicles() {
  closeWorkforceModal('wfTransportDirectoryModal');
  closeWorkforceModal('wfTransportBookingModal');
  showSection('vehicles');
}

function openTransportProfileForBooking() {
  openTransportProfile('', true);
}

function selectTransportVehicle(source, id) {
  if (!id || !['fleet', 'external'].includes(source)) return;
  const selections = workforcePageState.transportVehicleSelections;
  const selected = selections[source];
  const selectionKey = wfTransportSelectionKey(source, String(id));
  const wasSelected = selected.has(String(id));
  let previousCount = selections.fleet.size + selections.external.size;
  const incomingSelection = { sourceType: source, id: String(id) };
  const incomingIsOnDemand = wfTransportSelectionIsOnDemand(incomingSelection);
  const selectedOnDemand = wfSelectedTransportVehicles()
    .some(selection => wfTransportSelectionIsOnDemand(selection));
  if (workforcePageState.editingTransportId) {
    selections.fleet.clear();
    selections.external.clear();
    workforcePageState.transportDriverDetails.clear();
    selected.add(String(id));
    workforcePageState.transportDriverDetails.set(selectionKey, {
      driver: document.getElementById('wfTransportDriver')?.value || '',
      contact: document.getElementById('wfTransportDriverContact')?.value || ''
    });
  } else if (wasSelected) {
    selected.delete(String(id));
    workforcePageState.transportDriverDetails.delete(selectionKey);
  } else {
    if (incomingIsOnDemand || selectedOnDemand) {
      selections.fleet.clear();
      selections.external.clear();
      workforcePageState.transportDriverDetails.clear();
      document.getElementById('wfTransportDriver').value = '';
      document.getElementById('wfTransportDriverContact').value = '';
      previousCount = 0;
    }
    if (previousCount === 1) {
      const existingSelection = wfSelectedTransportVehicles()[0];
      const existingKey = wfTransportSelectionKey(
        existingSelection.sourceType,
        existingSelection.id
      );
      workforcePageState.transportDriverDetails.set(existingKey, {
        driver: document.getElementById('wfTransportDriver')?.value || '',
        contact: document.getElementById('wfTransportDriverContact')?.value || ''
      });
    }
    selected.add(String(id));
    workforcePageState.transportDriverDetails.set(selectionKey, {
      driver: previousCount === 0
        ? document.getElementById('wfTransportDriver')?.value || ''
        : '',
      contact: previousCount === 0
        ? document.getElementById('wfTransportDriverContact')?.value || ''
        : ''
    });
  }
  if (source === 'external' && !wasSelected && previousCount === 0) {
    const profile = (workforcePageState.data?.transportVendors || [])
      .find(row => String(row.id) === String(id));
    if (profile?.lastCost !== null && profile?.lastCost !== undefined) {
      document.getElementById('wfTransportCost').value =
        Number(profile.lastCost || 0).toFixed(2);
    }
  }
  document.getElementById('wfTransportDriver')
    .closest('.wf-driver-combobox').dataset.selectedUsername = '';
  setTransportBookingSource(source);
  if (document.getElementById('wfTransportTripType')?.value === 'return') {
    applyTransportReturnDefaults();
  }
}

function renderExternalTransportChoices(selectedId = '') {
  const root = document.getElementById('wfExternalVehicleChoices');
  if (!root) return;
  const profiles = workforcePageState.data?.transportVendors || [];
  root.innerHTML = profiles.length ? profiles.map(profile => {
    const isOnDemand = profile.profileType === 'on_demand';
    const label = isOnDemand
      ? (profile.company || 'On-demand provider')
      : [profile.vehicleType, profile.vehicleNumber].filter(Boolean).join(' - ');
    const subtitle = isOnDemand
      ? (profile.vehicleType ? `Default: ${profile.vehicleType}` : 'Choose vehicle type per booking')
      : (profile.company || 'Company not recorded');
    const lastCost = profile.lastCost === null || profile.lastCost === undefined
      ? 'No previous cost'
      : `Last cost ${wfMoney(profile.lastCost)}`;
    return `<button class="wf-booking-vehicle-option" type="button"
        data-source="external" data-id="${wfAttr(profile.id)}"
        onclick="selectTransportVehicle('external','${wfAttr(profile.id)}')">
      <span><strong>${wfEscape(label || 'External transport')}</strong>
        <small>${wfEscape(subtitle)}</small></span>
      <em class="${isOnDemand ? 'on-demand' : ''}">${isOnDemand ? 'On-demand' : wfEscape(lastCost)}</em>
    </button>`;
  }).join('') : `<div class="wf-vehicle-choice-empty">No known external vehicles yet.
    <button class="wf-link-button" type="button" onclick="openTransportProfileForBooking()">Add transport</button></div>`;
  setTransportBookingSource('external');
}

function renderFleetTransportChoices(vehicles, complete, selectedId = '') {
  const root = document.getElementById('wfFleetVehicleChoices');
  if (!root) return;
  root.innerHTML = vehicles.length ? vehicles.map(vehicle => {
    const available = complete ? Boolean(vehicle.available) : null;
    const stateLabel = available === null
      ? 'Enter full usage time'
      : (available ? 'Available' : 'Unavailable');
    return `<button class="wf-booking-vehicle-option ${available === false ? 'unavailable' : ''}" type="button"
        data-source="fleet" data-id="${wfAttr(vehicle.id)}"
        ${available === false || available === null ? 'disabled' : ''}
        title="${wfAttr(vehicle.conflict || stateLabel)}"
        onclick="selectTransportVehicle('fleet','${wfAttr(vehicle.id)}')">
      <span><strong>${wfEscape(vehicle.registrationNumber || 'Vehicle')}</strong>
        <small>${wfEscape(vehicle.name || vehicle.vehicleType || 'Company vehicle')}</small></span>
      <em class="${available === false ? 'unavailable' : (available ? 'available' : 'pending')}">${wfEscape(stateLabel)}</em>
      ${vehicle.conflict ? `<small class="wf-vehicle-conflict">${wfEscape(vehicle.conflict)}</small>` : ''}
    </button>`;
  }).join('') : `<div class="wf-vehicle-choice-empty">No active company vehicles.
    <button class="wf-link-button" type="button" onclick="manageOwnVehicles()">Manage own vehicles</button></div>`;
  setTransportBookingSource(
    document.getElementById('wfTransportSourceType')?.value || ''
  );
}

function scheduleTransportAvailability(immediate = false) {
  clearTimeout(workforcePageState.transportAvailabilityTimer);
  workforcePageState.transportAvailabilityTimer = setTimeout(
    loadTransportFleetAvailability,
    immediate ? 0 : 180
  );
}

function syncTransportUsageDate() {
  const tripDate = document.getElementById('wfDepartDate');
  const returnDate = document.getElementById('wfVehicleUseEndDate');
  if (!tripDate || !returnDate) return;
  const previousTripDate = tripDate.dataset.previousValue || '';
  if (!returnDate.value || returnDate.value === previousTripDate) {
    returnDate.value = tripDate.value;
  }
  tripDate.dataset.previousValue = tripDate.value;
  scheduleTransportAvailability();
}

async function loadTransportFleetAvailability() {
  const date = document.getElementById('wfDepartDate')?.value || '';
  const startTime = document.getElementById('wfDepartTime')?.value || '';
  const endDateInput = document.getElementById('wfVehicleUseEndDate');
  const endDate = endDateInput?.value || date;
  const endTime = document.getElementById('wfVehicleUseEndTime')?.value || '';
  const allVehicles = (workforcePageState.data?.vehicles || [])
    .filter(row => row.active !== false);
  const selectedIds = workforcePageState.transportVehicleSelections.fleet;
  if (!date || !startTime || !endTime) {
    renderFleetTransportChoices(allVehicles, false);
    return;
  }
  if (endDateInput && !endDateInput.value) {
    endDateInput.value = endDate;
  }
  if (
    new Date(`${endDate}T${endTime}:00`).getTime() <=
    new Date(`${date}T${startTime}:00`).getTime()
  ) {
    renderFleetTransportChoices(allVehicles, false);
    return;
  }
  const requestId = ++workforcePageState.transportAvailabilityRequest;
  const params = new URLSearchParams({
    date,
    startTime,
    endDate,
    endTime
  });
  if (workforcePageState.editingTransportId) {
    params.set('excludeBookingId', workforcePageState.editingTransportId);
  }
  try {
    const response = await apiCall(`/api/vehicles/availability?${params}`);
    if (requestId !== workforcePageState.transportAvailabilityRequest) return;
    const vehicles = response.data?.vehicles || [];
    const unavailableIds = new Set(
      vehicles.filter(row => row.available === false).map(row => String(row.id))
    );
    [...selectedIds].forEach(id => {
      if (unavailableIds.has(id)) selectedIds.delete(id);
    });
    renderFleetTransportChoices(vehicles, true);
  } catch (error) {
    if (requestId !== workforcePageState.transportAvailabilityRequest) return;
    renderFleetTransportChoices(allVehicles, false);
  }
}

async function saveTransportBooking(event) {
  event.preventDefault();
  const id = workforcePageState.editingTransportId;
  const currentBooking = workforcePageState.data.transportBookings
    .find(row => String(row.id) === String(id));
  const tripType = document.getElementById('wfTransportTripType').value;
  const selections = wfSelectedTransportVehicles();
  if (!selections.length) {
    wfError('wfTransportBookingError', 'Choose an own-fleet vehicle, external vehicle or on-demand provider.');
    return;
  }
  const onDemandSelection = selections.length === 1
    && wfTransportSelectionIsOnDemand(selections[0]);
  const onDemandVehicleType = String(
    document.getElementById('wfOnDemandVehicleType')?.value || ''
  ).trim();
  const requestedQuantity = Number(
    document.getElementById('wfOnDemandQuantity')?.value || 1
  );
  if (onDemandSelection && !onDemandVehicleType) {
    wfError('wfTransportBookingError', 'Choose a vehicle type for this booking.');
    return;
  }
  if (
    onDemandSelection
    && !id
    && (!Number.isInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > 50)
  ) {
    wfError('wfTransportBookingError', 'Enter a quantity from 1 to 50.');
    return;
  }
  if (selections.length > 1) {
    const missingDriver = selections
      .filter(selection => !wfTransportSelectionIsOnDemand(selection))
      .some(selection => {
      const details = workforcePageState.transportDriverDetails.get(
        wfTransportSelectionKey(selection.sourceType, selection.id)
      );
      return !String(details?.driver || '').trim();
      });
    if (missingDriver) {
      wfError('wfTransportBookingError', 'Assign a driver to every selected vehicle.');
      return;
    }
  }
  const submit = document.getElementById('wfTransportBookingSubmit');
  if (submit) submit.disabled = true;
  try {
    let latestResponse = null;
    let savedCount = 0;
    for (const selection of selections) {
      const individualDriver = workforcePageState.transportDriverDetails.get(
        wfTransportSelectionKey(selection.sourceType, selection.id)
      ) || {};
      const selectionIsOnDemand = wfTransportSelectionIsOnDemand(selection);
      const bookingCount = selectionIsOnDemand && !id ? requestedQuantity : 1;
      for (let bookingIndex = 0; bookingIndex < bookingCount; bookingIndex += 1) {
        latestResponse = await apiCall(id
          ? `/api/events/${workforcePageState.eventId}/workforce/transport/${encodeURIComponent(id)}`
          : `/api/events/${workforcePageState.eventId}/workforce/transport`, id ? 'PUT' : 'POST', {
          sourceType: selection.sourceType,
          subprojectId: document.getElementById('wfTransportSubproject').value,
          tripType,
          vendorId: selection.sourceType === 'external' ? selection.id : '',
          vehicleId: selection.sourceType === 'fleet' ? selection.id : '',
          vehicleType: selectionIsOnDemand ? onDemandVehicleType : '',
          driver: selectionIsOnDemand ? '' : (selections.length > 1
            ? individualDriver.driver
            : document.getElementById('wfTransportDriver').value),
          driverContact: selectionIsOnDemand ? '' : (selections.length > 1
            ? individualDriver.contact
            : document.getElementById('wfTransportDriverContact').value),
          locationFrom: document.getElementById('wfLocationFrom').value,
          locationFromName: document.getElementById('wfLocationFrom').value,
          locationFromAddress: document.getElementById('wfLocationFromAddress').value,
          locationTo: document.getElementById('wfLocationTo').value,
          locationToName: document.getElementById('wfLocationTo').value,
          locationToAddress: document.getElementById('wfLocationToAddress').value,
          saveLocations: document.getElementById('wfSaveBookingLocations').checked,
          departDate: document.getElementById('wfDepartDate').value,
          departTime: document.getElementById('wfDepartTime').value,
          useEndDate: selection.sourceType === 'fleet'
            ? document.getElementById('wfVehicleUseEndDate').value
            : '',
          useEndTime: selection.sourceType === 'fleet'
            ? document.getElementById('wfVehicleUseEndTime').value
            : '',
          cost: document.getElementById('wfTransportCost').value,
          twoWay: Boolean(currentBooking?.twoWay),
          returnDate: currentBooking?.twoWay ? currentBooking.returnDate : '',
          returnTime: currentBooking?.twoWay ? currentBooking.returnTime : '',
          status: currentBooking?.status || 'Pending Review'
        });
        workforcePageState.data = latestResponse.data;
        savedCount += 1;
      }
    }
    closeWorkforceModal('wfTransportBookingModal');
    renderWorkforcePage();
    showNotification('success', savedCount > 1
      ? `${savedCount} ${tripType === 'return' ? 'return' : 'depart'} transport bookings saved`
      : `${tripType === 'return' ? 'Return' : 'Depart'} transport saved`);
  } catch (error) {
    wfError('wfTransportBookingError', error.message);
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function deleteTransportBooking(id) {
  const response = await apiCall(`/api/events/${workforcePageState.eventId}/workforce/transport/${encodeURIComponent(id)}`, 'DELETE');
  workforcePageState.data = response.data;
  renderWorkforcePage();
}

function wfTransportInvoiceDragOver(event) {
  event.preventDefault();
  event.currentTarget.classList.add('is-file-dragging');
}

function wfTransportInvoiceDragLeave(event) {
  if (event.currentTarget.contains(event.relatedTarget)) return;
  event.currentTarget.classList.remove('is-file-dragging');
}

function closeWorkforceStatusMenus(except = null) {
  document.querySelectorAll('.wf-status-menu.open').forEach(menu => {
    if (menu === except) return;
    menu.classList.remove('open', 'open-upward');
    menu.closest('.wf-status-control')?.classList.remove('menu-open');
    menu.closest('.wf-worker')?.classList.remove('status-menu-open');
    menu.closest('.wf-department')?.classList.remove('status-menu-open');
  });
}

function toggleWorkforceStatusMenu(event, id) {
  event.stopPropagation();
  const target = document.getElementById(`wfStatusMenu-${id}`);
  if (!target) return;
  const willOpen = !target.classList.contains('open');
  closeWorkforceStatusMenus(target);
  target.classList.toggle('open', willOpen);
  target.classList.remove('open-upward');
  target.closest('.wf-status-control')?.classList.toggle('menu-open', willOpen);
  target.closest('.wf-worker')?.classList.toggle('status-menu-open', willOpen);
  target.closest('.wf-department')?.classList.toggle('status-menu-open', willOpen);
  if (willOpen) {
    const buttonRect = event.currentTarget.getBoundingClientRect();
    if (window.innerHeight - buttonRect.bottom < 170 && buttonRect.top > 170) {
      target.classList.add('open-upward');
    }
  }
}

async function chooseWorkforceStatus(event, id, status) {
  event.stopPropagation();
  closeWorkforceStatusMenus();
  const found = wfFindSubmission(id);
  if (!found) return;
  if (
    found.record.status === status &&
    !found.record.paymentConfirmedAt &&
    status !== 'Denied'
  ) return;
  if (!found.record.verifiedAt && status !== 'Pending Review') {
    openWorkforceReview(id, status === 'Payment Confirmed' ? 'Paid' : status);
    return;
  }
  if (status === 'Denied') {
    openWorkforceDenialReason(id);
    return;
  }
  await applyWorkforceStatus(id, status);
}

function wfClaimsForEventSubject(eventId, subjectId) {
  const targetEventId = Number(eventId || 0);
  const targetSubjectId = String(subjectId || '');
  for (const row of workforceDocumentsState.rows || []) {
    if (
      row.isClaimGroup &&
      Number(row.eventId || row.event?.id || 0) === targetEventId &&
      String(row.freelancerId || row.subject?.id || '') === targetSubjectId
    ) {
      return row.claims || [];
    }
  }
  if (Number(workforcePageState.data?.event?.id || 0) === targetEventId) {
    return workforcePageState.data?.submissions?.[targetSubjectId]?.claims || [];
  }
  return [];
}

async function chooseWorkforceClaimGroupStatus(event, eventId, subjectId, status) {
  event.stopPropagation();
  closeWorkforceStatusMenus();
  const claims = wfClaimsForEventSubject(eventId, subjectId);
  if (claims.length < 2) return;
  if (claims.some(record => !record.verifiedAt)) {
    showNotification('warning', 'Review every claim individually before updating them together');
    return;
  }
  try {
    const response = await apiCall('/api/workforce/submissions/bulk-status', 'PUT', {
      submissionIds: claims.map(record => record.id),
      status
    });
    await refreshAfterWorkforceSubmissionMutation(response.data);
    showNotification('success', `${Number(response.updatedCount || 0)} claims updated to ${status}`);
  } catch (error) {
    showNotification('error', error.message);
  }
}

async function applyWorkforceStatus(id, status, denialReason = '') {
  const found = wfFindSubmission(id);
  if (!found) return;
  const adminConfirmingPayment = status === 'Payment Confirmed';
  try {
    const response = await apiCall(`/api/workforce/submissions/${encodeURIComponent(id)}`, 'PUT', {
      status: adminConfirmingPayment ? 'Paid' : status,
      amount: found.record.amount,
      denialReason,
      allocations: found.record.allocations || [],
      department: found.record.department || '',
      adminConfirmPayment: adminConfirmingPayment,
      clearPaymentConfirmation: Boolean(found.record.paymentConfirmedAt) && !adminConfirmingPayment
    });
    await refreshAfterWorkforceSubmissionMutation(response.data);
    return true;
  } catch (error) {
    showNotification('error', error.message);
    return false;
  }
}

function openWorkforceDenialReason(id, fromReview = false) {
  ensureWorkforceModals();
  const found = wfFindSubmission(id);
  if (!found) return;
  workforcePageState.denialSubmissionId = id;
  workforcePageState.reviewDenialPending = Boolean(fromReview);
  document.getElementById('wfDenialReason').value =
    found.record.denialReason || '';
  wfError('wfDenialReasonError');
  openWorkforceModal('wfDenialReasonModal');
}

async function saveWorkforceDenialReason(event) {
  event.preventDefault();
  const id = workforcePageState.denialSubmissionId;
  if (!id) return;
  const button = event.currentTarget.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    if (workforcePageState.reviewDenialPending) {
      const reason = document.getElementById('wfDenialReason').value;
      workforcePageState.reviewDenialPending = false;
      closeWorkforceModal('wfDenialReasonModal');
      await submitWorkforceReview('Denied', reason);
      return;
    }
    const saved = await applyWorkforceStatus(
      id,
      'Denied',
      document.getElementById('wfDenialReason').value
    );
    if (saved) {
      closeWorkforceModal('wfDenialReasonModal');
      if (workforcePageState.historyReturnFreelancerId) {
        const returnId = workforcePageState.historyReturnFreelancerId;
        workforcePageState.historyReturnFreelancerId = null;
        await openFreelancerHistory(returnId);
      }
    }
  } catch (error) {
    wfError('wfDenialReasonError', error.message);
  } finally {
    button.disabled = false;
  }
}

function cancelWorkforceDenial() {
  workforcePageState.reviewDenialPending = false;
  workforcePageState.denialSubmissionId = null;
  if (!document.getElementById('wfReviewModal')?.classList.contains('open')) {
    workforcePageState.historyReturnFreelancerId = null;
  }
  closeWorkforceModal('wfDenialReasonModal');
}

function wfEvenAllocationMap(departments, amount) {
  const codes = [...new Set((departments || []).filter(Boolean))];
  if (amount === '' || amount === null || amount === undefined) return {};
  const totalCents = Math.max(0, Math.round(Number(amount || 0) * 100));
  if (!codes.length || !Number.isFinite(totalCents)) return {};
  const centsEach = Math.floor(totalCents / codes.length);
  let remainder = totalCents % codes.length;
  return Object.fromEntries(codes.map(code => {
    const cents = centsEach + (remainder-- > 0 ? 1 : 0);
    return [code, (cents / 100).toFixed(2)];
  }));
}

function applyDefaultReviewAllocations() {
  if (!workforcePageState.autoAllocation) return;
  const amount = document.getElementById('wfReviewAmount')?.value || 0;
  const inputs = [...document.querySelectorAll('.wf-allocation-input')];
  const values = wfEvenAllocationMap(
    inputs.map(input => input.dataset.department),
    amount
  );
  inputs.forEach(input => {
    input.value = values[input.dataset.department] ?? '';
  });
  updateAllocationProgress();
}

function wfReviewClaimCategoryFields(record, verified) {
  const rawCategory = wfClaimCategory(record);
  const category = ['Meal', 'Crew Transport', 'Equipment Transport', 'Purchase'].includes(rawCategory)
    ? rawCategory
    : (rawCategory ? 'Other' : '');
  const otherValue = category === 'Other' ? rawCategory : '';
  return `<label class="wf-field"><span>Claim date *</span>
      <input id="wfReviewClaimDate" type="date" value="${wfAttr(record.claimDate || '')}" required ${verified ? 'disabled' : ''}>
    </label>
    <label class="wf-field"><span>Category *</span>
      <select id="wfReviewClaimCategory" required ${verified ? 'disabled' : ''}
        onchange="syncWorkforceReviewClaimCategory()">
        <option value="" ${category ? '' : 'selected'} disabled>Select category</option>
        <option value="Meal" ${category === 'Meal' ? 'selected' : ''}>Meal</option>
        <option value="Crew Transport" ${category === 'Crew Transport' ? 'selected' : ''}>Crew Transport</option>
        <option value="Equipment Transport" ${category === 'Equipment Transport' ? 'selected' : ''}>Equipment Transport</option>
        <option value="Purchase" ${category === 'Purchase' ? 'selected' : ''}>Purchase</option>
        <option value="Other" ${category === 'Other' ? 'selected' : ''}>Other</option>
      </select>
    </label>
    <label class="wf-field full" id="wfReviewOtherCategoryField" ${category === 'Other' ? '' : 'hidden'}>
      <span>Other category *</span>
      <input id="wfReviewOtherCategory" value="${wfAttr(otherValue)}" ${category === 'Other' && !verified ? 'required' : ''} ${verified ? 'disabled' : ''}>
    </label>`;
}

function syncWorkforceReviewClaimCategory() {
  const select = document.getElementById('wfReviewClaimCategory');
  const field = document.getElementById('wfReviewOtherCategoryField');
  const input = document.getElementById('wfReviewOtherCategory');
  if (!select || !field || !input) return;
  const other = select.value === 'Other';
  field.hidden = !other;
  input.required = other && !input.disabled;
}

function wfReviewExpectedAmountHtml(record) {
  const expected = record.expectedAmount;
  const hasExpected = expected !== null && expected !== undefined && Number.isFinite(Number(expected));
  const breakdown = (record.expectedAmountBreakdown || []).map(row => `
    <span><strong>${wfEscape(row.role || 'Assigned role')}</strong>
      ${row.department ? ` <b>${wfEscape(row.department)}</b>` : ''}
      <small>${wfEscape(row.calculation || '')}${row.amount == null ? '' : ` = ${wfMoney(row.amount)}`}</small></span>
  `).join('');
  return `<section class="wf-amount-check ${hasExpected ? '' : 'is-unavailable'}" id="wfReviewAmountCheck"
      data-expected="${hasExpected ? Number(expected) : ''}">
    <div class="wf-amount-check-values">
      <div><span>${record.isTransportInvoice ? 'Expected transport cost' : 'Expected from role'}</span><strong>${hasExpected ? wfMoney(expected) : 'Not available'}</strong></div>
      <div><span>Detected / entered</span><strong id="wfReviewDetectedAmount">${record.amount == null ? 'Not detected' : wfMoney(record.amount)}</strong></div>
      <span class="wf-amount-match" id="wfReviewAmountMatch">${hasExpected ? 'Checking' : 'No role estimate'}</span>
    </div>
    ${breakdown ? `<div class="wf-amount-breakdown">${breakdown}</div>` : '<small class="wf-amount-no-role">No rated role is assigned to this worker or vendor for the event.</small>'}
  </section>`;
}

function wfIsoDayNumber(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000;
  return Number.isFinite(day) ? day : null;
}

function wfReviewDateLabel(value) {
  const day = wfIsoDayNumber(value);
  if (day === null) return String(value || '');
  return new Date(day * 86400000).toLocaleDateString('en-SG', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
  });
}

function wfReviewDaySpanLabel(firstDay, lastDay) {
  const first = new Date(firstDay * 86400000);
  const last = new Date(lastDay * 86400000);
  const firstDate = first.getUTCDate();
  const lastDate = last.getUTCDate();
  const firstMonth = first.toLocaleDateString('en-SG', { month: 'long', timeZone: 'UTC' });
  const lastMonth = last.toLocaleDateString('en-SG', { month: 'long', timeZone: 'UTC' });
  const firstYear = first.getUTCFullYear();
  const lastYear = last.getUTCFullYear();
  if (firstDay === lastDay) return `${firstDate} ${firstMonth} ${firstYear}`;
  if (firstYear === lastYear && first.getUTCMonth() === last.getUTCMonth()) {
    return `${firstDate} - ${lastDate} ${lastMonth} ${lastYear}`;
  }
  if (firstYear === lastYear) {
    return `${firstDate} ${firstMonth} - ${lastDate} ${lastMonth} ${lastYear}`;
  }
  return `${firstDate} ${firstMonth} ${firstYear} - ${lastDate} ${lastMonth} ${lastYear}`;
}

function wfReviewDateRangesLabel(values) {
  const days = [...new Set((values || []).map(wfIsoDayNumber).filter(day => day !== null))]
    .sort((left, right) => left - right);
  if (!days.length) return '';
  const ranges = [];
  let first = days[0];
  let last = days[0];
  days.slice(1).forEach(day => {
    if (day === last + 1) {
      last = day;
      return;
    }
    ranges.push([first, last]);
    first = day;
    last = day;
  });
  ranges.push([first, last]);
  return ranges.map(([start, end]) => wfReviewDaySpanLabel(start, end)).join(', ');
}

function wfReviewDateSpanLabel(startValue, endValue) {
  const start = wfIsoDayNumber(startValue);
  const end = wfIsoDayNumber(endValue);
  if (start === null) return '';
  return wfReviewDaySpanLabel(start, end === null ? start : end);
}

function wfReviewClaimDateCheckHtml(record) {
  const event = workforcePageState.data?.event || record.event || {};
  const workDates = [...new Set(record.assignmentWorkDates || [])].sort();
  const eventStart = event.startDateValue || '';
  const eventEnd = event.endDateValue || eventStart;
  const hiredLabel = workDates.length
    ? wfReviewDateRangesLabel(workDates)
    : 'No specific work dates';
  const eventLabel = eventStart
    ? wfReviewDateSpanLabel(eventStart, eventEnd)
    : 'Event dates unavailable';
  return `<section class="wf-amount-check wf-claim-date-check" id="wfReviewClaimDateCheck"
      data-work-dates="${wfAttr(workDates.join(','))}" data-event-start="${wfAttr(eventStart)}"
      data-event-end="${wfAttr(eventEnd)}">
    <div class="wf-amount-check-values wf-claim-date-check-values">
      <div class="wf-claim-date-entered"><span>Claim date</span><strong id="wfReviewClaimDateValue">${wfEscape(wfReviewDateLabel(record.claimDate) || 'Not provided')}</strong></div>
      <div class="wf-claim-date-reference is-neutral" id="wfReviewHiredDateCheck">
        <span>Hired for</span><strong>${wfEscape(hiredLabel)}</strong>
        <small class="wf-amount-match is-neutral" id="wfReviewHiredDateMatch">Checking hired date</small>
      </div>
      <div class="wf-claim-date-reference is-neutral" id="wfReviewEventDateCheck">
        <span>Event window</span><strong>${wfEscape(eventLabel)}</strong>
        <small class="wf-amount-match is-neutral" id="wfReviewEventDateMatch">Checking event date</small>
      </div>
    </div>
  </section>`;
}

function wfSetClaimDateCheckState(box, result, state, message) {
  if (!box || !result) return;
  box.classList.remove('is-match', 'is-warning', 'is-difference', 'is-neutral');
  result.className = `wf-amount-match ${state}`;
  result.textContent = message;
  box.classList.add(state);
}

function updateWorkforceClaimDateComparison() {
  const card = document.getElementById('wfReviewClaimDateCheck');
  const input = document.getElementById('wfReviewClaimDate');
  const valueNode = document.getElementById('wfReviewClaimDateValue');
  const hiredBox = document.getElementById('wfReviewHiredDateCheck');
  const hiredResult = document.getElementById('wfReviewHiredDateMatch');
  const eventBox = document.getElementById('wfReviewEventDateCheck');
  const eventResult = document.getElementById('wfReviewEventDateMatch');
  if (!card || !input || !valueNode || !hiredBox || !hiredResult || !eventBox || !eventResult) return;
  const claimDate = String(input.value || '');
  const claimDay = wfIsoDayNumber(claimDate);
  const workDays = String(card.dataset.workDates || '').split(',')
    .map(wfIsoDayNumber).filter(day => day !== null);
  const eventStart = wfIsoDayNumber(card.dataset.eventStart);
  const eventEnd = wfIsoDayNumber(card.dataset.eventEnd) ?? eventStart;
  valueNode.textContent = wfReviewDateLabel(claimDate) || 'Not provided';
  if (claimDay === null) {
    wfSetClaimDateCheckState(hiredBox, hiredResult, 'is-neutral', 'Claim date required');
    wfSetClaimDateCheckState(eventBox, eventResult, 'is-neutral', 'Claim date required');
    return;
  }

  if (workDays.length) {
    const hiredDistance = Math.min(...workDays.map(day => Math.abs(claimDay - day)));
    const hiredState = hiredDistance === 0
      ? 'is-match'
      : (hiredDistance === 1 ? 'is-warning' : 'is-difference');
    wfSetClaimDateCheckState(
      hiredBox,
      hiredResult,
      hiredState,
      hiredDistance === 0
        ? 'Matches hired date'
        : `${hiredDistance} day${hiredDistance === 1 ? '' : 's'} from hired date`
    );
  } else {
    wfSetClaimDateCheckState(hiredBox, hiredResult, 'is-neutral', 'No hired dates to compare');
  }

  if (eventStart !== null && eventEnd !== null) {
    const first = Math.min(eventStart, eventEnd);
    const last = Math.max(eventStart, eventEnd);
    const eventDistance = claimDay < first ? first - claimDay : (claimDay > last ? claimDay - last : 0);
    const eventState = eventDistance === 0
      ? 'is-match'
      : (eventDistance === 1 ? 'is-warning' : 'is-difference');
    wfSetClaimDateCheckState(
      eventBox,
      eventResult,
      eventState,
      eventDistance === 0
        ? 'Within event dates'
        : `${eventDistance} day${eventDistance === 1 ? '' : 's'} outside event dates`
    );
  } else {
    wfSetClaimDateCheckState(eventBox, eventResult, 'is-neutral', 'No event dates to compare');
  }
}

function updateWorkforceExpectedComparison() {
  const card = document.getElementById('wfReviewAmountCheck');
  const detectedNode = document.getElementById('wfReviewDetectedAmount');
  const resultNode = document.getElementById('wfReviewAmountMatch');
  const input = document.getElementById('wfReviewAmount');
  if (!card || !detectedNode || !resultNode || !input) return;
  const expected = Number(card.dataset.expected);
  const enteredText = String(input.value || '').trim();
  const entered = Number(enteredText);
  detectedNode.textContent = enteredText && Number.isFinite(entered)
    ? wfMoney(entered)
    : 'Not detected';
  resultNode.className = 'wf-amount-match';
  if (!card.dataset.expected) {
    resultNode.textContent = 'No role estimate';
    resultNode.classList.add('is-neutral');
    return;
  }
  if (!enteredText || !Number.isFinite(entered)) {
    resultNode.textContent = 'Amount required';
    resultNode.classList.add('is-warning');
    return;
  }
  const difference = Math.round((entered - expected) * 100) / 100;
  if (Math.abs(difference) <= 0.01) {
    resultNode.textContent = 'Match';
    resultNode.classList.add('is-match');
  } else if (difference < 0) {
    resultNode.textContent = `${wfMoney(Math.abs(difference))} under expected`;
    resultNode.classList.add('is-under');
  } else {
    resultNode.textContent = `${wfMoney(difference)} over expected`;
    resultNode.classList.add('is-difference');
  }
}

async function openWorkforceReview(id, requestedStatus = '', skipOcrRetry = false) {
  ensureWorkforceModals();
  const documentRecord = wfFindDocumentSubmission(id);
  let found = wfFindSubmission(id);
  if (!found) return;
  if (found.record.processingState === 'Processing') {
    showNotification('info', 'This file is still being processed. It will update automatically.');
    return;
  }
  if (
    found.kind === 'invoice' &&
    found.record.amount == null &&
    !found.record.ocrRetriedAt &&
    !skipOcrRetry
  ) {
    showNotification('info', 'Scanning the invoice for its total amount...');
    try {
      const response = await apiCall(
        `/api/workforce/submissions/${encodeURIComponent(id)}/extract`,
        'POST'
      );
      workforcePageState.data = response.data;
      if (documentRecord) await wfLoadDocumentEvent(documentRecord);
      found = wfFindSubmission(id);
    } catch (error) {
      showNotification('error', `Invoice scan could not determine the total: ${error.message}`);
    }
  }
  if (!found) return;
  workforcePageState.reviewSubmissionId = id;
  const { record, freelancerId, kind } = found;
  const transportInvoice = Boolean(
    record.isTransportInvoice || (found.isTransport && kind === 'invoice')
  );
  const detailsRequired =
    kind === 'claim' && record.submissionStage === 'Details Required';
  const freelancer = wfFindFreelancer(freelancerId) || wfFindVendor(freelancerId) || record.subject || {};
  const departments = transportInvoice ? [] : wfDepartmentsForFreelancer(freelancerId);
  const verified = Boolean(record.verifiedAt);
  const pendingDecision = record.status === 'Pending Review';
  const savedAllocations = record.allocations || [];
  workforcePageState.autoAllocation =
    kind === 'invoice' && !transportInvoice && !savedAllocations.length;
  const allocations = savedAllocations.length
    ? Object.fromEntries(savedAllocations.map(row => [row.department, row.amount]))
    : wfEvenAllocationMap(departments, record.amount);
  const pdf = record.contentType === 'application/pdf';
  const spreadsheet = /\.xlsx?$/i.test(record.originalName || '')
    || record.contentType === 'application/vnd.ms-excel'
    || String(record.contentType || '').includes('spreadsheetml');
  document.getElementById('wfReviewModalTitle').textContent =
    `Review ${kind === 'invoice' ? 'Invoice' : 'Claim'}`;
  document.getElementById('wfReviewContent').innerHTML = `<div class="wf-review-layout">
    <div class="wf-preview">${pdf ? `<iframe src="${wfAttr(record.previewUrl)}#toolbar=1" title="Uploaded PDF"></iframe>`
      : spreadsheet ? `<iframe src="${wfAttr(record.previewUrl)}" sandbox="allow-same-origin allow-downloads" title="Uploaded Excel invoice"></iframe>`
      : `<img src="${wfAttr(record.previewUrl)}" alt="Uploaded ${kind === 'invoice' ? 'invoice' : 'claim'}">`}</div>
    <form class="wf-review-form" id="wfReviewForm"><p class="wf-form-intro">${wfEscape(freelancer.name || '')} &middot; ${wfEscape(record.originalName || '')}</p>
      ${detailsRequired ? `<div class="wf-details-required-note"><strong>Claim details required</strong>
        <span>Complete the missing information below on behalf of the worker before saving or approving this claim.</span></div>` : ''}
      ${kind === 'invoice' ? wfReviewExpectedAmountHtml(record) : wfReviewClaimDateCheckHtml(record)}
      ${kind === 'invoice' ? `<div class="wf-ocr-card"><strong>Document scan</strong><br>
        Confidence: ${wfEscape(record.ocrConfidence || 'Low')} &middot; ${wfEscape(record.ocrSource || 'No extractor result')}</div>`
        : `<div class="wf-ocr-card">${wfEscape(record.category || 'Claim')} &middot; ${wfEscape(record.claimDate || '')}<br>${wfEscape(record.description || '')}</div>`}
      ${verified ? `<div class="wf-verified-note">Last reviewed on ${wfEscape(wfDateTime(record.verifiedAt))}. The details remain editable.</div>` : ''}
      <div class="wf-form-grid">
        <label class="wf-field"><span>Verified amount ($) *</span><input id="wfReviewAmount" type="number" min="0" step=".01" value="${record.amount ?? ''}" required></label>
        ${kind === 'claim' ? wfReviewClaimCategoryFields(record, false) : ''}
        ${kind === 'claim' ? `<label class="wf-field full"><span>Notes</span>
          <textarea id="wfReviewClaimNotes" placeholder="Add a description or note for this claim">${wfEscape(record.notes || record.description || '')}</textarea>
        </label>` : ''}
      </div>
      ${kind === 'invoice' && !transportInvoice ? `<div class="wf-section-card"><h4>Department allocation</h4>
        ${departments.map(code => `<label class="wf-allocation-row"><span>${wfEscape(code)}</span>
          <input class="wf-allocation-input" data-department="${wfAttr(code)}" type="number" min="0" step=".01" value="${allocations[code] ?? ''}"></label>`).join('')}
        <div class="wf-allocation-progress" id="wfAllocationProgress"></div></div>` : ''}
      ${verified && record.status === 'Denied' ? `<div class="wf-denial-summary"><strong>Denial reason</strong><span>${wfEscape(record.denialReason || 'No reason was provided.')}</span></div>` : ''}
      <div class="wf-error" id="wfReviewError"></div>
    </form></div>
    <footer class="wf-review-actions">${pendingDecision || !verified
      ? `<button class="wf-button" type="button" onclick="submitWorkforceReview('Pending Review')">Save &amp; Close</button>
         <button class="wf-button danger" type="button" onclick="denyWorkforceReview()">Deny</button>
         <button class="wf-button approve" type="button" onclick="submitWorkforceReview('Approved')">Approve</button>`
      : `<button class="wf-button" type="button" onclick="closeWorkforceModal('wfReviewModal')">Close</button>
         <button class="wf-button primary" type="button" onclick="submitWorkforceReview('${wfAttr(record.status || 'Pending Review')}')">Save Changes</button>`}</footer>`;
  document.querySelectorAll('.wf-allocation-input').forEach(input => input.addEventListener('input', () => {
    workforcePageState.autoAllocation = false;
    updateAllocationProgress();
  }));
  document.getElementById('wfReviewAmount')?.addEventListener('input', () => {
    applyDefaultReviewAllocations();
    updateAllocationProgress();
    updateWorkforceExpectedComparison();
  });
  document.getElementById('wfReviewClaimDate')?.addEventListener('input', updateWorkforceClaimDateComparison);
  syncWorkforceReviewClaimCategory();
  updateAllocationProgress();
  updateWorkforceExpectedComparison();
  updateWorkforceClaimDateComparison();
  openWorkforceModal('wfReviewModal');
}

function updateAllocationProgress() {
  const node = document.getElementById('wfAllocationProgress');
  if (!node) return;
  const amount = Number(document.getElementById('wfReviewAmount')?.value || 0);
  const allocated = [...document.querySelectorAll('.wf-allocation-input')]
    .reduce((sum, input) => sum + Number(input.value || 0), 0);
  node.textContent = `Allocated ${wfMoney(allocated)} of ${wfMoney(amount)}`;
  node.style.color = Math.abs(allocated - amount) <= .01 || allocated === 0 ? '#166534' : '#b45309';
}

function denyWorkforceReview() {
  const found = wfFindSubmission(workforcePageState.reviewSubmissionId);
  if (!found) return;
  openWorkforceDenialReason(found.record.id, true);
}

function wfReviewDetailsChanged(
  record, amount, allocations, claimDate, category, notes
) {
  const originalAmount = record.amount === null || record.amount === undefined
    ? null
    : Number(record.amount);
  const nextAmount = amount === '' || amount === null || amount === undefined
    ? null
    : Number(amount);
  if (originalAmount !== nextAmount) return true;
  const normalizeAllocations = rows => (rows || [])
    .map(row => `${String(row.department || '')}:${Number(row.amount || 0).toFixed(2)}`)
    .sort()
    .join('|');
  if (normalizeAllocations(record.allocations) !== normalizeAllocations(allocations)) return true;
  if (String(record.claimDate || '') !== String(claimDate || '')) return true;
  if (String(record.category || '') !== String(category || '')) return true;
  return String(record.notes || record.description || '') !== String(notes || '');
}

async function submitWorkforceReview(status, denialReason = '') {
  const found = wfFindSubmission(workforcePageState.reviewSubmissionId);
  if (!found) return false;
  const allocations = [...document.querySelectorAll('.wf-allocation-input')]
    .map(input => ({ department: input.dataset.department, amount: input.value }))
    .filter(row => Number(row.amount || 0) > 0);
  try {
    let category = document.getElementById('wfReviewClaimCategory')?.value || '';
    if (category === 'Other') {
      category = document.getElementById('wfReviewOtherCategory')?.value.trim() || '';
    }
    const amount = document.getElementById('wfReviewAmount').value;
    const claimDate = document.getElementById('wfReviewClaimDate')?.value || '';
    const notes = document.getElementById('wfReviewClaimNotes')?.value || '';
    const detailsChanged = wfReviewDetailsChanged(
      found.record, amount, allocations, claimDate, category, notes
    );
    const response = await apiCall(`/api/workforce/submissions/${encodeURIComponent(found.record.id)}`, 'PUT', {
      amount,
      status,
      denialReason: denialReason || (status === 'Denied' ? found.record.denialReason || '' : ''),
      allocations,
      claimDate,
      category,
      notes,
      confirmReview: true,
      clearPaymentConfirmation: Boolean(found.record.paymentConfirmedAt) && detailsChanged
    });
    workforcePageState.data = response.data;
    closeWorkforceModal('wfReviewModal');
    await refreshAfterWorkforceSubmissionMutation(response.data);
    return true;
  } catch (error) {
    wfError('wfReviewError', error.message);
    return false;
  }
}

async function deleteWorkforceSubmission(id, fromReview = false) {
  if (!await confirmWorkforceSubmissionDeletion(id)) return false;
  const response = await apiCall(`/api/workforce/submissions/${encodeURIComponent(id)}`, 'DELETE');
  if (fromReview) closeWorkforceModal('wfReviewModal');
  await refreshAfterWorkforceSubmissionMutation(response.data);
  return true;
}

async function confirmWorkforceSubmissionDeletion(id) {
  const found = wfFindSubmission(id);
  const documentRecord = wfFindDocumentSubmission(id);
  const record = found?.record || documentRecord || {};
  const kind = found?.kind || record.kind || 'upload';
  const kindLabel = kind === 'invoice' ? 'invoice' : (kind === 'claim' ? 'claim' : 'upload');
  const fileName = String(record.originalName || '').trim();
  return showAppConfirm({
    title: `Delete ${kindLabel}?`,
    message: fileName
      ? `This will permanently delete "${fileName}". This action cannot be undone.`
      : `This will permanently delete this ${kindLabel}. This action cannot be undone.`,
    confirmText: `Delete ${kindLabel.charAt(0).toUpperCase()}${kindLabel.slice(1)}`,
    variant: 'danger'
  });
}

document.addEventListener('click', () => {
  closeWorkforceStatusMenus();
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  hideWorkforceInstantTooltip();
  const modal = document.querySelector('.wf-modal.open');
  if (modal) closeWorkforceModal(modal.id);
});

document.addEventListener('pointerover', event => {
  const target = event.target instanceof Element
    ? event.target.closest('[data-wf-tooltip]')
    : null;
  if (target && target !== workforceTooltipTarget) showWorkforceInstantTooltip(target);
});

document.addEventListener('pointerout', event => {
  const target = event.target instanceof Element
    ? event.target.closest('[data-wf-tooltip]')
    : null;
  if (!target || target !== workforceTooltipTarget) return;
  if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
  hideWorkforceInstantTooltip(target);
});

window.addEventListener('resize', () => {
  if (workforceTooltipTarget) {
    positionWorkforceInstantTooltip(workforceTooltipTarget, ensureWorkforceInstantTooltip());
  }
});

window.addEventListener('scroll', () => {
  if (workforceTooltipTarget) {
    positionWorkforceInstantTooltip(workforceTooltipTarget, ensureWorkforceInstantTooltip());
  }
}, true);

document.addEventListener('DOMContentLoaded', ensureWorkforceModals);
