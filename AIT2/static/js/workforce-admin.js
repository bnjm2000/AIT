const workforcePageState = {
  eventId: null,
  eventOptions: [],
  data: null,
  loading: false,
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
  vendorMemberSelection: new Set(),
  directoryMode: 'manage',
  directorySubject: 'worker',
  directoryDepartment: '',
  historyFreelancerId: null,
  historyReturnFreelancerId: null,
  freelancerWorkspaceData: null,
  freelancerWorkspaceSearch: '',
  freelancerWorkspaceReturnId: null,
  editingTransportProfileId: null,
  selectedTransportProfileId: null,
  selectedFleetVehicleId: null,
  editingTransportId: null,
  returnToTransportBooking: false,
  transportAvailabilityTimer: null,
  transportAvailabilityRequest: 0,
  transportVehicleSelections: {
    fleet: new Set(),
    external: new Set()
  },
  transportDriverDetails: new Map(),
  activeSubprojectId: 'all',
  focusTarget: ''
};

const workforceEventChooserState = {
  search: '',
  filter: 'ALL',
  page: 1,
  pageSize: 8,
  requestId: 0
};

const workforceDocumentsState = {
  rows: [],
  statusCounts: {},
  kindCounts: {},
  statuses: new Set(['to-review', 'to-pay']),
  kind: 'all',
  search: '',
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

function wfEscape(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(String(value ?? ''));
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function wfAttr(value) {
  return wfEscape(value).replace(/"/g, '&quot;');
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

function wfSubprojectTabsHtml() {
  const rooms = wfSubprojects();
  if (rooms.length < 2) return '';
  const assignments = workforcePageState.data?.assignments || [];
  const bookings = workforcePageState.data?.transportBookings || [];
  const tabs = [
    {
      id: 'all',
      name: 'All Rooms',
      assignmentCount: assignments.length,
      bookingCount: bookings.length
    },
    ...rooms.map(room => ({
      id: String(room.id),
      name: room.name,
      assignmentCount: assignments.filter(row =>
        wfEffectiveSubprojectId(row) === String(room.id)
      ).length,
      bookingCount: bookings.filter(row =>
        wfEffectiveSubprojectId(row) === String(room.id)
      ).length
    }))
  ];
  return `<nav class="wf-room-tabs" aria-label="Event rooms">${tabs.map(tab => `
    <button type="button"
      class="${String(workforcePageState.activeSubprojectId) === tab.id ? 'active' : ''}"
      onclick="setWorkforceSubproject('${wfAttr(tab.id)}')">
      <span>${wfEscape(tab.name)}</span>
      <small>${tab.assignmentCount} crew &middot; ${tab.bookingCount} transport</small>
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

function wfStatusOptions(current) {
  return ['Pending Review', 'Approved', 'Denied', 'Paid']
    .map(status => `<option ${status === current ? 'selected' : ''}>${status}</option>`).join('');
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

function wfFindSubmission(id) {
  for (const [freelancerId, rows] of Object.entries(workforcePageState.data?.submissions || {})) {
    for (const plural of ['invoices', 'claims']) {
      const record = rows?.[plural]?.find(row => String(row.id) === String(id));
      if (record) return { record, freelancerId, kind: plural.slice(0, -1) };
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
    name: row.name || code || 'Unknown',
    color: validColour(row.color, '#e2e3e5'),
    textColor: validColour(row.textColor, '#383d41')
  };
}

function wfDepartmentStyle(code) {
  const department = wfDepartmentMeta(code);
  return `--wf-dept-color:${department.color};--wf-dept-text:${department.textColor}`;
}

function wfDepartmentOptions(selectedCode = '') {
  return (workforcePageState.data?.departments || []).map(row => {
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

function openEventWorkforce(eventId, focus = '') {
  if (!isAdminUser()) {
    showNotification('error', 'Admin privileges are required');
    return;
  }
  workforcePageState.eventId = Number(eventId);
  workforcePageState.data = null;
  workforcePageState.activeSubprojectId = 'all';
  workforcePageState.focusTarget = String(focus || '');
  showSection('workforce');
}

async function loadWorkforcePage() {
  const root = document.getElementById('workforce-page-root');
  if (!root || workforcePageState.loading) return;
  workforcePageState.loading = true;
  if (!workforcePageState.data) root.innerHTML = '<div class="loading">Loading manpower and transport...</div>';
  try {
    if (!workforcePageState.eventOptions.length) {
      const eventOptionsLoad = await startProgressiveEventOptions(
        workforcePageState.eventId,
        loaded => {
          workforcePageState.eventOptions = loaded.slice().sort(planCompareEventsByStartDate);
          if (document.getElementById('workforceEventChooserModal')?.classList.contains('active')) {
            renderWorkforceEventChooser();
          }
        }
      );
      workforcePageState.eventOptions = eventOptionsLoad.first
        .slice()
        .sort(planCompareEventsByStartDate);
      eventOptionsLoad.completion.then(loaded => {
        workforcePageState.eventOptions = loaded.slice().sort(planCompareEventsByStartDate);
        if (document.getElementById('workforceEventChooserModal')?.classList.contains('active')) {
          renderWorkforceEventChooser();
        }
      }).catch(error => console.warn('Unable to load more event options:', error));
    }
    if (!workforcePageState.eventId) {
      workforcePageState.eventId = Number(workforcePageState.eventOptions[0]?.id || 0);
    }
    if (!workforcePageState.eventId) {
      root.innerHTML = '<div class="wf-panel wf-empty">Create an event before assigning manpower or transport.</div>';
      return;
    }
    const response = await apiCall(`/api/events/${workforcePageState.eventId}/workforce`);
    workforcePageState.data = response.data;
    renderWorkforcePage();
  } catch (error) {
    root.innerHTML = `<div class="wf-panel wf-empty">Unable to load this page: ${wfEscape(error.message)}</div>`;
  } finally {
    workforcePageState.loading = false;
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
  closeModal('workforceEventChooserModal');
  workforcePageState.eventId = id;
  workforcePageState.data = null;
  workforcePageState.activeSubprojectId = 'all';
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
    return '<span class="wf-status-button status-awaiting-upload">Awaiting upload</span>';
  }
  const displayStatus = record.paymentConfirmedAt
    ? 'Payment Confirmed'
    : (record.status || 'Pending Review');
  if (['queued', 'processing', 'details-required'].includes(statusKey)) {
    const label = WF_DOCUMENT_STATUS_FILTERS.find(row => row[0] === statusKey)?.[1] || record.statusLabel;
    return `<span class="wf-status-button ${wfStatusClass(label)}">${wfEscape(label)}</span>`;
  }
  if (displayStatus === 'Pending Review') {
    return `<button class="wf-status-button ${wfStatusClass(displayStatus)}" type="button"
      onclick="event.stopPropagation();openWorkforceDocumentSubmission('${wfAttr(record.id)}')">
      Pending Review
    </button>`;
  }
  return `<div class="wf-status-control wf-document-status-control">
    <button class="wf-status-button ${wfStatusClass(displayStatus)}" type="button"
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
        <button class="wf-back" type="button" onclick="showSection('workforce')">&larr; Back to Manpower &amp; Transport</button>
        <h2>Invoices &amp; Claims</h2>
        <p>Review every worker and vendor upload across your company.</p>
      </div>
      <div class="wf-documents-sort-note">Newest event dates first, then uploader name</div>
    </div>
    <div class="wf-document-metrics" id="wfDocumentMetrics"></div>
    <section class="wf-panel wf-documents-panel">
      <header class="wf-documents-toolbar">
        <div class="wf-document-kind-tabs" id="wfDocumentKindTabs" aria-label="Document type filters"></div>
        <label class="wf-document-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m16 16 4 4"></path></svg>
          <input type="search" placeholder="Search event, uploader, file or department"
            value="${wfAttr(workforceDocumentsState.search)}"
            oninput="wfDocumentsSearchChanged(this.value)">
        </label>
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
  const requestId = ++workforceDocumentsState.requestId;
  workforceDocumentsState.loading = true;
  const list = document.getElementById('wfDocumentsList');
  if (!options.quiet && list) {
    list.innerHTML = '<div class="wf-documents-loading"><span class="wf-loading-spinner"></span>Loading invoices and claims...</div>';
  }
  const params = new URLSearchParams({
    page: String(workforceDocumentsState.page),
    pageSize: String(workforceDocumentsState.pageSize),
    kind: workforceDocumentsState.kind
  });
  if (workforceDocumentsState.statuses.size) {
    [...workforceDocumentsState.statuses].forEach(status => params.append('status', status));
  } else {
    params.set('status', 'all');
  }
  if (workforceDocumentsState.search) params.set('search', workforceDocumentsState.search);
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
  if (!metrics || !kindTabs || !statusFilters || !list || !pagination) return;

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
      <span>Event</span><span>Uploader</span><span>File</span><span>Submitted</span><span>Amount</span><span>Status</span><span>Download</span>
    </div>` + (workforceDocumentsState.rows.length
      ? workforceDocumentsState.rows.map(wfDocumentRow).join('')
      : `<div class="wf-documents-empty"><strong>No matching uploads</strong><span>Try another status, type, or search term.</span></div>`);
  renderWorkforceDocumentsPagination(pagination);
}

function wfDocumentRow(record) {
  const event = record.event || {};
  const subject = record.subject || {};
  const eventDates = event.startDate === event.endDate || !event.endDate
    ? event.startDate
    : `${event.startDate} - ${event.endDate}`;
  const detail = record.kind === 'claim'
    ? [record.category, record.description || record.notes].filter(Boolean).join(' - ')
    : 'Invoice';
  const canOpenSubject = ['worker', 'vendor'].includes(subject.type) && subject.id;
  const departments = (record.departmentDetails || []).map(department => `
    <span class="wf-document-department" style="--wf-document-dept-bg:${wfAttr(department.color || '#e2e3e5')};--wf-document-dept-text:${wfAttr(department.textColor || '#383d41')}"
      title="${wfAttr(department.name || department.code)}">${wfEscape(department.code || department.name)}</span>
  `).join('');
  const awaitingUpload = Boolean(record.isAwaitingUpload);
  const fileCell = awaitingUpload
    ? `<div class="wf-document-file is-awaiting" data-label="File">
        <span class="wf-document-type is-awaiting">INV</span>
        <span><strong>No invoice uploaded</strong><small>Awaiting worker or vendor upload</small></span>
      </div>`
    : `<button class="wf-document-file" data-label="File" type="button" onclick="openWorkforceDocumentSubmission('${wfAttr(record.id)}')">
        <span class="wf-document-type is-${wfAttr(record.kind)}">${record.kind === 'invoice' ? 'INV' : 'CLM'}</span>
        <span><strong title="${wfAttr(record.originalName)}">${wfEscape(record.originalName || `${record.kind} upload`)}</strong><small>${wfEscape(detail || (record.kind === 'invoice' ? 'Invoice' : 'Claim'))}</small></span>
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
      <span><strong>${wfEscape(subject.name || 'Unknown')}</strong><small>${wfEscape(subject.type === 'vendor' ? 'Vendor' : (subject.company || 'Worker'))}</small>
        ${departments ? `<span class="wf-document-departments">${departments}</span>` : ''}</span>
    </button>
    ${fileCell}
    <div class="wf-document-submitted" data-label="Submitted"><strong>${awaitingUpload ? 'Not uploaded' : wfEscape(wfDateTime(record.submittedAt) || 'Unknown')}</strong></div>
    <div class="wf-document-amount" data-label="Amount"><strong>${awaitingUpload ? '-' : (record.amount == null ? 'To verify' : wfMoney(record.amount))}</strong></div>
    <div class="wf-document-status" data-label="Status">${wfDocumentStatusMenu(record)}</div>
    <div class="wf-document-download" data-label="Download">${downloadCell}</div>
  </article>`;
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
  return workforceDocumentsState.rows.find(row => String(row.id) === String(id));
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
  return Boolean(wfFindSubmission(record.id));
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
    return `<span class="wf-admin-upload-status"><span class="wf-status-button status-uploading">Uploading</span>
      <span class="wf-admin-progress-track"><span data-wf-upload-progress="${wfAttr(record.id)}" style="width:${Number(record.uploadProgress || 0)}%"></span></span>
      <small data-wf-upload-label="${wfAttr(record.id)}">${Math.round(Number(record.uploadProgress || 0))}%</small></span>`;
  }
  if (record.processingState === 'Queued' || record.submissionStage === 'Queued') {
    return `<span class="wf-status-button ${wfStatusClass('Queued')}">Queued</span>`;
  }
  if (record.processingState === 'Processing') {
    return `<span class="wf-status-button ${wfStatusClass('Processing')}">Processing</span>`;
  }
  if (record.submissionStage === 'Details Required') {
    return `<button class="wf-status-button ${wfStatusClass('Details Required')}" type="button"
      onclick="event.stopPropagation();openWorkforceReview('${wfAttr(record.id)}')">
      Details required
    </button>`;
  }
  const displayStatus = record.paymentConfirmedAt
    ? 'Payment Confirmed'
    : (record.status || 'Pending Review');
  if (displayStatus === 'Pending Review') {
    return `<button class="wf-status-button ${wfStatusClass(displayStatus)}" type="button"
      onclick="event.stopPropagation();openWorkforceReview('${wfAttr(record.id)}')">
      Pending Review
    </button>`;
  }
  return `<div class="wf-status-control">
    <button class="wf-status-button ${wfStatusClass(displayStatus)}" type="button"
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

function wfSubmissionRow(record, kind) {
  return `<div class="wf-file-row">
    <button class="wf-file-name" type="button" onclick="openWorkforceReview('${wfAttr(record.id)}')"
      title="${wfAttr(record.originalName)}">${wfEscape(record.originalName || `${kind} upload`)}</button>
    <span class="wf-file-amount">${record.amount == null ? 'Amount to verify' : wfMoney(record.amount)}</span>
    ${wfStatusMenu(record)}
    <button class="wf-icon-button danger" type="button" title="Delete upload"
      onclick="deleteWorkforceSubmission('${wfAttr(record.id)}')">&times;</button>
  </div>`;
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

function wfWorkerHtml(freelancerId, assignments) {
  const freelancer = wfFindFreelancer(freelancerId) || { id: freelancerId, name: 'Unknown worker' };
  const submissions = workforcePageState.data.submissions?.[freelancerId] || { invoices: [], claims: [] };
  const limits = workforcePageState.data.uploadAllowances?.[freelancerId] || {
    invoiceLimit: 1, claimLimit: 5, activeInvoices: 0, activeClaims: 0,
    invoiceSlotsRemaining: 1, claimSlotsRemaining: 5, extraInvoices: 0, extraClaims: 0
  };
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
      <div><strong>${wfEscape(freelancer.name)}</strong>
        <small>${wfEscape(wfFormatPhone(freelancer.phone) || 'No portal phone number')}</small></div>
    </div><small>View all events &rsaquo;</small></button>
    <div class="wf-worker-roles">
      <div class="wf-column-heading"><strong>Role(s)</strong>
        <button class="wf-link-button" type="button"
          onclick="openFreelancerAssignment('${wfAttr(freelancer.id)}','${wfAttr(assignments[0]?.department || '')}')">+ Add role</button></div>
      <div class="wf-assignment-list">${roles}</div>
    </div>
    <section class="wf-submission-box"><header><span>Invoice &middot; ${limits.activeInvoices}/${limits.invoiceLimit}</span>
      ${wfSlotControls(freelancer.id, 'invoice', limits)}</header>
      ${submissions.invoices?.length ? submissions.invoices.map(row => wfSubmissionRow(row, 'invoice')).join('') : '<div class="wf-empty">No invoice submitted.</div>'}</section>
    <section class="wf-submission-box"><header><span>Claims &middot; ${limits.activeClaims}/${limits.claimLimit}</span>
      ${wfSlotControls(freelancer.id, 'claim', limits)}</header>
      ${submissions.claims?.length ? submissions.claims.map(row => wfSubmissionRow(row, 'claim')).join('') : '<div class="wf-empty">No claims submitted.</div>'}</section>
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
    <section class="wf-submission-box wf-vendor-invoice"><header><span>Vendor invoice · ${limits.activeInvoices}/${limits.invoiceLimit}</span>
      ${wfSlotControls(vendor.id, 'invoice', limits)}</header>
      ${submissions.invoices?.length ? submissions.invoices.map(row => wfSubmissionRow(row, 'invoice')).join('') : '<div class="wf-empty">No invoice submitted.</div>'}</section>
    <section class="wf-submission-box"><header><span>Vendor claims · ${limits.activeClaims || 0}/${limits.claimLimit || 5}</span>
      ${wfSlotControls(vendor.id, 'claim', {
        claimLimit: limits.claimLimit || 5,
        activeClaims: limits.activeClaims || 0,
        claimSlotsRemaining: limits.claimSlotsRemaining ?? 5,
        extraClaims: limits.extraClaims || 0
      })}</header>
      ${submissions.claims?.length ? submissions.claims.map(row => wfSubmissionRow(row, 'claim')).join('') : '<div class="wf-empty">No claims submitted.</div>'}</section>
  </article>`;
}

function wfDepartmentHtml(department, assignments) {
  const totals = workforcePageState.data.totals?.departments?.[department] || { invoice: 0, claims: 0, combined: 0 };
  const bySubject = {};
  assignments.forEach(row => (bySubject[row.freelancerId || row.vendorId] ||= []).push(row));
  const subjectIds = Object.keys(bySubject);
  const count = subjectIds.reduce((total, subjectId) => {
    const rows = bySubject[subjectId] || [];
    if (rows.some(row => row.vendorId || row.subjectType === 'vendor')) {
      return total + rows.reduce((pax, row) =>
        pax + (row.providerType === 'manpower' ? Number(row.pax || 0) : 0), 0);
    }
    return total + 1;
  }, 0);
  const stateCounts = subjectIds.reduce((summary, freelancerId) => {
    const submissions = workforcePageState.data.submissions?.[freelancerId] || {};
    [...(submissions.invoices || []), ...(submissions.claims || [])].forEach(record => {
      const status = record.paymentConfirmedAt ? 'Payment Confirmed' : (record.status || 'Pending Review');
      summary[status] = (summary[status] || 0) + 1;
    });
    return summary;
  }, {});
  const statusBadges = ['Pending Review', 'Approved', 'Denied', 'Paid', 'Payment Confirmed']
    .filter(status => Number(stateCounts[status] || 0) > 0)
    .map(status =>
    `<span class="${wfStatusClass(status)}">${status}: <strong>${Number(stateCounts[status] || 0)}</strong></span>`
  ).join('');
  const canRemoveDepartment = !(workforcePageState.data.assignments || [])
    .some(row => row.department === department);
  return `<details class="wf-department" data-department="${wfAttr(department)}" style="${wfDepartmentStyle(department)}">
    <summary><span class="wf-department-title"><span class="wf-department-label">${wfEscape(department)} <small>${count} crew</small></span>
        <span class="wf-dept-status-summary">${statusBadges}</span></span>
      <span class="wf-department-header-actions">
        <button class="wf-button primary" type="button"
          onclick="event.preventDefault();event.stopPropagation();openFreelancerDirectory('assign','${wfAttr(department)}')">+ Add worker</button>
        <button class="wf-button" type="button"
          onclick="event.preventDefault();event.stopPropagation();openVendorDirectory('${wfAttr(department)}')">+ Add Vendor</button>
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
        : wfWorkerHtml(id, rows)
    ).join('') : '<div class="wf-empty">No workers or vendors assigned to this department.</div>'}</div>
  </details>`;
}

function wfTransportCardLegacy(booking) {
  const invoice = booking.invoice;
  return `<article class="wf-transport-card">
    <div class="wf-transport-heading"><div><h4>${wfEscape(booking.vehicleType || 'Transport')}</h4>
      <small>${wfEscape(booking.company || '')} &middot; ${wfEscape(booking.driver || booking.companyDriver || '')}</small></div>
      <span class="wf-status-pill ${wfStatusClass(booking.status)}">${wfEscape(booking.status)}</span></div>
    <div class="wf-transport-meta">
      <div><span>Vehicle</span><strong>${wfEscape(booking.vehicleNumber || '—')}</strong></div>
      <div><span>Contact</span><strong>${wfEscape(booking.contactNumber || '—')}</strong></div>
      <div class="wf-route"><span>Route</span><strong>${wfEscape(booking.locationFrom)} &rarr; ${wfEscape(booking.locationTo)}</strong></div>
      <div><span>Depart</span><strong>${wfEscape(`${booking.departDate} ${booking.departTime}`)}</strong></div>
      <div><span>Return</span><strong>${booking.twoWay ? wfEscape(`${booking.returnDate} ${booking.returnTime}`) : 'One way'}</strong></div>
      <div><span>Cost</span><strong>${wfMoney(booking.cost)}</strong></div>
      <div><span>Invoice</span><strong>${invoice ? `<button class="wf-link-button" type="button" onclick="window.open('${wfAttr(invoice.previewUrl)}','_blank')">${wfEscape(invoice.originalName)}</button>` : 'Not uploaded'}</strong></div>
    </div>
    <div class="wf-transport-footer"><label class="wf-link-button">${invoice ? 'Replace invoice' : 'Upload invoice'}
      <input type="file" accept=".pdf,application/pdf" hidden onchange="uploadTransportInvoice('${wfAttr(booking.id)}',this)"></label>
      <div><button class="wf-button" type="button" onclick="openTransportBooking('${wfAttr(booking.vendorId)}','${wfAttr(booking.id)}')">Edit</button>
        <button class="wf-button danger" type="button" onclick="deleteTransportBooking('${wfAttr(booking.id)}')">Remove</button></div></div>
  </article>`;
}

function wfTransportTripCard(booking, direction) {
  const isReturn = direction === 'return';
  const isLegacyReturn = isReturn && Boolean(booking.twoWay);
  const isFleet = booking.sourceType === 'fleet';
  const invoice = booking.invoice;
  const routeFrom = isLegacyReturn ? booking.locationTo : booking.locationFrom;
  const routeTo = isLegacyReturn ? booking.locationFrom : booking.locationTo;
  const tripDate = isLegacyReturn ? booking.returnDate : booking.departDate;
  const tripTime = isLegacyReturn ? booking.returnTime : booking.departTime;
  const directionLabel = isReturn ? 'Return' : 'Depart';
  const contact = wfFormatPhone(booking.driverContact || booking.contactNumber);
  return `<article class="wf-transport-card wf-trip-card ${isReturn ? 'return-trip' : 'depart-trip'} ${isFleet ? 'fleet-trip' : 'external-trip'}">
    <div class="wf-transport-heading">
      <div class="wf-vehicle-heading">
        <span class="wf-trip-direction">${directionLabel}</span>
        <h4>${wfEscape(booking.vehicleType || 'Transport')}${booking.vehicleNumber ? ` &middot; ${wfEscape(booking.vehicleNumber)}` : ''}</h4>
        <small>${wfRoomBadge(booking)}${isFleet ? '<span class="wf-fleet-badge">Own fleet</span>' : wfEscape(booking.company || '')}</small>
      </div>
      <div class="wf-driver-heading">
        <strong>${wfEscape(booking.driver || booking.companyDriver || 'Driver TBC')}</strong>
        <span>${wfEscape(contact || 'No contact')}</span>
      </div>
    </div>
    <div class="wf-transport-meta">
      <div class="wf-route"><span>Route</span><strong class="wf-route-path">${wfLocationBadge(routeFrom, 'From')}<span class="wf-route-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"></path></svg></span>${wfLocationBadge(routeTo, 'To')}</strong></div>
      <div class="wf-trip-datetime"><span>Date &amp; Time</span><strong>${wfEscape([tripDate, tripTime].filter(Boolean).join(' · ') || '—')}</strong></div>
      ${isFleet ? `<div><span>Vehicle use</span><strong>${wfEscape([
        [booking.departDate, booking.departTime].filter(Boolean).join(' '),
        [booking.useEndDate, booking.useEndTime].filter(Boolean).join(' ')
      ].filter(Boolean).join(' to '))}</strong></div>` : ''}
      <div><span>Cost per trip</span><strong>${wfMoney(booking.cost)}</strong></div>
      ${!isLegacyReturn && !isFleet ? `<div><span>Invoice</span><strong>${invoice
        ? `<button class="wf-link-button" type="button" onclick="window.open('${wfAttr(invoice.previewUrl)}','_blank')">${wfEscape(invoice.originalName)}</button>`
        : 'Not uploaded'}</strong></div>` : ''}
    </div>
    <div class="wf-transport-footer">
      ${!isLegacyReturn && !isFleet ? `<label class="wf-link-button">${invoice ? 'Replace invoice' : 'Upload invoice'}
        <input type="file" accept=".pdf,application/pdf" hidden onchange="uploadTransportInvoice('${wfAttr(booking.id)}',this)"></label>`
        : (isLegacyReturn
          ? '<span class="wf-return-booking-note">Return leg of the same booking</span>'
          : '<span></span>')}
      <div>
        <button class="wf-button" type="button" onclick="openTransportBooking('${wfAttr(booking.vendorId || '')}','${wfAttr(booking.id)}','${wfAttr(booking.sourceType || 'external')}')">Edit</button>
        ${!isLegacyReturn ? `<button class="wf-button danger" type="button" onclick="deleteTransportBooking('${wfAttr(booking.id)}')">Remove</button>` : ''}
      </div>
    </div>
  </article>`;
}

function wfFormatPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('65')) {
    return `+65 ${digits.slice(2, 6)} ${digits.slice(6)}`;
  }
  if (digits.length === 8) return `+65 ${digits.slice(0, 4)} ${digits.slice(4)}`;
  return String(value || '');
}

function wfLocationBadge(value, label) {
  const raw = String(value || '—').trim();
  const match = raw.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  const name = match ? match[1] : raw;
  const address = match ? match[2] : '';
  return `<span class="wf-location-badge"><span class="wf-location-heading"><small class="wf-location-direction">${label}</small><b>${wfEscape(name || '—')}</b></span>
    ${address ? `<em>${wfEscape(address)}</em>` : ''}</span>`;
}

function wfTransportCard(booking) {
  if (!booking.twoWay && (booking.sourceType || booking.tripType)) {
    return wfTransportTripCard(
      booking,
      booking.tripType === 'return' ? 'return' : 'depart'
    );
  }
  const cards = [wfTransportTripCard(booking, 'depart')];
  if (booking.twoWay) cards.push(wfTransportTripCard(booking, 'return'));
  return cards.join('');
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

function renderWorkforcePageLegacy() {
  const root = document.getElementById('workforce-page-root');
  const data = workforcePageState.data;
  if (!root || !data) return;
  const grouped = Object.fromEntries((data.departments || []).map(row => [row.code, []]));
  data.assignments.forEach(row => (grouped[row.department || 'Unassigned'] ||= []).push(row));
  const departments = Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b))
    .map(([department, rows], index) => wfDepartmentHtml(department, rows, index)).join('');
  const totals = data.totals || {};
  const grand = Number(totals.combined || 0) + Number(totals.transport || 0);
  root.innerHTML = `<header class="wf-page-header"><div>
      <button class="wf-back" type="button" onclick="showSection('events')">&larr; Back to All Events</button>
      <h2>Manpower &amp; Transport</h2><p>Assign crew, review submissions and arrange transport.</p>
    </div><button class="wf-button" type="button" onclick="editEvent(${data.event.id})">Edit Event</button></header>
    <section class="wf-event-dashboard">
      <button type="button" class="plan-event-select-wrap wf-event-picker" onclick="openWorkforceEventChooser()">
        <div class="plan-event-icon">${planMetricIconSvg('calendar')}</div>
        <div class="wf-event-picker-copy"><div class="plan-event-title-row"><span class="plan-event-id">#${data.event.id}</span>
          <span class="plan-event-name">${wfEscape(data.event.name)}</span></div>
          <div class="plan-event-meta"><span>${wfEscape([data.event.startDate, data.event.endDate].filter(Boolean).join(' – '))}</span>
            ${data.event.location ? `<span>&bull;</span><span>${wfEscape(data.event.location)}</span>` : ''}
            ${planEventTypeBadgeHtml(data.event)} ${planEventStateBadgeHtml(data.event)}</div></div>
        <span class="plan-event-picker-chevron">&#8964;</span>
      </button>
      <div class="wf-header-totals">
        <div><span>Invoices</span><strong>${wfMoney(totals.invoice)}</strong></div>
        <div><span>Claims</span><strong>${wfMoney(totals.claims)}</strong></div>
        <div><span>Transport</span><strong>${wfMoney(totals.transport)}</strong></div>
        <div><span>Combined</span><strong>${wfMoney(grand)}</strong></div>
      </div>
    </section>
    <section class="wf-event-summary"><div class="wf-summary-cell"><span>Start date</span><strong>${wfEscape(data.event.startDate)}</strong></div>
      <div class="wf-summary-cell"><span>End date</span><strong>${wfEscape(data.event.endDate)}</strong></div>
      <div class="wf-summary-cell location"><span>Location</span><strong>${wfEscape(data.event.location || '—')}</strong></div>
      <div class="wf-summary-cell"><span>Status</span><strong>${wfEscape(data.event.state)}</strong></div></section>
    <section class="wf-panel wf-transport-panel"><header class="wf-panel-header"><div><h3>Transport Details</h3>
      <p>Vehicles booked for this event.</p></div>
      <div class="wf-toolbar"><button class="wf-button" type="button" onclick="openTransportDirectory()">Manage transport</button>
        <button class="wf-button primary" type="button" onclick="openTransportBooking()">Book transport</button></div></header>
      <div class="wf-transport-list">${data.transportBookings.length ? data.transportBookings.map(wfTransportCard).join('') : '<div class="wf-empty">No transport booked for this event.</div>'}</div></section>
    <section class="wf-panel"><header class="wf-panel-header"><div><h3>Manpower / Workers &amp; Vendors</h3>
      <p>Departments are created automatically from this event’s outgoing assets.</p></div>
      <div class="wf-toolbar"><a class="wf-button" href="/api/events/${data.event.id}/workforce/download/invoices">Download invoices (.zip)</a>
        <a class="wf-button" href="/api/events/${data.event.id}/workforce/download/claims">Download claims (.zip)</a>
        <button class="wf-button" type="button" onclick="openManualDepartment()">+ Department</button>
        <button class="wf-button primary" type="button" onclick="openFreelancerDirectory('manage')">Manage Worker/Vendor</button></div></header>
      <div>${departments || '<div class="wf-empty">No asset departments detected. Add one manually to begin.</div>'}</div>
    </section>`;
}

function renderWorkforcePage() {
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
  const activeSubprojectId = String(workforcePageState.activeSubprojectId);
  const visibleAssignments = activeSubprojectId === 'all'
    ? data.assignments
    : data.assignments.filter(row =>
      wfEffectiveSubprojectId(row) === activeSubprojectId
    );
  const visibleBookings = activeSubprojectId === 'all'
    ? data.transportBookings
    : data.transportBookings.filter(row =>
      wfEffectiveSubprojectId(row) === activeSubprojectId
    );
  const grouped = Object.fromEntries(
    (data.departments || []).map(row => [row.code, []])
  );
  visibleAssignments.forEach(row => {
    (grouped[row.department || 'Unassigned'] ||= []).push(row);
  });
  const departments = Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([department, rows]) =>
      wfDepartmentHtml(department, rows)
    ).join('');
  const totals = data.totals || {};
  const grand = Number(totals.combined || 0) + Number(totals.transport || 0);
  const eventDates = data.event.startDate === data.event.endDate
    ? data.event.startDate
    : [data.event.startDate, data.event.endDate].filter(Boolean).join(' – ');

  root.innerHTML = `
    <div class="plan-page-heading wf-manpower-page-heading">
      <div><div class="wf-manpower-title-row"><h2>Manpower &amp; Transport</h2>
        <button class="wf-button primary" type="button" onclick="showSection('invoice-claims')">
          View all invoice &amp; claims
        </button></div>
      <p>Assign crew, review submissions and arrange transport.</p></div>
    </div>

    <div class="wf-plan-layout">
      <div class="wf-plan-primary">
        <div class="plan-event-bar">
          <button type="button" class="plan-event-select-wrap"
                  aria-haspopup="dialog"
                  aria-label="Choose an event for manpower and transport"
                  onclick="openWorkforceEventChooser()">
            <div class="plan-event-icon" aria-hidden="true">${planMetricIconSvg('calendar')}</div>
            <div style="min-width:0;flex:1;">
              <div class="plan-event-title-row">
                <span class="plan-event-id">#${wfEscape(String(data.event.id || ''))}</span>
                <span class="plan-event-name">${wfEscape(planEventOptionLabel(data.event))}</span>
              </div>
              <div class="plan-event-meta">
                <span>${wfEscape(eventDates || '—')}</span>
                ${data.event.location ? `<span aria-hidden="true">&bull;</span><span>${wfEscape(data.event.location)}</span>` : ''}
                ${planEventTypeBadgeHtml(data.event)}
                ${planEventStateBadgeHtml(data.event)}
              </div>
            </div>
            <span class="plan-event-picker-chevron" aria-hidden="true">&#8964;</span>
          </button>

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
              <div class="plan-metric-icon wf-metric-transport">${wfMetricIconSvg('transport')}</div>
              <div><strong>${wfMoney(totals.transport)}</strong><span>Transport</span></div>
            </div>
            <div class="plan-metric">
              <div class="plan-metric-icon wf-metric-combined">${wfMetricIconSvg('combined')}</div>
              <div><strong>${wfMoney(grand)}</strong><span>Combined</span></div>
            </div>
          </div>
        </div>

        ${wfSubprojectTabsHtml()}

        <section class="wf-panel wf-manpower-panel">
          <header class="wf-panel-header">
            <div>
              <h3>Manpower / Workers &amp; Vendors</h3>
              <p>Departments are created automatically from this event’s outgoing assets.</p>
            </div>
            <div class="wf-toolbar">
              <a class="wf-button" href="/api/events/${data.event.id}/workforce/download/invoices">Download invoices (.zip)</a>
              <a class="wf-button" href="/api/events/${data.event.id}/workforce/download/claims">Download claims (.zip)</a>
              <button class="wf-button" type="button" onclick="openManualDepartment()">+ Department</button>
              <button class="wf-button primary" type="button" onclick="openFreelancerDirectory('manage')">Manage Worker/Vendor</button>
            </div>
          </header>
          <div>${departments || '<div class="wf-empty">No asset departments detected. Add one manually to begin.</div>'}</div>
        </section>
      </div>

      <aside class="plan-aside wf-plan-aside">
        <section class="plan-card wf-transport-panel">
          <header class="wf-panel-header">
            <div><h3>Transport Details</h3><p>Vehicles booked for this event.</p></div>
            <div class="wf-toolbar"><button class="wf-button" type="button" onclick="openTransportDirectory()">Manage transport</button>
              <button class="wf-button primary" type="button" onclick="openTransportBooking()">Book transport</button></div>
          </header>
          <div class="wf-transport-list">
            ${visibleBookings.length
              ? visibleBookings.map(wfTransportCard).join('')
              : `<div class="wf-empty">No transport booked${activeSubprojectId === 'all' ? ' for this event' : ' for this room'}.</div>`}
          </div>
        </section>
      </aside>
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
    wfModal('wfVendorDirectoryModal', 'Add Vendor', `<div class="wf-modal-body">
      <div class="wf-directory-toolbar"><input class="wf-search" id="wfVendorSearch" type="search"
        placeholder="Search vendors" oninput="renderVendorDirectory(this.value)">
        <button class="wf-button primary" type="button" onclick="openVendorProfile()">Enroll New Vendor</button></div>
      <div class="wf-directory-list wf-directory-grid" id="wfVendorDirectoryList"></div>
    </div>`, '', true) +
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
        <label class="wf-field wf-room-field full"><span>Room / Sub-project *</span><select id="wfAssignmentSubproject"></select></label>
        <label class="wf-field"><span>Department *</span><select id="wfAssignmentDepartment" required></select></label>
        <label class="wf-field"><span>Role / Position</span><input id="wfAssignmentRole" maxlength="100"></label>
        <div class="wf-field full"><span>Working dates *</span><div class="wf-date-calendar" id="wfAssignmentDates"></div></div>
        <label class="wf-field"><span>Daily rate ($)</span><input id="wfAssignmentRate" type="number" min="0" step=".01"></label>
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
        <label class="wf-field wf-room-field full"><span>Room / Sub-project *</span><select id="wfVendorAssignmentSubproject"></select></label>
        <label class="wf-field"><span>Department *</span><select id="wfVendorAssignmentDepartment" required></select></label>
        <div class="wf-field"><span>Providing *</span><div class="wf-provider-choice">
          <label><input type="radio" name="wfProviderType" value="manpower" checked onchange="syncVendorAssignmentFields()"> Manpower</label>
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
      <label class="wf-field full"><span>Configured department</span><select id="wfDepartmentPreset" onchange="syncDepartmentPreset()"></select></label>
      <label class="wf-field"><span>Department code *</span><input id="wfDepartmentCode" maxlength="12" required></label>
      <label class="wf-field"><span>Department name</span><input id="wfDepartmentName" maxlength="80"></label>
      </div><div class="wf-error" id="wfDepartmentError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfDepartmentModal')">Cancel</button>
      <button class="wf-button primary" type="submit">Add Department</button></footer></form>`) +
    wfModal('wfTransportDirectoryModal', 'Manage Transport', `<div class="wf-modal-body">
      <div class="wf-directory-toolbar"><input class="wf-search" id="wfTransportSearch" type="search" placeholder="Search vehicle or company" oninput="renderTransportDirectory(this.value)">
        <div><button class="wf-button" type="button" onclick="openLocationsManager()">Manage Locations</button>
          <button class="wf-button fleet" type="button" onclick="manageOwnVehicles()">Manage own vehicles</button>
          <button class="wf-button primary" type="button" onclick="openTransportProfile()">Add new transport</button></div></div>
      <div class="wf-directory-list wf-directory-grid" id="wfTransportDirectoryList"></div></div>`, '', true) +
    wfModal('wfTransportProfileModal', 'Add New Transport', `<form id="wfTransportProfileForm"><div class="wf-modal-body">
      <div class="wf-form-grid"><label class="wf-field"><span>Vehicle type *</span><input id="wfProfileVehicleType" required></label>
        <label class="wf-field"><span>Company</span><input id="wfProfileCompany"></label>
        <label class="wf-field"><span>Contact number</span><input id="wfProfileContact" type="tel"></label>
        <label class="wf-field full"><span>Vehicle / Lorry number</span><input id="wfProfileVehicleNumber"></label>
      </div><div class="wf-error" id="wfTransportProfileError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfTransportProfileModal')">Cancel</button>
        <button class="wf-button primary" type="submit">Save Transport</button></footer></form>`) +
    wfModal('wfLocationsModal', 'Manage Locations', `<div class="wf-modal-body">
      <form class="wf-inline-form" id="wfLocationForm"><input class="wf-search" id="wfLocationName" placeholder="Venue name" required>
        <input class="wf-search" id="wfLocationAddress" placeholder="Exact address (optional)">
        <button class="wf-button primary" type="submit">Add Location</button></form>
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
          <label class="wf-field"><span>Driver</span><input id="wfTransportDriver" placeholder="Driver name"></label>
          <label class="wf-field"><span>Driver phone</span><input id="wfTransportDriverContact" type="tel" placeholder="+65 9123 4567"></label>
        </div>
        <label class="wf-field"><span>Trip Date *</span><input id="wfDepartDate" type="date" required oninput="syncTransportUsageDate()"></label>
        <label class="wf-field"><span>Depart Time *</span><input id="wfDepartTime" type="time" required oninput="scheduleTransportAvailability()"></label>
        <div class="wf-return-fields wf-fleet-window full" id="wfFleetUsageFields">
          <label class="wf-field"><span>Vehicle Return Date</span><input id="wfVehicleUseEndDate" type="date" oninput="scheduleTransportAvailability()"></label>
          <label class="wf-field"><span>Vehicle Return Time</span><input id="wfVehicleUseEndTime" type="time" oninput="scheduleTransportAvailability()"></label>
          <small>Return time is required for company vehicles. The return date defaults to the trip date.</small>
        </div>
        <label class="wf-field"><span>Location From *</span><input id="wfLocationFrom" list="wfSavedLocations" required></label>
        <label class="wf-field"><span>Location To *</span><input id="wfLocationTo" list="wfSavedLocations" required></label>
        <datalist id="wfSavedLocations"></datalist>
        <label class="wf-check full"><input id="wfSaveBookingLocations" type="checkbox" checked> Save these locations for future bookings</label>
        <label class="wf-field full"><span>Cost (per trip, $)</span><input id="wfTransportCost" type="number" min="0" step=".01" value="0"></label>
      </div>
      <section class="wf-booking-vehicle-section">
        <div class="wf-booking-vehicle-heading"><div><h4>Choose one or more vehicles</h4><p>Selected vehicles will share the trip details above.</p></div>
          <button class="wf-button" type="button" onclick="openTransportProfileForBooking()">+ Add transport</button></div>
        <div class="wf-booking-selection-summary" id="wfBookingSelectionSummary">No vehicles selected</div>
        <input id="wfBookingVendor" type="hidden">
        <input id="wfBookingFleetVehicle" type="hidden">
        <div class="wf-booking-source-group"><div class="wf-booking-source-title"><strong>Own fleet</strong>
          <button class="wf-link-button" type="button" onclick="manageOwnVehicles()">Manage own vehicles</button></div>
          <div id="wfFleetVehicleChoices" class="wf-booking-vehicle-grid"></div></div>
        <div class="wf-booking-source-group"><div class="wf-booking-source-title"><strong>Known external vehicles</strong></div>
          <div id="wfExternalVehicleChoices" class="wf-booking-vehicle-grid"></div></div>
        <section class="wf-booking-drivers" id="wfBookingDrivers" hidden></section>
      </section>
      <div class="wf-error" id="wfTransportBookingError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfTransportBookingModal')">Cancel</button>
        <button class="wf-button primary" id="wfTransportBookingSubmit" type="submit">Add to Event</button></footer></form>`) +
    wfModal('wfAdminUploadModal', 'Upload for Crew', `<form id="wfAdminUploadForm">
      <input id="wfAdminUploadFreelancerId" type="hidden"><input id="wfAdminUploadKind" name="kind" type="hidden">
      <div class="wf-modal-body"><p class="wf-form-intro" id="wfAdminUploadSubtitle"></p>
        <div id="wfAdminInvoiceFields"><p class="wf-help">Invoice amount will be read from the PDF and verified during review.</p></div>
        <div id="wfAdminClaimFields" hidden><p class="wf-help">Claim amount and date will be analysed after upload. Verify them during review.</p></div>
        <label class="wf-field wf-admin-dropzone" id="wfAdminUploadDropzone"><span id="wfAdminUploadFileLabel">Invoice PDF *</span><input id="wfAdminUploadFile" name="files" type="file" required><strong id="wfAdminUploadDropPrompt">Drag &amp; drop or choose a file</strong><small id="wfAdminUploadSelectedFiles">No file selected</small></label>
        <div class="wf-admin-upload-progress" id="wfAdminUploadProgress" hidden><strong>Uploading</strong>
          <span><i id="wfAdminUploadProgressBar"></i></span><small id="wfAdminUploadProgressLabel">0%</small></div>
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
  label.textContent = files.length
    ? files.map(file => file.name).join(', ')
    : 'No file selected';
}

function openWorkforceModal(id) {
  ensureWorkforceModals();
  const modal = document.getElementById(id);
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
    id === 'wfAssignmentModal' &&
    workforcePageState.freelancerWorkspaceReturnId
  );
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
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
  ensureWorkforceEventChooserModal();
  workforceEventChooserState.search = '';
  workforceEventChooserState.filter = 'ALL';
  workforceEventChooserState.page = 1;
  const search = document.getElementById('workforceEventChooserSearch');
  if (search) search.value = '';
  renderWorkforceEventChooser();
  openModal('workforceEventChooserModal');
  refreshWorkforceEventChooserOptions();
}

async function refreshWorkforceEventChooserOptions() {
  const requestId = ++workforceEventChooserState.requestId;
  try {
    const eventOptionsLoad = await startProgressiveEventOptions(
      workforcePageState.eventId,
      loaded => {
        if (requestId !== workforceEventChooserState.requestId) return;
        workforcePageState.eventOptions = loaded.slice().sort(planCompareEventsByStartDate);
        renderWorkforceEventChooser();
      }
    );
    if (requestId !== workforceEventChooserState.requestId) return;
    workforcePageState.eventOptions = eventOptionsLoad.first
      .slice()
      .sort(planCompareEventsByStartDate);
    renderWorkforceEventChooser();
    const loaded = await eventOptionsLoad.completion;
    if (requestId !== workforceEventChooserState.requestId) return;
    workforcePageState.eventOptions = loaded.slice().sort(planCompareEventsByStartDate);
    renderWorkforceEventChooser();
  } catch (error) {
    console.warn('Unable to refresh event options:', error);
  }
}

function workforceEventChooserFilteredEvents() {
  const search = String(workforceEventChooserState.search || '').trim().toLowerCase();
  const filter = workforceEventChooserState.filter || 'ALL';
  return (workforcePageState.eventOptions || [])
    .filter(event => (
      (
        filter === 'ALL' ||
        (filter === 'ACTIVE' && !['closed', 'completed'].includes(planStateSlug(event?.state))) ||
        planEventChooserFilterKey(event) === filter
      ) &&
      (!search || planEventChooserSearchText(event).includes(search))
    ))
    .sort(planCompareEventsByStartDate);
}

function ensureWorkforceEventChooserModal() {
  let modal = document.getElementById('workforceEventChooserModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'workforceEventChooserModal';
  modal.className = 'modal';
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3 class="modal-title">Other Events <span title="Select an event to manage its manpower and transport">&#9432;</span></h3>
        <button type="button" class="close-btn" aria-label="Close event picker"
                onclick="closeModal('workforceEventChooserModal')">&times;</button>
      </div>
      <div class="plan-event-chooser-search">
        <span aria-hidden="true">&#128269;</span>
        <input type="search" id="workforceEventChooserSearch"
               placeholder="Search events by name, ID, client, or location..."
               oninput="workforceEventChooserSearchChanged(this.value)">
      </div>
      <div class="plan-event-chooser-filters" id="workforceEventChooserFilters"></div>
      <div class="plan-event-chooser-table">
        <div class="plan-event-chooser-head">
          <span>Event</span>
          <span>Dates</span>
          <span>Location</span>
          <span>Status</span>
          <span></span>
        </div>
        <div class="plan-event-chooser-results" id="workforceEventChooserResults"></div>
      </div>
      <div class="plan-event-chooser-footer" id="workforceEventChooserFooter"></div>
    </div>
  `;
  modal.addEventListener('click', event => {
    if (event.target === modal) closeModal('workforceEventChooserModal');
  });
  document.body.appendChild(modal);
  return modal;
}

function renderWorkforceEventChooser() {
  const filters = document.getElementById('workforceEventChooserFilters');
  const results = document.getElementById('workforceEventChooserResults');
  const footer = document.getElementById('workforceEventChooserFooter');
  if (!filters || !results || !footer) return;

  const counts = (workforcePageState.eventOptions || []).reduce((summary, event) => {
    const key = planEventChooserFilterKey(event);
    summary.ALL += 1;
    if (!['closed', 'completed'].includes(planStateSlug(event?.state))) {
      summary.ACTIVE += 1;
    }
    summary[key] = (summary[key] || 0) + 1;
    return summary;
  }, { ALL: 0, ACTIVE: 0 });

  filters.innerHTML = PLAN_EVENT_CHOOSER_FILTERS.map(filter => `
    <button type="button"
            class="plan-event-chooser-filter plan-event-chooser-filter-${filter.key.toLowerCase()} ${workforceEventChooserState.filter === filter.key ? 'active' : ''}"
            onclick="workforceSetEventChooserFilter('${filter.key}')">
      ${wfEscape(filter.label)}
      <span class="plan-event-chooser-count">${Number(counts[filter.key] || 0)}</span>
    </button>
  `).join('');

  const events = workforceEventChooserFilteredEvents();
  const pageCount = Math.max(1, Math.ceil(events.length / workforceEventChooserState.pageSize));
  workforceEventChooserState.page = Math.min(
    Math.max(1, workforceEventChooserState.page),
    pageCount
  );
  const start = (workforceEventChooserState.page - 1) * workforceEventChooserState.pageSize;
  const visibleEvents = events.slice(start, start + workforceEventChooserState.pageSize);

  results.innerHTML = visibleEvents.length ? visibleEvents.map(event => `
    <button type="button"
            class="plan-event-option ${Number(event.id) === Number(workforcePageState.eventId) ? 'current' : ''}"
            onclick="workforceChooseEvent(${Number(event.id)})">
      <span class="plan-event-option-name">
        <span class="plan-event-option-title-line">
          <strong>#${wfEscape(String(event.id || ''))} &nbsp; ${wfEscape(planEventOptionLabel(event))}</strong>
          ${planEventTypeBadgeHtml(event)}
        </span>
        <span>${wfEscape(planEventChooserSecondaryLabel(event))}</span>
      </span>
      <span class="plan-event-option-dates">
        ${wfEscape(planEventChooserDateRange(event))}
        <span>${wfEscape(planEventChooserRelativeDate(event))}</span>
      </span>
      <span class="plan-event-option-location">${wfEscape(event.location || event.venue || '—')}</span>
      ${planEventStateBadgeHtml(event)}
      <span class="plan-event-option-arrow" aria-hidden="true">&rsaquo;</span>
    </button>
  `).join('') : '<div class="plan-empty">No events match this search.</div>';

  const firstShown = events.length ? start + 1 : 0;
  const lastShown = Math.min(start + visibleEvents.length, events.length);
  const visiblePages = [];
  for (let page = 1; page <= pageCount; page += 1) {
    if (
      pageCount <= 7 ||
      page === 1 ||
      page === pageCount ||
      Math.abs(page - workforceEventChooserState.page) <= 1
    ) {
      visiblePages.push(page);
    }
  }
  const pageControls = [];
  let previousPage = 0;
  visiblePages.forEach(page => {
    if (previousPage && page - previousPage > 1) {
      pageControls.push('<span aria-hidden="true">&hellip;</span>');
    }
    pageControls.push(`
      <button type="button"
              class="plan-event-chooser-page ${page === workforceEventChooserState.page ? 'active' : ''}"
              onclick="workforceSetEventChooserPage(${page})">${page}</button>
    `);
    previousPage = page;
  });

  footer.innerHTML = `
    <span>Showing ${firstShown} to ${lastShown} of ${events.length} events</span>
    <div class="plan-event-chooser-pages">
      <button type="button" class="plan-event-chooser-page"
              ${workforceEventChooserState.page <= 1 ? 'disabled' : ''}
              onclick="workforceSetEventChooserPage(${workforceEventChooserState.page - 1})"
              aria-label="Previous page">&lsaquo;</button>
      ${pageControls.join('')}
      <button type="button" class="plan-event-chooser-page"
              ${workforceEventChooserState.page >= pageCount ? 'disabled' : ''}
              onclick="workforceSetEventChooserPage(${workforceEventChooserState.page + 1})"
              aria-label="Next page">&rsaquo;</button>
    </div>
  `;
}

function workforceEventChooserSearchChanged(value) {
  workforceEventChooserState.search = value;
  workforceEventChooserState.page = 1;
  renderWorkforceEventChooser();
}

function workforceSetEventChooserFilter(filter) {
  workforceEventChooserState.filter = filter || 'ALL';
  workforceEventChooserState.page = 1;
  renderWorkforceEventChooser();
}

function workforceSetEventChooserPage(page) {
  workforceEventChooserState.page = Math.max(1, Number(page || 1));
  renderWorkforceEventChooser();
}

async function workforceChooseEvent(eventId) {
  closeModal('workforceEventChooserModal');
  if (Number(eventId) === Number(workforcePageState.eventId)) return;
  await changeWorkforceEvent(eventId);
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
    mode === 'assign' ? `Add Worker to ${department}` : 'Manage Worker/Vendor';
  document.getElementById('wfFreelancerSearch').value = '';
  renderFreelancerDirectory('');
  openWorkforceModal('wfFreelancerDirectoryModal');
}

function renderFreelancerDirectory(search) {
  const query = String(search || '').toLowerCase();
  const workers = wfDirectoryFreelancers().filter(row =>
    !row.personnelOnly &&
    `${row.name} ${row.phone || ''} ${row.email || ''} ${row.company || ''}`.toLowerCase().includes(query));
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
    if (type === 'vendor') {
      const lastLogin = row.workerLastLoginAt
        ? `Last login: ${wfEscape(wfDateTime(row.workerLastLoginAt))} by ${wfEscape(row.workerLastLoginBy || 'Unknown member')}`
        : 'Last login: Never';
      return `<article class="wf-directory-row wf-directory-card wf-vendor-directory-card"
        onclick="openFreelancerHistory('${wfAttr(row.id)}')">
        <span class="wf-avatar vendor">${wfEscape(wfInitials(row.name))}</span>
        <span><strong>${wfEscape(row.name)}</strong>
          <small>${Number(row.members?.length || 0)} member${Number(row.members?.length || 0) === 1 ? '' : 's'} with portal access</small>
          <span class="wf-worker-summary">
            ${wfDirectorySummaryBadges(summary)}
          </span>
        </span>
        <button class="wf-mini-button" type="button"
          onclick="event.stopPropagation();openVendorProfile('${wfAttr(row.id)}')">Edit</button>
        <small class="wf-last-login">${lastLogin}</small>
      </article>`;
    }
    const loginBadge = workforcePageState.directoryMode === 'manage'
      ? `<span class="wf-login-indicator ${row.workerLoginConfigured ? 'configured' : ''}">
          ${row.workerLoginConfigured ? 'Login set' : 'Setup required'}
        </span>`
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

function openVendorDirectory(department) {
  ensureWorkforceModals();
  workforcePageState.directoryDepartment = department;
  document.getElementById('wfVendorDirectoryModalTitle').textContent =
    `Add Vendor to ${department}`;
  document.getElementById('wfVendorSearch').value = '';
  renderVendorDirectory('');
  openWorkforceModal('wfVendorDirectoryModal');
}

function renderVendorDirectory(search = '') {
  const query = String(search || '').trim().toLowerCase();
  const rows = (workforcePageState.data?.vendors || []).filter(row =>
    `${row.name} ${(row.members || []).map(member => member.name).join(' ')}`
      .toLowerCase().includes(query)
  );
  document.getElementById('wfVendorDirectoryList').innerHTML = rows.map(row =>
    `<button class="wf-directory-row wf-directory-card" type="button"
      onclick="openVendorAssignment('${wfAttr(row.id)}','${wfAttr(workforcePageState.directoryDepartment)}')">
      <span class="wf-avatar vendor">${wfEscape(wfInitials(row.name))}</span>
      <span><strong>${wfEscape(row.name)}</strong>
        <small>${Number(row.members?.length || 0)} portal member${Number(row.members?.length || 0) === 1 ? '' : 's'}</small></span>
      <span class="wf-directory-action">Select &rsaquo;</span>
    </button>`
  ).join('') || '<div class="wf-empty">No matching vendors.</div>';
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
    if (document.getElementById('wfVendorDirectoryModal')?.classList.contains('open')) {
      renderVendorDirectory(document.getElementById('wfVendorSearch').value);
    }
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
    closeWorkforceModal('wfVendorDirectoryModal');
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
  if (statuses.includes('Processing')) return 'Processing';
  if (statuses.includes('Details Required')) return 'Details Required';
  if (statuses.every(status => status === 'Payment Confirmed')) return 'Payment Confirmed';
  if (statuses.includes('Pending Review')) return 'Pending Review';
  if (statuses.includes('Denied')) return 'Denied';
  if (statuses.includes('Approved')) return 'Approved';
  if (statuses.includes('Paid')) return 'Paid';
  return statuses[0];
}

function wfHistoryStatusControl(event, freelancerId, record) {
  const status = wfHistoryDisplayStatus(record);
  if (['Processing', 'Details Required'].includes(status) || !record.verifiedAt) {
    return `<button type="button" class="wf-status-button ${wfStatusClass(status)}"
      onclick="openFreelancerHistorySubmission(${Number(event.id)},'${wfAttr(freelancerId)}','${wfAttr(record.id)}')">
      ${wfEscape(status)}
    </button>`;
  }
  return `<div class="wf-status-control">
    <button type="button" class="wf-status-button ${wfStatusClass(status)}"
      onclick="toggleWorkforceStatusMenu(event,'history-${wfAttr(record.id)}')">
      ${wfEscape(status)} <span>&#9662;</span>
    </button>
    <div class="wf-status-menu" id="wfStatusMenu-history-${wfAttr(record.id)}">
      ${['Pending Review', 'Approved', 'Denied', 'Paid', 'Payment Confirmed'].map(nextStatus =>
        `<button class="${wfStatusClass(nextStatus)}" type="button"
          onclick="chooseFreelancerHistoryStatus(event,${Number(event.id)},'${wfAttr(freelancerId)}','${wfAttr(record.id)}','${nextStatus}')">${nextStatus}</button>`
      ).join('')}
    </div>
  </div>`;
}

function wfHistorySubmissionRows(event, freelancerId, rows, kind) {
  if (!rows.length) return `<div class="wf-history-empty">No ${kind} submitted.</div>`;
  return rows.map(record => {
    return `<div class="wf-history-file">
      <button type="button" class="wf-history-file-name"
        onclick="openFreelancerHistorySubmission(${Number(event.id)},'${wfAttr(freelancerId)}','${wfAttr(record.id)}')">
        ${wfEscape(record.originalName || `${kind} upload`)}
      </button>
      <span>${record.amount == null ? 'Amount to verify' : wfMoney(record.amount)}</span>
      ${wfHistoryStatusControl(event, freelancerId, record)}
      <button type="button" class="wf-icon-button danger" title="Delete upload"
        onclick="deleteFreelancerHistorySubmission('${wfAttr(record.id)}','${wfAttr(freelancerId)}')">&times;</button>
    </div>`;
  }).join('');
}

function wfHistoryRoleRows(event, freelancerId, subjectType = 'worker') {
  const rows = event.roles || [];
  const roleRows = rows.map(row => `<span class="wf-worker-role-row">
    <span class="wf-department-role" style="${wfDepartmentStyle(row.department)}">
      ${wfEscape(row.department || 'General')}
    </span>
    <span>${wfEscape(row.role || 'Worker')} · ${Number(row.days || 0)} day${Number(row.days || 0) === 1 ? '' : 's'}</span>
    <button type="button" title="Edit role"
      onclick="event.preventDefault();event.stopPropagation();openFreelancerWorkspaceAssignment(${Number(event.id)},'${wfAttr(freelancerId)}','${wfAttr(row.id)}','${wfAttr(subjectType)}')">Edit</button>
    <button type="button" class="danger" title="Remove role"
      onclick="event.preventDefault();event.stopPropagation();removeFreelancerWorkspaceAssignment(${Number(event.id)},'${wfAttr(freelancerId)}','${wfAttr(row.id)}')">&times;</button>
  </span>`).join('');
  return `${roleRows}<button class="wf-add-worker-role" type="button"
    onclick="event.preventDefault();event.stopPropagation();openFreelancerWorkspaceAssignment(${Number(event.id)},'${wfAttr(freelancerId)}','','${wfAttr(subjectType)}')">+ Add assignment</button>`;
}

function wfHistoryEventCard(event, freelancerId, subjectType = 'worker') {
  const invoiceStatus = wfHistorySubmissionSummary(event.invoices || []);
  const claimStatus = wfHistorySubmissionSummary(event.claims || []);
  const dates = event.startDate === event.endDate
    ? event.startDate
    : `${event.startDate} – ${event.endDate}`;
  return `<details class="wf-history-event">
    <summary>
      <div class="wf-history-event-name"><strong>#${Number(event.id)} ${wfEscape(event.name)}</strong><span>${wfEscape(event.location || 'Location TBC')}</span></div>
      <div class="wf-history-event-date"><strong>${wfEscape(dates)}</strong><span class="wf-worker-role-list">${wfHistoryRoleRows(event, freelancerId, subjectType)}</span></div>
      <div><span>Invoice</span><strong>${event.invoices.length}/${event.invoiceLimit}</strong>
        <em class="wf-status-button ${wfStatusClass(invoiceStatus)}">${wfEscape(invoiceStatus)}</em></div>
      <div><span>Claims</span><strong>${event.claims.length}/${event.claimLimit}</strong>
        <em class="wf-status-button ${wfStatusClass(claimStatus)}">${wfEscape(claimStatus)}</em></div>
      <div class="wf-history-event-total"><span>Total</span><strong>${wfMoney(Number(event.invoiceTotal || 0) + Number(event.claimTotal || 0))}</strong></div>
      <b class="wf-history-chevron">⌄</b>
    </summary>
    <div class="wf-history-submissions">
      <section><header><strong>Invoices</strong>
        <span class="wf-history-actions">
          <button class="wf-mini-button" type="button" ${event.invoiceSlotsRemaining <= 0 ? 'disabled' : ''}
            onclick="openFreelancerHistoryUpload(${Number(event.id)},'${wfAttr(freelancerId)}','invoice')">Upload</button>
          <button class="wf-mini-button subtle" type="button"
            onclick="changeFreelancerHistoryUploadSlots(${Number(event.id)},'${wfAttr(freelancerId)}','invoice',1)">+ Slot</button>
          <button class="wf-mini-button subtle" type="button" ${Number(event.extraInvoices || 0) <= 0 ? 'disabled' : ''}
            onclick="changeFreelancerHistoryUploadSlots(${Number(event.id)},'${wfAttr(freelancerId)}','invoice',-1)">&minus; Slot</button>
        </span></header>
        ${wfHistorySubmissionRows(event, freelancerId, event.invoices || [], 'invoice')}
      </section>
      <section><header><strong>Claims</strong>
        <span class="wf-history-actions">
          <button class="wf-mini-button" type="button" ${event.claimSlotsRemaining <= 0 ? 'disabled' : ''}
            onclick="openFreelancerHistoryUpload(${Number(event.id)},'${wfAttr(freelancerId)}','claim')">Upload</button>
          <button class="wf-mini-button subtle" type="button"
            onclick="changeFreelancerHistoryUploadSlots(${Number(event.id)},'${wfAttr(freelancerId)}','claim',1)">+ Slot</button>
          <button class="wf-mini-button subtle" type="button" ${Number(event.extraClaims || 0) <= 0 ? 'disabled' : ''}
            onclick="changeFreelancerHistoryUploadSlots(${Number(event.id)},'${wfAttr(freelancerId)}','claim',-1)">&minus; Slot</button>
        </span></header>
        ${wfHistorySubmissionRows(event, freelancerId, event.claims || [], 'claim')}
      </section>
    </div>
  </details>`;
}

async function openFreelancerHistory(id) {
  workforcePageState.historyFreelancerId = id;
  workforcePageState.freelancerWorkspaceData = null;
  closeWorkforceModal('wfFreelancerDirectoryModal');
  closeWorkforceModal('wfVendorDirectoryModal');
  showSection('freelancer-workspace');
}

async function loadFreelancerWorkspace() {
  const root = document.getElementById('freelancer-workspace-root');
  if (!root) return;
  const id = workforcePageState.historyFreelancerId;
  if (!id) {
    root.innerHTML = `<div class="plan-page-heading"><h2>Worker Submissions</h2>
      <p>Select a worker from Manpower &amp; Transport to view their events.</p></div>
      <button class="wf-button" type="button" onclick="showSection('workforce')">&larr; Back to Manpower &amp; Transport</button>`;
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

function renderFreelancerWorkspace() {
  const root = document.getElementById('freelancer-workspace-root');
  const data = workforcePageState.freelancerWorkspaceData;
  if (!root || !data) return;
  const { company, events } = data;
  const freelancer = data.subject || data.freelancer;
  const subjectType = data.subjectType || freelancer.subjectType || 'worker';
  const isVendor = subjectType === 'vendor';
  const invoiceCount = events.reduce((total, item) => total + item.invoices.length, 0);
  const claimCount = events.reduce((total, item) => total + item.claims.length, 0);
  root.innerHTML = `<div class="plan-page-heading wf-freelancer-page-heading">
      <div><button class="wf-back" type="button" onclick="showSection('workforce')">&larr; Back to Manpower &amp; Transport</button>
        <h2>${isVendor ? 'Vendor' : 'Worker'} Submissions</h2>
        <p>Review assignments, invoices and claims for ${wfEscape(company?.name || 'this company')}.</p></div>
      <button class="wf-button" type="button" onclick="${isVendor ? 'openVendorProfile' : 'openFreelancerProfile'}('${wfAttr(freelancer.id)}')">Edit ${isVendor ? 'Vendor' : 'Worker'}</button>
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
        <div class="plan-metric"><div><strong>${events.length}</strong><span>Events</span></div></div>
        <div class="plan-metric"><div><strong>${invoiceCount}</strong><span>Invoices</span></div></div>
        <div class="plan-metric"><div><strong>${claimCount}</strong><span>Claims</span></div></div>
      </div>
    </div>
    <section class="wf-panel wf-freelancer-events-panel">
      <header class="wf-panel-header"><div><h3>Events &amp; Submissions</h3>
        <p>Most recent events are shown first. Expand an event to manage its files.</p></div>
        <input class="wf-search wf-event-history-search" type="search"
          placeholder="Search event name, location, date or role"
          oninput="renderFreelancerWorkspaceEvents(this.value)">
      </header>
      <div class="wf-history-table-head"><span>Event &amp; Location</span><span>Date &amp; Role</span>
        <span>Invoice</span><span>Claims</span><span>Total</span><span></span></div>
      <div class="wf-history-list" id="wfFreelancerWorkspaceEvents"></div>
    </section>`;
  renderFreelancerWorkspaceEvents('');
}

function renderFreelancerWorkspaceEvents(search = '') {
  const node = document.getElementById('wfFreelancerWorkspaceEvents');
  const data = workforcePageState.freelancerWorkspaceData;
  if (!node || !data) return;
  const query = String(search || '').trim().toLowerCase();
  workforcePageState.freelancerWorkspaceSearch = query;
  const rows = data.events.filter(event => {
    const text = [
      event.name, event.location, event.startDate, event.endDate,
      ...(event.roles || []).flatMap(role => [role.department, role.role])
    ].join(' ').toLowerCase();
    return !query || text.includes(query);
  });
  node.innerHTML = rows.map(event =>
    wfHistoryEventCard(
      event,
      (data.subject || data.freelancer).id,
      data.subjectType || 'worker'
    )
  ).join('') || '<div class="wf-empty">No matching events for this worker or vendor.</div>';
}

async function openFreelancerWorkspaceAssignment(eventId, freelancerId, assignmentId = '', subjectType = 'worker') {
  workforcePageState.freelancerWorkspaceReturnId = freelancerId;
  await loadFreelancerHistoryEvent(eventId);
  if (subjectType === 'vendor') {
    openVendorAssignment(freelancerId, '', assignmentId);
  } else {
    openFreelancerAssignment(freelancerId, '', assignmentId);
  }
}

async function removeFreelancerWorkspaceAssignment(eventId, freelancerId, assignmentId) {
  try {
    await loadFreelancerHistoryEvent(eventId);
    await deleteWorkforceAssignmentRequest(eventId, assignmentId);
    await openFreelancerHistory(freelancerId);
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

async function openFreelancerHistorySubmission(eventId, freelancerId, submissionId) {
  workforcePageState.historyReturnFreelancerId = freelancerId;
  await loadFreelancerHistoryEvent(eventId);
  closeWorkforceModal('wfFreelancerHistoryModal');
  await openWorkforceReview(submissionId);
}

async function openFreelancerHistoryUpload(eventId, freelancerId, kind) {
  workforcePageState.historyReturnFreelancerId = freelancerId;
  await loadFreelancerHistoryEvent(eventId);
  closeWorkforceModal('wfFreelancerHistoryModal');
  openAdminWorkforceUpload(freelancerId, kind);
}

async function chooseFreelancerHistoryStatus(event, eventId, freelancerId, submissionId, status) {
  event.stopPropagation();
  closeWorkforceStatusMenus();
  await loadFreelancerHistoryEvent(eventId);
  if (status === 'Denied') {
    workforcePageState.historyReturnFreelancerId = freelancerId;
    closeWorkforceModal('wfFreelancerHistoryModal');
    openWorkforceDenialReason(submissionId);
    return;
  }
  const changed = await applyWorkforceStatus(submissionId, status);
  if (changed) await openFreelancerHistory(freelancerId);
}

async function changeFreelancerHistoryUploadSlots(eventId, freelancerId, kind, delta) {
  try {
    await apiCall(
      `/api/events/${Number(eventId)}/workforce/allowances/${encodeURIComponent(freelancerId)}`,
      'POST',
      { kind, delta }
    );
    await openFreelancerHistory(freelancerId);
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

function wfDateCalendarHtml(selectedDates = []) {
  const allowedDates = wfEventDateOptions();
  if (!allowedDates.length) return '<div class="wf-empty">No valid event dates.</div>';
  const allowed = new Set(allowedDates);
  const selected = new Set(selectedDates);
  const first = new Date(`${allowedDates[0]}T12:00:00`);
  const last = new Date(`${allowedDates[allowedDates.length - 1]}T12:00:00`);
  const months = [];
  for (
    const cursor = new Date(first.getFullYear(), first.getMonth(), 1, 12);
    cursor <= last;
    cursor.setMonth(cursor.getMonth() + 1)
  ) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const mondayOffset = (new Date(year, month, 1).getDay() + 6) % 7;
    const cells = Array.from({ length: mondayOffset }, () =>
      '<span class="wf-calendar-blank"></span>'
    );
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (!allowed.has(date)) {
        cells.push(`<span class="wf-calendar-day outside">${day}</span>`);
      } else {
        cells.push(`<button class="wf-calendar-day event-date ${selected.has(date) ? 'selected' : ''}"
          type="button" data-date="${date}" aria-pressed="${selected.has(date)}"
          onclick="toggleWorkforceCalendarDate(this)">${day}</button>`);
      }
    }
    months.push(`<section class="wf-calendar-month">
      <header>${cursor.toLocaleDateString('en-SG', { month: 'long', year: 'numeric' })}</header>
      <div class="wf-calendar-weekdays">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day => `<span>${day}</span>`).join('')}</div>
      <div class="wf-calendar-days">${cells.join('')}</div>
    </section>`);
  }
  return `<div class="wf-calendar-toolbar"><span>Only highlighted event dates can be selected.</span>
      <div><button class="wf-link-button" type="button" onclick="setWorkforceCalendarSelection(this,true)">Select all</button>
        <button class="wf-link-button" type="button" onclick="setWorkforceCalendarSelection(this,false)">Clear</button></div>
    </div><div class="wf-calendar-months">${months.join('')}</div>`;
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
}

function wfSelectedCalendarDates(id) {
  return [...document.querySelectorAll(`#${id} .wf-calendar-day.selected`)]
    .map(button => button.dataset.date)
    .filter(Boolean);
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
      : allDates.slice(0, Number(assignment?.days || 1))
  );
  document.getElementById('wfAssignmentDates').innerHTML =
    wfDateCalendarHtml([...selectedDates]);
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
    : allDates.slice(0, Number(assignment?.days || 1));
  document.getElementById('wfVendorAssignmentDates').innerHTML =
    wfDateCalendarHtml(selectedDates);
  syncVendorAssignmentFields();
  document.getElementById('wfVendorAssignmentModalTitle').textContent =
    assignment ? 'Edit Vendor Event Assignment' : 'Vendor Event Assignment';
  document.querySelector('#wfVendorAssignmentForm [type="submit"]').textContent =
    assignment ? 'Save Assignment' : 'Add Assignment';
  wfError('wfVendorAssignmentError');
  closeWorkforceModal('wfVendorDirectoryModal');
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

async function deleteWorkforceAssignmentRequest(eventId, assignmentId, confirmedUploads = false) {
  const suffix = confirmedUploads ? '?deleteUploads=1' : '';
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
        return deleteWorkforceAssignmentRequest(eventId, assignmentId, true);
      }
    }
    throw error;
  }
}

function openManualDepartment() {
  ensureWorkforceModals();
  document.getElementById('wfDepartmentForm').reset();
  document.getElementById('wfDepartmentPreset').innerHTML = '<option value="">Custom department</option>' +
    (workforcePageState.data.allDepartments || []).map(row =>
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
  const freelancer = wfFindFreelancer(freelancerId) || wfFindVendor(freelancerId);
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
  file.accept = claim ? '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg' : '.pdf,application/pdf';
  file.multiple = claim;
  document.getElementById('wfAdminUploadFileLabel').textContent = claim ? 'Claim files (PDF, PNG or JPG) *' : 'Invoice PDF *';
  document.getElementById('wfAdminUploadDropPrompt').textContent = claim ? 'Drag & drop or choose claim files' : 'Drag & drop or choose an invoice';
  updateAdminWorkforceDropzoneFiles();
  document.querySelector('#wfAdminUploadForm [type="submit"]').textContent = claim ? 'Upload Files' : 'Upload File';
  document.getElementById('wfAdminUploadProgress').hidden = true;
  wfError('wfAdminUploadError');
  openWorkforceModal('wfAdminUploadModal');
}

function syncAdminClaimCategory() {
  const other = document.getElementById('wfAdminClaimCategory')?.value === 'Other';
  const field = document.getElementById('wfAdminOtherCategoryField');
  if (!field) return;
  field.hidden = !other;
  document.getElementById('wfAdminOtherCategory').required = other && !document.getElementById('wfAdminOtherCategory').disabled;
}

async function submitAdminWorkforceUpload(event) {
  event.preventDefault();
  const id = document.getElementById('wfAdminUploadFreelancerId').value;
  const kind = document.getElementById('wfAdminUploadKind').value;
  const files = [...document.getElementById('wfAdminUploadFile').files];
  if (!files.length) return;
  const plural = kind === 'invoice' ? 'invoices' : 'claims';
  const submissionRows = (workforcePageState.data.submissions[id] ||= { invoices: [], claims: [] })[plural];
  const optimisticIds = files.map((file, index) => {
    const uploadId = `admin-upload-${Date.now()}-${index}`;
    submissionRows.push({
      id: uploadId, originalName: file.name, amount: null, status: 'Uploading',
      uploadProgress: 0, clientOnly: true
    });
    return uploadId;
  });
  renderWorkforcePage();
  const progress = document.getElementById('wfAdminUploadProgress');
  progress.hidden = false;
  let processingShown = false;
  try {
    const response = await wfUploadWithProgress(
      `/api/events/${workforcePageState.eventId}/workforce/submissions/${encodeURIComponent(id)}`,
      new FormData(event.currentTarget),
      (value, phase) => {
        if (phase === 'processing') {
          if (processingShown) return;
          processingShown = true;
          submissionRows.forEach(row => {
            if (optimisticIds.includes(row.id)) {
              row.status = 'Pending Review';
              row.processingState = 'Processing';
            }
          });
          progress.querySelector('strong').textContent = 'Upload complete · Processing';
          document.getElementById('wfAdminUploadProgressBar').style.width = '100%';
          document.getElementById('wfAdminUploadProgressLabel').textContent = 'Processing';
          renderWorkforcePage();
          return;
        }
        document.getElementById('wfAdminUploadProgressBar').style.width = `${value}%`;
        document.getElementById('wfAdminUploadProgressLabel').textContent = `${Math.round(value)}%`;
        optimisticIds.forEach(uploadId => {
          const bar = document.querySelector(`[data-wf-upload-progress="${uploadId}"]`);
          const label = document.querySelector(`[data-wf-upload-label="${uploadId}"]`);
          if (bar) bar.style.width = `${value}%`;
          if (label) label.textContent = `${Math.round(value)}%`;
        });
      }
    );
    progress.querySelector('strong').textContent = 'Upload complete · Processing';
    workforcePageState.data = response.data;
    closeWorkforceModal('wfAdminUploadModal');
    renderWorkforcePage();
    showNotification('success', 'Crew upload added');
  } catch (error) {
    workforcePageState.data.submissions[id][plural] = submissionRows
      .filter(row => !optimisticIds.includes(row.id));
    renderWorkforcePage();
    wfError('wfAdminUploadError', error.message);
  }
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
    xhr.upload.onload = () => onProgress(100, 'processing');
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
  document.getElementById('wfTransportDirectoryList').innerHTML = rows.map(row =>
    `<div class="wf-directory-row"><button class="wf-directory-main" type="button" onclick="openTransportBooking('${wfAttr(row.id)}')">
      <span class="wf-avatar">${wfMetricIconSvg('transport')}</span><span><strong>${wfEscape(row.vehicleType || 'Vehicle')} &middot; ${wfEscape(row.vehicleNumber || '')}</strong>
      <small>${wfEscape(row.company || '')}${row.contactNumber ? ` &middot; ${wfEscape(row.contactNumber)}` : ''}</small></span></button>
      <button class="wf-button" type="button" onclick="openTransportProfile('${wfAttr(row.id)}')">Edit</button></div>`).join('') ||
      '<div class="wf-empty">No saved transport profiles. Add one to begin.</div>';
}

function openTransportProfile(id = '', returnToBooking = false) {
  ensureWorkforceModals();
  const row = workforcePageState.data.transportVendors.find(item => String(item.id) === String(id));
  workforcePageState.returnToTransportBooking = Boolean(returnToBooking);
  workforcePageState.editingTransportProfileId = row?.id || null;
  document.getElementById('wfTransportProfileForm').reset();
  document.getElementById('wfTransportProfileModalTitle').textContent = row ? 'Edit Transport' : 'Add New Transport';
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
  renderTransportLocations();
  openWorkforceModal('wfLocationsModal');
}

function renderTransportLocations() {
  document.getElementById('wfLocationsList').innerHTML = (workforcePageState.data.transportLocations || []).map(row =>
    `<div class="wf-directory-row"><span><strong>${wfEscape(row.name)}</strong>
      ${row.address ? `<small>(${wfEscape(row.address)})</small>` : ''}</span>
      <button class="wf-button danger" type="button" onclick="deleteTransportLocation('${wfAttr(row.id)}')">Remove</button></div>`).join('') ||
      '<div class="wf-empty">No saved locations yet.</div>';
}

async function saveTransportLocation(event) {
  event.preventDefault();
  try {
    await apiCall('/api/workforce/transport-locations', 'POST', {
      name: document.getElementById('wfLocationName').value,
      address: document.getElementById('wfLocationAddress').value
    });
    document.getElementById('wfLocationName').value = '';
    document.getElementById('wfLocationAddress').value = '';
    await refreshWorkforcePage();
    renderTransportLocations();
  } catch (error) {
    wfError('wfLocationError', error.message);
  }
}

async function deleteTransportLocation(id) {
  await apiCall(`/api/workforce/transport-locations/${encodeURIComponent(id)}`, 'DELETE');
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
  document.getElementById('wfLocationFrom').value = departure.locationTo || '';
  document.getElementById('wfLocationTo').value = departure.locationFrom || '';
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

function renderTransportVehicleDrivers() {
  const root = document.getElementById('wfBookingDrivers');
  const singleFields = document.getElementById('wfSingleDriverFields');
  if (!root || !singleFields) return;
  const selections = wfSelectedTransportVehicles();
  const usesIndividualDrivers = selections.length > 1;
  root.hidden = !usesIndividualDrivers;
  singleFields.hidden = usesIndividualDrivers;
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
    <div class="wf-booking-driver-list">${selections.map(selection => {
      const key = wfTransportSelectionKey(selection.sourceType, selection.id);
      const details = workforcePageState.transportDriverDetails.get(key) || {};
      const label = wfTransportSelectionLabel(selection);
      const encodedKey = encodeURIComponent(key);
      return `<article class="wf-booking-driver-row">
        <div><strong>${wfEscape(label.title)}</strong><small>${wfEscape(label.subtitle)}</small></div>
        <label class="wf-field"><span>Driver *</span><input required value="${wfAttr(details.driver || '')}" placeholder="Driver name" oninput="updateTransportVehicleDriver('${wfAttr(encodedKey)}','driver',this.value)"></label>
        <label class="wf-field"><span>Driver phone</span><input type="tel" value="${wfAttr(details.contact || '')}" placeholder="+65 9123 4567" oninput="updateTransportVehicleDriver('${wfAttr(encodedKey)}','contact',this.value)"></label>
      </article>`;
    }).join('')}</div>`;
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
  const count = selections.fleet.size + selections.external.size;
  const summary = document.getElementById('wfBookingSelectionSummary');
  if (summary) summary.textContent = count
    ? `${count} vehicle${count === 1 ? '' : 's'} selected`
    : 'No vehicles selected';
  const submit = document.getElementById('wfTransportBookingSubmit');
  if (submit && !workforcePageState.editingTransportId) {
    submit.textContent = count > 1 ? `Add ${count} to Event` : 'Add to Event';
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
  document.getElementById('wfSavedLocations').innerHTML =
    (workforcePageState.data.transportLocations || [])
      .map(row => `<option value="${wfAttr(row.address ? `${row.name} (${row.address})` : row.name)}"></option>`)
      .join('');
  document.getElementById('wfTransportDriver').value = booking?.driver || '';
  document.getElementById('wfTransportDriverContact').value =
    booking?.driverContact || booking?.contactNumber || '';
  document.getElementById('wfLocationFrom').value = booking?.locationFrom || '';
  document.getElementById('wfLocationTo').value = booking?.locationTo || '';
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
  const previousCount = selections.fleet.size + selections.external.size;
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
    const label = [
      profile.vehicleType,
      profile.vehicleNumber
    ].filter(Boolean).join(' - ');
    const lastCost = profile.lastCost === null || profile.lastCost === undefined
      ? 'No previous cost'
      : `Last cost ${wfMoney(profile.lastCost)}`;
    return `<button class="wf-booking-vehicle-option" type="button"
        data-source="external" data-id="${wfAttr(profile.id)}"
        onclick="selectTransportVehicle('external','${wfAttr(profile.id)}')">
      <span><strong>${wfEscape(label || 'External transport')}</strong>
        <small>${wfEscape(profile.company || 'Company not recorded')}</small></span>
      <em>${wfEscape(lastCost)}</em>
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
    wfError('wfTransportBookingError', 'Choose at least one own-fleet or known external vehicle.');
    return;
  }
  if (selections.length > 1) {
    const missingDriver = selections.some(selection => {
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
    for (const selection of selections) {
      const individualDriver = workforcePageState.transportDriverDetails.get(
        wfTransportSelectionKey(selection.sourceType, selection.id)
      ) || {};
      latestResponse = await apiCall(id
        ? `/api/events/${workforcePageState.eventId}/workforce/transport/${encodeURIComponent(id)}`
        : `/api/events/${workforcePageState.eventId}/workforce/transport`, id ? 'PUT' : 'POST', {
        sourceType: selection.sourceType,
        subprojectId: document.getElementById('wfTransportSubproject').value,
        tripType,
        vendorId: selection.sourceType === 'external' ? selection.id : '',
        vehicleId: selection.sourceType === 'fleet' ? selection.id : '',
        driver: selections.length > 1
          ? individualDriver.driver
          : document.getElementById('wfTransportDriver').value,
        driverContact: selections.length > 1
          ? individualDriver.contact
          : document.getElementById('wfTransportDriverContact').value,
        locationFrom: document.getElementById('wfLocationFrom').value,
        locationTo: document.getElementById('wfLocationTo').value,
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
    }
    closeWorkforceModal('wfTransportBookingModal');
    renderWorkforcePage();
    showNotification('success', selections.length > 1
      ? `${selections.length} ${tripType === 'return' ? 'return' : 'depart'} transport bookings saved`
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

async function uploadTransportInvoice(id, input) {
  const file = input.files?.[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const response = await apiCall(`/api/events/${workforcePageState.eventId}/workforce/transport/${encodeURIComponent(id)}/invoice`, 'POST', form);
    workforcePageState.data = response.data;
    renderWorkforcePage();
  } finally {
    input.value = '';
  }
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

function syncWorkforceReviewDenialField() {
  const field = document.getElementById('wfReviewDenialReasonField');
  if (!field) return;
  field.hidden = document.getElementById('wfReviewStatus')?.value !== 'Denied';
}

function wfReviewStatusPicker(current = '') {
  const label = current || 'Select status';
  return `<div class="wf-status-control wf-review-status-control">
    <input id="wfReviewStatus" type="hidden" value="${wfAttr(current)}">
    <button id="wfReviewStatusButton" class="wf-status-button ${current ? wfStatusClass(current) : 'status-unselected'}"
      type="button" onclick="toggleWorkforceReviewStatusMenu(event)">
      ${wfEscape(label)} <span>&#9662;</span>
    </button>
    <div class="wf-status-menu" id="wfReviewStatusMenu">
      ${['Pending Review', 'Approved', 'Denied'].map(status =>
        `<button class="${wfStatusClass(status)}" type="button"
          onclick="selectWorkforceReviewStatus(event,'${status}')">${status}</button>`
      ).join('')}
    </div>
  </div>`;
}

function toggleWorkforceReviewStatusMenu(event) {
  event.stopPropagation();
  document.getElementById('wfReviewStatusMenu')?.classList.toggle('open');
}

function selectWorkforceReviewStatus(event, status) {
  event.stopPropagation();
  const input = document.getElementById('wfReviewStatus');
  const button = document.getElementById('wfReviewStatusButton');
  input.value = status;
  button.className = `wf-status-button ${wfStatusClass(status)}`;
  button.innerHTML = `${wfEscape(status)} <span>&#9662;</span>`;
  document.getElementById('wfReviewStatusMenu')?.classList.remove('open');
  syncWorkforceReviewDenialField();
}

function wfReviewClaimCategoryFields(record, verified) {
  const rawCategory = String(record.category || '');
  const category = rawCategory === 'Cab'
    ? 'Transport'
    : (['Transport', 'Meal'].includes(rawCategory) ? rawCategory : (rawCategory ? 'Other' : ''));
  const otherValue = category === 'Other' ? rawCategory : '';
  return `<label class="wf-field"><span>Claim date *</span>
      <input id="wfReviewClaimDate" type="date" value="${wfAttr(record.claimDate || '')}" required ${verified ? 'disabled' : ''}>
    </label>
    <label class="wf-field"><span>Category *</span>
      <select id="wfReviewClaimCategory" required ${verified ? 'disabled' : ''}
        onchange="syncWorkforceReviewClaimCategory()">
        <option value="" ${category ? '' : 'selected'} disabled>Select category</option>
        <option value="Transport" ${category === 'Transport' ? 'selected' : ''}>Transport</option>
        <option value="Meal" ${category === 'Meal' ? 'selected' : ''}>Meal</option>
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
      <div><span>Expected from role</span><strong>${hasExpected ? wfMoney(expected) : 'Not available'}</strong></div>
      <div><span>Detected / entered</span><strong id="wfReviewDetectedAmount">${record.amount == null ? 'Not detected' : wfMoney(record.amount)}</strong></div>
      <span class="wf-amount-match" id="wfReviewAmountMatch">${hasExpected ? 'Checking' : 'No role estimate'}</span>
    </div>
    ${breakdown ? `<div class="wf-amount-breakdown">${breakdown}</div>` : '<small class="wf-amount-no-role">No rated role is assigned to this worker or vendor for the event.</small>'}
  </section>`;
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
  } else {
    resultNode.textContent = `${difference > 0 ? '+' : '-'}${wfMoney(Math.abs(difference))} difference`;
    resultNode.classList.add('is-difference');
  }
}

async function openWorkforceReview(id, requestedStatus = '', skipOcrRetry = false) {
  ensureWorkforceModals();
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
      found = wfFindSubmission(id);
    } catch (error) {
      showNotification('error', `Invoice scan could not determine the total: ${error.message}`);
    }
  }
  if (!found) return;
  workforcePageState.reviewSubmissionId = id;
  const { record, freelancerId, kind } = found;
  const detailsRequired =
    kind === 'claim' && record.submissionStage === 'Details Required';
  const freelancer = wfFindFreelancer(freelancerId) || wfFindVendor(freelancerId) || {};
  const departments = wfDepartmentsForFreelancer(freelancerId);
  const verified = Boolean(record.verifiedAt);
  const pendingDecision = record.status === 'Pending Review';
  const savedAllocations = record.allocations || [];
  workforcePageState.autoAllocation =
    kind === 'invoice' && !savedAllocations.length;
  const allocations = savedAllocations.length
    ? Object.fromEntries(savedAllocations.map(row => [row.department, row.amount]))
    : wfEvenAllocationMap(departments, record.amount);
  const pdf = record.contentType === 'application/pdf';
  document.getElementById('wfReviewModalTitle').textContent =
    `Review ${kind === 'invoice' ? 'Invoice' : 'Claim'}`;
  document.getElementById('wfReviewContent').innerHTML = `<div class="wf-review-layout">
    <div class="wf-preview">${pdf ? `<iframe src="${wfAttr(record.previewUrl)}#toolbar=1" title="Uploaded PDF"></iframe>`
      : `<img src="${wfAttr(record.previewUrl)}" alt="Uploaded claim">`}</div>
    <form class="wf-review-form" id="wfReviewForm"><p class="wf-form-intro">${wfEscape(freelancer.name || '')} &middot; ${wfEscape(record.originalName || '')}</p>
      ${detailsRequired ? `<div class="wf-details-required-note"><strong>Claim details required</strong>
        <span>Complete the missing information below on behalf of the worker before saving or approving this claim.</span></div>` : ''}
      ${wfReviewExpectedAmountHtml(record)}
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
      ${kind === 'invoice' ? `<div class="wf-section-card"><h4>Department allocation</h4>
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
  syncWorkforceReviewClaimCategory();
  updateAllocationProgress();
  updateWorkforceExpectedComparison();
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
  const modal = document.querySelector('.wf-modal.open');
  if (modal) closeWorkforceModal(modal.id);
});

document.addEventListener('DOMContentLoaded', ensureWorkforceModals);
