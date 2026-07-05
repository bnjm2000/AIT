const workforcePageState = {
  eventId: null,
  eventOptions: [],
  data: null,
  loading: false,
  reviewSubmissionId: null,
  denialSubmissionId: null,
  autoAllocation: false,
  editingFreelancerId: null,
  selectedFreelancerId: null,
  editingAssignmentId: null,
  directoryMode: 'manage',
  directoryDepartment: '',
  historyFreelancerId: null,
  historyReturnFreelancerId: null,
  freelancerWorkspaceData: null,
  freelancerWorkspaceSearch: '',
  freelancerWorkspaceReturnId: null,
  editingTransportProfileId: null,
  selectedTransportProfileId: null,
  editingTransportId: null
};

const workforceEventChooserState = {
  search: '',
  filter: 'ALL',
  page: 1,
  pageSize: 8
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

function wfMoney(value) {
  return `SGD ${Number(value || 0).toLocaleString('en-SG', {
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

function wfFindFreelancer(id) {
  return workforcePageState.data?.freelancers?.find(row => String(row.id) === String(id));
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

function openEventWorkforce(eventId) {
  if (!isAdminUser()) {
    showNotification('error', 'Admin privileges are required');
    return;
  }
  workforcePageState.eventId = Number(eventId);
  workforcePageState.data = null;
  showSection('workforce');
}

async function loadWorkforcePage() {
  const root = document.getElementById('workforce-page-root');
  if (!root || workforcePageState.loading) return;
  workforcePageState.loading = true;
  if (!workforcePageState.data) root.innerHTML = '<div class="loading">Loading manpower and transport...</div>';
  try {
    if (!workforcePageState.eventOptions.length) {
      const response = await apiCall('/api/events');
      workforcePageState.eventOptions = (response.data || [])
        .slice()
        .sort(planCompareEventsByStartDate);
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
  await loadWorkforcePage();
}

function wfStatusMenu(record) {
  if (record.status === 'Uploading') {
    return `<span class="wf-admin-upload-status"><span class="wf-status-button status-uploading">Uploading</span>
      <span class="wf-admin-progress-track"><span data-wf-upload-progress="${wfAttr(record.id)}" style="width:${Number(record.uploadProgress || 0)}%"></span></span>
      <small data-wf-upload-label="${wfAttr(record.id)}">${Math.round(Number(record.uploadProgress || 0))}%</small></span>`;
  }
  if (record.processingState === 'Processing') {
    return `<span class="wf-status-button ${wfStatusClass('Processing')}">Processing</span>`;
  }
  if (record.submissionStage === 'Details Required') {
    return `<span class="wf-status-button ${wfStatusClass('Details Required')}">Details required</span>`;
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
  const freelancer = wfFindFreelancer(freelancerId) || { id: freelancerId, name: 'Unknown freelancer' };
  const submissions = workforcePageState.data.submissions?.[freelancerId] || { invoices: [], claims: [] };
  const limits = workforcePageState.data.uploadAllowances?.[freelancerId] || {
    invoiceLimit: 1, claimLimit: 5, activeInvoices: 0, activeClaims: 0,
    invoiceSlotsRemaining: 1, claimSlotsRemaining: 5, extraInvoices: 0, extraClaims: 0
  };
  const roles = assignments.map(row => `<span class="wf-assignment-chip">
    <button class="wf-assignment-edit" type="button" title="Edit assignment"
      onclick="openFreelancerAssignment('${wfAttr(freelancer.id)}','${wfAttr(row.department)}','${wfAttr(row.id)}')">
      ${wfEscape(row.roleName)} &middot; ${row.days} day${Number(row.days) === 1 ? '' : 's'} &middot; ${wfMoney(row.dailyRate)}/day
    </button>
    <button type="button" title="Remove role" onclick="event.stopPropagation();deleteWorkforceAssignment('${wfAttr(row.id)}')">&times;</button>
  </span>`).join('');
  return `<article class="wf-worker">
    <button class="wf-worker-identity wf-worker-open" type="button"
      onclick="openFreelancerHistory('${wfAttr(freelancer.id)}')"><div class="wf-worker-profile">
      <span class="wf-avatar">${wfEscape(wfInitials(freelancer.name))}</span>
      <div><strong>${wfEscape(freelancer.name)}</strong>
        <small>${wfEscape(freelancer.phone || 'No portal phone number')}</small></div>
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

function wfDepartmentHtml(department, assignments, index) {
  const totals = workforcePageState.data.totals?.departments?.[department] || { invoice: 0, claims: 0, combined: 0 };
  const byWorker = {};
  assignments.forEach(row => (byWorker[row.freelancerId] ||= []).push(row));
  const count = Object.keys(byWorker).length;
  const stateCounts = Object.keys(byWorker).reduce((summary, freelancerId) => {
    const submissions = workforcePageState.data.submissions?.[freelancerId] || {};
    [...(submissions.invoices || []), ...(submissions.claims || [])].forEach(record => {
      const status = record.paymentConfirmedAt ? 'Payment Confirmed' : (record.status || 'Pending Review');
      summary[status] = (summary[status] || 0) + 1;
    });
    return summary;
  }, {});
  const statusBadges = ['Pending Review', 'Approved', 'Denied', 'Paid', 'Payment Confirmed'].map(status =>
    `<span class="${wfStatusClass(status)}">${status}: <strong>${Number(stateCounts[status] || 0)}</strong></span>`
  ).join('');
  return `<details class="wf-department" data-department="${wfAttr(department)}" ${index === 0 ? 'open' : ''}>
    <summary><span class="wf-department-title"><span class="wf-department-label">${wfEscape(department)} <small>${count} crew</small></span>
        <span class="wf-dept-status-summary">${statusBadges}</span></span>
      <span class="wf-dept-total"><span>Invoices</span><strong>${wfMoney(totals.invoice)}</strong></span>
      <span class="wf-dept-total"><span>Claims</span><strong>${wfMoney(totals.claims)}</strong></span>
      <span class="wf-dept-total"><span>Combined</span><strong>${wfMoney(totals.combined)}</strong></span></summary>
    <div class="wf-department-actions">
      <button class="wf-button primary" type="button" onclick="openFreelancerDirectory('assign','${wfAttr(department)}')">+ Add freelancer</button>
      ${count === 0 ? `<button class="wf-button danger" type="button" onclick="deleteWorkforceDepartment('${wfAttr(department)}')">Remove department</button>` : ''}
    </div>
    <div>${count ? Object.entries(byWorker).map(([id, rows]) => wfWorkerHtml(id, rows)).join('') : '<div class="wf-empty">No freelancers assigned to this department.</div>'}</div>
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
  const invoice = booking.invoice;
  const routeFrom = isReturn ? booking.locationTo : booking.locationFrom;
  const routeTo = isReturn ? booking.locationFrom : booking.locationTo;
  const tripDate = isReturn ? booking.returnDate : booking.departDate;
  const tripTime = isReturn ? booking.returnTime : booking.departTime;
  const directionLabel = isReturn ? 'Return' : 'Depart';
  const contact = wfFormatPhone(booking.contactNumber);
  return `<article class="wf-transport-card wf-trip-card ${isReturn ? 'return-trip' : 'depart-trip'}">
    <div class="wf-transport-heading">
      <div class="wf-vehicle-heading">
        <span class="wf-trip-direction">${directionLabel}</span>
        <h4>${wfEscape(booking.vehicleType || 'Transport')}${booking.vehicleNumber ? ` &middot; ${wfEscape(booking.vehicleNumber)}` : ''}</h4>
        <small>${wfEscape(booking.company || '')}</small>
      </div>
      <div class="wf-driver-heading">
        <strong>${wfEscape(booking.driver || booking.companyDriver || 'Driver TBC')}</strong>
        <span>${wfEscape(contact || 'No contact')}</span>
      </div>
    </div>
    <div class="wf-transport-meta">
      <div class="wf-route"><span>Route</span><strong>${wfLocationBadge(routeFrom, 'From')}<b>&rarr;</b>${wfLocationBadge(routeTo, 'To')}</strong></div>
      <div class="wf-trip-datetime"><span>Date &amp; Time</span><strong>${wfEscape([tripDate, tripTime].filter(Boolean).join(' · ') || '—')}</strong></div>
      <div><span>${isReturn ? 'Cost' : 'Booking cost'}</span><strong>${isReturn ? 'Included in booking' : wfMoney(booking.cost)}</strong></div>
      ${!isReturn ? `<div><span>Invoice</span><strong>${invoice
        ? `<button class="wf-link-button" type="button" onclick="window.open('${wfAttr(invoice.previewUrl)}','_blank')">${wfEscape(invoice.originalName)}</button>`
        : 'Not uploaded'}</strong></div>` : ''}
    </div>
    <div class="wf-transport-footer">
      ${!isReturn ? `<label class="wf-link-button">${invoice ? 'Replace invoice' : 'Upload invoice'}
        <input type="file" accept=".pdf,application/pdf" hidden onchange="uploadTransportInvoice('${wfAttr(booking.id)}',this)"></label>`
        : '<span class="wf-return-booking-note">Return leg of the same booking</span>'}
      <div>
        <button class="wf-button" type="button" onclick="openTransportBooking('${wfAttr(booking.vendorId)}','${wfAttr(booking.id)}')">Edit</button>
        ${!isReturn ? `<button class="wf-button danger" type="button" onclick="deleteTransportBooking('${wfAttr(booking.id)}')">Remove</button>` : ''}
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
  return `<span class="wf-location-badge"><small>${label}</small><b>${wfEscape(name || '—')}</b>
    ${address ? `<em>(${wfEscape(address)})</em>` : ''}</span>`;
}

function wfTransportCard(booking) {
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
      <button class="wf-button primary" type="button" onclick="openTransportDirectory()">Manage Transport</button></header>
      <div class="wf-transport-list">${data.transportBookings.length ? data.transportBookings.map(wfTransportCard).join('') : '<div class="wf-empty">No transport booked for this event.</div>'}</div></section>
    <section class="wf-panel"><header class="wf-panel-header"><div><h3>Manpower / Freelance Crew</h3>
      <p>Departments are created automatically from this event’s outgoing assets.</p></div>
      <div class="wf-toolbar"><a class="wf-button" href="/api/events/${data.event.id}/workforce/download/invoices">Download invoices (.zip)</a>
        <a class="wf-button" href="/api/events/${data.event.id}/workforce/download/claims">Download claims (.zip)</a>
        <button class="wf-button" type="button" onclick="openManualDepartment()">+ Department</button>
        <button class="wf-button primary" type="button" onclick="openFreelancerDirectory('manage')">Manage Freelancers</button></div></header>
      <div>${departments || '<div class="wf-empty">No asset departments detected. Add one manually to begin.</div>'}</div>
    </section>`;
}

function renderWorkforcePage() {
  const root = document.getElementById('workforce-page-root');
  const data = workforcePageState.data;
  if (!root || !data) return;
  const viewState = captureWorkforceViewState(root);
  const grouped = Object.fromEntries(
    (data.departments || []).map(row => [row.code, []])
  );
  data.assignments.forEach(row => {
    (grouped[row.department || 'Unassigned'] ||= []).push(row);
  });
  const departments = Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([department, rows], index) =>
      wfDepartmentHtml(department, rows, index)
    ).join('');
  const totals = data.totals || {};
  const grand = Number(totals.combined || 0) + Number(totals.transport || 0);
  const eventDates = data.event.startDate === data.event.endDate
    ? data.event.startDate
    : [data.event.startDate, data.event.endDate].filter(Boolean).join(' – ');

  root.innerHTML = `
    <div class="plan-page-heading">
      <h2>Manpower &amp; Transport</h2>
      <p>Assign crew, review submissions and arrange transport.</p>
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

        <section class="wf-panel wf-manpower-panel">
          <header class="wf-panel-header">
            <div>
              <h3>Manpower / Freelance Crew</h3>
              <p>Departments are created automatically from this event’s outgoing assets.</p>
            </div>
            <div class="wf-toolbar">
              <a class="wf-button" href="/api/events/${data.event.id}/workforce/download/invoices">Download invoices (.zip)</a>
              <a class="wf-button" href="/api/events/${data.event.id}/workforce/download/claims">Download claims (.zip)</a>
              <button class="wf-button" type="button" onclick="openManualDepartment()">+ Department</button>
              <button class="wf-button primary" type="button" onclick="openFreelancerDirectory('manage')">Manage Freelancers</button>
            </div>
          </header>
          <div>${departments || '<div class="wf-empty">No asset departments detected. Add one manually to begin.</div>'}</div>
        </section>
      </div>

      <aside class="plan-aside wf-plan-aside">
        <section class="plan-card plan-details-card">
          <div class="plan-card-header"><h3>Event Details</h3></div>
          <div class="plan-aside-body">
            <dl class="plan-detail-list">
              <div><dt>Name</dt><dd>${wfEscape(data.event.name || `Event ${data.event.id}`)}</dd></div>
              <div><dt>Location</dt><dd>${wfEscape(data.event.location || '—')}</dd></div>
              <div><dt>Date(s)</dt><dd>${wfEscape(eventDates || '—')}</dd></div>
              <div><dt>Status</dt><dd>${planEventStateBadgeHtml(data.event)}</dd></div>
              <div><dt>Type</dt><dd>${planEventTypeBadgeHtml(data.event)}</dd></div>
            </dl>
          </div>
        </section>

        <section class="plan-card wf-transport-panel">
          <header class="wf-panel-header">
            <div><h3>Transport Details</h3><p>Vehicles booked for this event.</p></div>
            <button class="wf-button primary" type="button" onclick="openTransportDirectory()">Manage Transport</button>
          </header>
          <div class="wf-transport-list">
            ${data.transportBookings.length
              ? data.transportBookings.map(wfTransportCard).join('')
              : '<div class="wf-empty">No transport booked for this event.</div>'}
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
    wfModal('wfFreelancerDirectoryModal', 'Manage Freelancers', `<div class="wf-modal-body">
      <div class="wf-directory-toolbar"><input class="wf-search" id="wfFreelancerSearch" type="search" placeholder="Search by name, phone, email or company" oninput="renderFreelancerDirectory(this.value)">
        <button class="wf-button primary" type="button" onclick="openFreelancerProfile()">Enroll new freelancer</button></div>
      <div class="wf-directory-list wf-directory-grid" id="wfFreelancerDirectoryList"></div></div>`, '', true) +
    wfModal('wfFreelancerHistoryModal', 'Freelancer Overview', `<div class="wf-modal-body" id="wfFreelancerHistoryContent"></div>`, '', true) +
    wfModal('wfWorkerSelectorModal', 'Select Freelancer', `<div class="wf-modal-body">
      <input class="wf-search" id="wfWorkerSelectorSearch" type="search"
        placeholder="Search workers by name, phone, email or company"
        oninput="renderFreelancerWorkspaceSelector(this.value)">
      <div class="wf-directory-list wf-directory-grid wf-worker-selector-list" id="wfWorkerSelectorList"></div>
    </div>`, '', true) +
    wfModal('wfFreelancerProfileModal', 'Enroll New Freelancer', `<form id="wfFreelancerProfileForm">
      <div class="wf-modal-body"><div class="wf-form-grid">
        <label class="wf-field full"><span>Full name *</span><input id="wfFreelancerName" required maxlength="120"></label>
        <label class="wf-field"><span>Phone number</span><input id="wfFreelancerPhone" type="tel"></label>
        <label class="wf-field"><span>Email</span><input id="wfFreelancerEmail" type="email"></label>
        <label class="wf-field"><span>Company</span><input id="wfFreelancerCompany"></label>
        <label class="wf-field full"><span>Notes</span><textarea id="wfFreelancerNotes"></textarea></label>
        <label class="wf-check full"><input id="wfFreelancerActive" type="checkbox" checked> Active profile</label>
        <div class="wf-worker-login full" id="wfWorkerLoginControls" hidden>
          <div><span>Worker portal login</span><strong id="wfWorkerLoginStatus">Setup required</strong>
            <small id="wfWorkerLastLogin">Last login: Never</small></div>
          <button class="wf-button danger" id="wfResetWorkerLogin" type="button"
            onclick="resetFreelancerLogin()">Reset worker login</button>
        </div>
      </div><div class="wf-error" id="wfFreelancerProfileError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfFreelancerProfileModal')">Cancel</button>
        <button class="wf-button primary" type="submit">Save Freelancer</button></footer></form>`) +
    wfModal('wfAssignmentModal', 'Event Assignment', `<form id="wfAssignmentForm">
      <div class="wf-modal-body"><p class="wf-form-intro" id="wfAssignmentFreelancerName"></p><div class="wf-form-grid">
        <label class="wf-field"><span>Department *</span><select id="wfAssignmentDepartment" required></select></label>
        <label class="wf-field"><span>Role / Position *</span><input id="wfAssignmentRole" required maxlength="100"></label>
        <div class="wf-field full"><span>Working dates *</span><div class="wf-work-date-grid" id="wfAssignmentDates"></div></div>
        <label class="wf-field"><span>Daily rate (SGD) *</span><input id="wfAssignmentRate" type="number" min="0" step=".01" required></label>
      </div><div class="wf-error" id="wfAssignmentError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfAssignmentModal')">Cancel</button>
        <button class="wf-button primary" type="submit">Add Assignment</button></footer></form>`) +
    wfModal('wfDepartmentModal', 'Add Department', `<form id="wfDepartmentForm"><div class="wf-modal-body"><div class="wf-form-grid">
      <label class="wf-field full"><span>Configured department</span><select id="wfDepartmentPreset" onchange="syncDepartmentPreset()"></select></label>
      <label class="wf-field"><span>Department code *</span><input id="wfDepartmentCode" maxlength="12" required></label>
      <label class="wf-field"><span>Department name</span><input id="wfDepartmentName" maxlength="80"></label>
      </div><div class="wf-error" id="wfDepartmentError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfDepartmentModal')">Cancel</button>
      <button class="wf-button primary" type="submit">Add Department</button></footer></form>`) +
    wfModal('wfTransportDirectoryModal', 'Manage Transport', `<div class="wf-modal-body">
      <div class="wf-directory-toolbar"><input class="wf-search" id="wfTransportSearch" type="search" placeholder="Search vehicle, company or driver" oninput="renderTransportDirectory(this.value)">
        <div><button class="wf-button" type="button" onclick="openLocationsManager()">Manage Locations</button>
          <button class="wf-button primary" type="button" onclick="openTransportProfile()">Add new transport</button></div></div>
      <div class="wf-directory-list wf-directory-grid" id="wfTransportDirectoryList"></div></div>`, '', true) +
    wfModal('wfTransportProfileModal', 'Add New Transport', `<form id="wfTransportProfileForm"><div class="wf-modal-body">
      <div class="wf-form-grid"><label class="wf-field"><span>Vehicle type *</span><input id="wfProfileVehicleType" required></label>
        <label class="wf-field"><span>Company</span><input id="wfProfileCompany"></label>
        <label class="wf-field"><span>Driver</span><input id="wfProfileDriver"></label>
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
      <p class="wf-form-intro" id="wfBookingVehicle"></p><div class="wf-form-grid">
        <label class="wf-field"><span>Location From *</span><input id="wfLocationFrom" list="wfSavedLocations" required></label>
        <label class="wf-field"><span>Location To *</span><input id="wfLocationTo" list="wfSavedLocations" required></label>
        <datalist id="wfSavedLocations"></datalist>
        <label class="wf-check full"><input id="wfSaveBookingLocations" type="checkbox" checked> Save these locations for future bookings</label>
        <label class="wf-field"><span>Depart Date *</span><input id="wfDepartDate" type="date" required></label>
        <label class="wf-field"><span>Depart Time *</span><input id="wfDepartTime" type="time" required></label>
        <label class="wf-field full"><span>Cost (SGD)</span><input id="wfTransportCost" type="number" min="0" step=".01" value="0"></label>
        <label class="wf-check full"><input id="wfTransportTwoWay" type="checkbox" onchange="syncReturnFields()"> Enable return trip</label>
        <div class="wf-return-fields full" id="wfReturnFields" hidden>
          <label class="wf-field"><span>Return Date *</span><input id="wfReturnDate" type="date"></label>
          <label class="wf-field"><span>Return Time *</span><input id="wfReturnTime" type="time"></label>
        </div>
      </div><div class="wf-error" id="wfTransportBookingError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfTransportBookingModal')">Cancel</button>
        <button class="wf-button primary" type="submit">Add to Event</button></footer></form>`) +
    wfModal('wfAdminUploadModal', 'Upload for Crew', `<form id="wfAdminUploadForm">
      <input id="wfAdminUploadFreelancerId" type="hidden"><input id="wfAdminUploadKind" name="kind" type="hidden">
      <div class="wf-modal-body"><p class="wf-form-intro" id="wfAdminUploadSubtitle"></p>
        <div id="wfAdminInvoiceFields"><p class="wf-help">Invoice amount will be read from the PDF and verified during review.</p></div>
        <div id="wfAdminClaimFields" hidden><p class="wf-help">Claim amount and date will be analysed after upload. Verify them during review.</p></div>
        <label class="wf-field"><span id="wfAdminUploadFileLabel">Invoice PDF *</span><input id="wfAdminUploadFile" name="files" type="file" required></label>
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
        <button class="wf-button" type="button" onclick="closeWorkforceModal('wfDenialReasonModal')">Cancel</button>
        <button class="wf-button danger" type="submit">Deny Submission</button>
      </footer>
    </form>`)
  );
  document.getElementById('wfFreelancerProfileForm').addEventListener('submit', saveFreelancerProfile);
  document.getElementById('wfAssignmentForm').addEventListener('submit', saveFreelancerAssignment);
  document.getElementById('wfDepartmentForm').addEventListener('submit', saveManualDepartment);
  document.getElementById('wfTransportProfileForm').addEventListener('submit', saveTransportProfile);
  document.getElementById('wfLocationForm').addEventListener('submit', saveTransportLocation);
  document.getElementById('wfTransportBookingForm').addEventListener('submit', saveTransportBooking);
  document.getElementById('wfAdminUploadForm').addEventListener('submit', submitAdminWorkforceUpload);
  document.getElementById('wfDenialReasonForm').addEventListener('submit', saveWorkforceDenialReason);
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
    ['wfReviewModal', 'wfAdminUploadModal', 'wfDenialReasonModal'].includes(id) &&
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

function openFreelancerDirectory(mode = 'manage', department = '') {
  ensureWorkforceModals();
  workforcePageState.directoryMode = mode;
  workforcePageState.directoryDepartment = department;
  document.getElementById('wfFreelancerDirectoryModalTitle').textContent =
    mode === 'assign' ? `Add Freelancer to ${department}` : 'Manage Freelancers';
  document.getElementById('wfFreelancerSearch').value = '';
  renderFreelancerDirectory('');
  openWorkforceModal('wfFreelancerDirectoryModal');
}

function renderFreelancerDirectory(search) {
  const query = String(search || '').toLowerCase();
  const rows = (workforcePageState.data?.freelancers || []).filter(row =>
    `${row.name} ${row.phone || ''} ${row.email || ''} ${row.company || ''}`.toLowerCase().includes(query));
  document.getElementById('wfFreelancerDirectoryList').innerHTML = rows.map(row =>
    `<article class="wf-directory-row wf-directory-card" onclick="${workforcePageState.directoryMode === 'assign'
      ? `openFreelancerAssignment('${wfAttr(row.id)}','${wfAttr(workforcePageState.directoryDepartment)}')`
      : `openFreelancerHistory('${wfAttr(row.id)}')`}">
      <span class="wf-avatar">${wfEscape(wfInitials(row.name))}</span><span><strong>${wfEscape(row.name)}</strong>
      <small>${wfEscape(row.phone || 'No phone')} ${row.company ? `&middot; ${wfEscape(row.company)}` : ''}</small>
      <small class="wf-login-indicator ${row.workerLoginConfigured ? 'configured' : ''}">
        ${row.workerLoginConfigured ? 'Login set' : 'Setup required'}
      </small></span>
      ${workforcePageState.directoryMode === 'assign'
        ? '<span class="wf-directory-action">Select &rsaquo;</span>'
        : `<button class="wf-mini-button" type="button" onclick="event.stopPropagation();openFreelancerProfile('${wfAttr(row.id)}')">Edit</button>`}
      <small class="wf-last-login">Last login: ${row.workerLastLoginAt ? wfEscape(wfDateTime(row.workerLastLoginAt)) : 'Never'}</small>
    </article>`).join('') || '<div class="wf-empty">No matching freelancers.</div>';
}

function wfHistoryDisplayStatus(record) {
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

function wfDepartmentHue(code) {
  return [...String(code || 'General')].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) % 360,
    215
  );
}

function wfHistoryRoleRows(event, freelancerId) {
  const rows = event.roles || [];
  const roleRows = rows.map(row => `<span class="wf-worker-role-row">
    <span class="wf-department-role" style="--wf-dept-hue:${wfDepartmentHue(row.department)}">
      ${wfEscape(row.department || 'General')}
    </span>
    <span>${wfEscape(row.role || 'Freelancer')} · ${Number(row.days || 0)} day${Number(row.days || 0) === 1 ? '' : 's'}</span>
    <button type="button" title="Edit role"
      onclick="event.preventDefault();event.stopPropagation();openFreelancerWorkspaceAssignment(${Number(event.id)},'${wfAttr(freelancerId)}','${wfAttr(row.id)}')">Edit</button>
    <button type="button" class="danger" title="Remove role"
      onclick="event.preventDefault();event.stopPropagation();removeFreelancerWorkspaceAssignment(${Number(event.id)},'${wfAttr(freelancerId)}','${wfAttr(row.id)}')">&times;</button>
  </span>`).join('');
  return `${roleRows}<button class="wf-add-worker-role" type="button"
    onclick="event.preventDefault();event.stopPropagation();openFreelancerWorkspaceAssignment(${Number(event.id)},'${wfAttr(freelancerId)}')">+ Add role</button>`;
}

function wfHistoryEventCard(event, freelancerId) {
  const invoiceStatus = wfHistorySubmissionSummary(event.invoices || []);
  const claimStatus = wfHistorySubmissionSummary(event.claims || []);
  const dates = event.startDate === event.endDate
    ? event.startDate
    : `${event.startDate} – ${event.endDate}`;
  return `<details class="wf-history-event">
    <summary>
      <div class="wf-history-event-name"><strong>#${Number(event.id)} ${wfEscape(event.name)}</strong><span>${wfEscape(event.location || 'Location TBC')}</span></div>
      <div class="wf-history-event-date"><strong>${wfEscape(dates)}</strong><span class="wf-worker-role-list">${wfHistoryRoleRows(event, freelancerId)}</span></div>
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
  showSection('freelancer-workspace');
}

async function loadFreelancerWorkspace() {
  const root = document.getElementById('freelancer-workspace-root');
  if (!root) return;
  const id = workforcePageState.historyFreelancerId;
  if (!id) {
    root.innerHTML = `<div class="plan-page-heading"><h2>Freelancer Submissions</h2>
      <p>Select a freelancer from Manpower &amp; Transport to view their events.</p></div>
      <button class="wf-button" type="button" onclick="showSection('workforce')">&larr; Back to Manpower &amp; Transport</button>`;
    return;
  }
  root.innerHTML = '<div class="loading">Loading freelancer workspace…</div>';
  try {
    const response = await apiCall(`/api/workforce/freelancers/${encodeURIComponent(id)}/history`);
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
  const { company, freelancer, events } = data;
  const invoiceCount = events.reduce((total, item) => total + item.invoices.length, 0);
  const claimCount = events.reduce((total, item) => total + item.claims.length, 0);
  root.innerHTML = `<div class="plan-page-heading wf-freelancer-page-heading">
      <div><button class="wf-back" type="button" onclick="showSection('workforce')">&larr; Back to Manpower &amp; Transport</button>
        <h2>Freelancer Submissions</h2>
        <p>Review roles, invoices and claims for ${wfEscape(company?.name || 'this company')}.</p></div>
      <button class="wf-button" type="button" onclick="openFreelancerProfile('${wfAttr(freelancer.id)}')">Edit Freelancer</button>
    </div>
    <div class="plan-event-bar wf-worker-selector-bar">
      <button type="button" class="plan-event-select-wrap" onclick="openFreelancerWorkspaceSelector()">
        <span class="wf-avatar">${wfEscape(wfInitials(freelancer.name))}</span>
        <span class="wf-worker-selector-copy"><strong>${wfEscape(freelancer.name)}</strong>
          <small>${wfEscape(freelancer.phone || 'No phone')} · Last login: ${freelancer.workerLastLoginAt ? wfEscape(wfDateTime(freelancer.workerLastLoginAt)) : 'Never'}</small></span>
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
    wfHistoryEventCard(event, data.freelancer.id)
  ).join('') || '<div class="wf-empty">No matching events for this worker.</div>';
}

function openFreelancerWorkspaceSelector() {
  ensureWorkforceModals();
  const search = document.getElementById('wfWorkerSelectorSearch');
  search.value = '';
  renderFreelancerWorkspaceSelector('');
  openWorkforceModal('wfWorkerSelectorModal');
}

function renderFreelancerWorkspaceSelector(search = '') {
  const node = document.getElementById('wfWorkerSelectorList');
  const rows = workforcePageState.freelancerWorkspaceData?.freelancers ||
    workforcePageState.data?.freelancers || [];
  const query = String(search || '').trim().toLowerCase();
  if (!node) return;
  node.innerHTML = rows.filter(row =>
    `${row.name} ${row.phone || ''} ${row.email || ''} ${row.company || ''}`.toLowerCase().includes(query)
  ).map(row => `<button class="wf-directory-row wf-directory-card" type="button"
    onclick="selectFreelancerWorkspace('${wfAttr(row.id)}')">
    <span class="wf-avatar">${wfEscape(wfInitials(row.name))}</span>
    <span><strong>${wfEscape(row.name)}</strong><small>${wfEscape(row.phone || 'No phone')}</small></span>
    <span class="wf-directory-action">Select &rsaquo;</span>
  </button>`).join('') || '<div class="wf-empty">No matching freelancers.</div>';
}

function selectFreelancerWorkspace(id) {
  closeWorkforceModal('wfWorkerSelectorModal');
  workforcePageState.historyFreelancerId = id;
  workforcePageState.freelancerWorkspaceData = null;
  loadFreelancerWorkspace();
}

async function openFreelancerWorkspaceAssignment(eventId, freelancerId, assignmentId = '') {
  workforcePageState.freelancerWorkspaceReturnId = freelancerId;
  await loadFreelancerHistoryEvent(eventId);
  openFreelancerAssignment(freelancerId, '', assignmentId);
}

async function removeFreelancerWorkspaceAssignment(eventId, freelancerId, assignmentId) {
  try {
    await loadFreelancerHistoryEvent(eventId);
    await apiCall(
      `/api/events/${Number(eventId)}/workforce/assignments/${encodeURIComponent(assignmentId)}`,
      'DELETE'
    );
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
  document.getElementById('wfFreelancerProfileModalTitle').textContent = row ? 'Edit Freelancer' : 'Enroll New Freelancer';
  document.getElementById('wfFreelancerProfileForm').reset();
  document.getElementById('wfFreelancerName').value = row?.name || '';
  document.getElementById('wfFreelancerPhone').value = row?.phone || '';
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
    showNotification('success', 'Freelancer saved');
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
  document.getElementById('wfAssignmentDepartment').innerHTML = (workforcePageState.data.departments || [])
    .map(row => `<option value="${wfAttr(row.code)}" ${row.code === (assignment?.department || department) ? 'selected' : ''}>${wfEscape(row.name)} (${wfEscape(row.code)})</option>`).join('');
  document.getElementById('wfAssignmentRole').value = assignment?.roleName || '';
  document.getElementById('wfAssignmentRate').value = assignment?.dailyRate ?? '';
  const allDates = wfEventDateOptions();
  const selectedDates = new Set(
    assignment?.workDates?.length
      ? assignment.workDates
      : allDates.slice(0, Number(assignment?.days || 1))
  );
  document.getElementById('wfAssignmentDates').innerHTML = allDates.map(date =>
    `<label><input type="checkbox" value="${date}" ${selectedDates.has(date) ? 'checked' : ''}>
      <span>${new Date(`${date}T12:00:00`).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', weekday: 'short' })}</span></label>`
  ).join('');
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
    const workDates = [...document.querySelectorAll('#wfAssignmentDates input:checked')]
      .map(input => input.value);
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

async function deleteWorkforceAssignment(id) {
  const response = await apiCall(`/api/events/${workforcePageState.eventId}/workforce/assignments/${encodeURIComponent(id)}`, 'DELETE');
  workforcePageState.data = response.data;
  renderWorkforcePage();
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
  const freelancer = wfFindFreelancer(freelancerId);
  if (!freelancer) return;
  const claim = kind === 'claim';
  const form = document.getElementById('wfAdminUploadForm');
  form.reset();
  document.getElementById('wfAdminUploadFreelancerId').value = freelancerId;
  document.getElementById('wfAdminUploadKind').value = kind;
  document.getElementById('wfAdminUploadModalTitle').textContent = claim ? 'Upload Claim for Crew' : 'Upload Invoice for Crew';
  document.getElementById('wfAdminUploadSubtitle').textContent = freelancer.name;
  document.getElementById('wfAdminInvoiceFields').hidden = claim;
  document.getElementById('wfAdminClaimFields').hidden = !claim;
  const file = document.getElementById('wfAdminUploadFile');
  file.accept = claim ? '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg' : '.pdf,application/pdf';
  file.multiple = claim;
  document.getElementById('wfAdminUploadFileLabel').textContent = claim ? 'Claim files (PDF, PNG or JPG) *' : 'Invoice PDF *';
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
    `${row.vehicleType || ''} ${row.company || ''} ${row.driver || row.name || ''} ${row.vehicleNumber || ''}`.toLowerCase().includes(query));
  document.getElementById('wfTransportDirectoryList').innerHTML = rows.map(row =>
    `<div class="wf-directory-row"><button class="wf-directory-main" type="button" onclick="openTransportBooking('${wfAttr(row.id)}')">
      <span class="wf-avatar">🚚</span><span><strong>${wfEscape(row.vehicleType || 'Vehicle')} &middot; ${wfEscape(row.vehicleNumber || '')}</strong>
      <small>${wfEscape(row.company || '')} &middot; ${wfEscape(row.driver || row.name || '')} &middot; ${wfEscape(row.contactNumber || '')}</small></span></button>
      <button class="wf-button" type="button" onclick="openTransportProfile('${wfAttr(row.id)}')">Edit</button></div>`).join('') ||
      '<div class="wf-empty">No saved transport profiles. Add one to begin.</div>';
}

function openTransportProfile(id = '') {
  ensureWorkforceModals();
  const row = workforcePageState.data.transportVendors.find(item => String(item.id) === String(id));
  workforcePageState.editingTransportProfileId = row?.id || null;
  document.getElementById('wfTransportProfileForm').reset();
  document.getElementById('wfTransportProfileModalTitle').textContent = row ? 'Edit Transport' : 'Add New Transport';
  document.getElementById('wfProfileVehicleType').value = row?.vehicleType || '';
  document.getElementById('wfProfileCompany').value = row?.company || '';
  document.getElementById('wfProfileDriver').value = row?.driver || row?.name || '';
  document.getElementById('wfProfileContact').value = row?.contactNumber || '';
  document.getElementById('wfProfileVehicleNumber').value = row?.vehicleNumber || '';
  wfError('wfTransportProfileError');
  openWorkforceModal('wfTransportProfileModal');
}

async function saveTransportProfile(event) {
  event.preventDefault();
  const id = workforcePageState.editingTransportProfileId;
  try {
    await apiCall(id ? `/api/workforce/transport-profiles/${encodeURIComponent(id)}` : '/api/workforce/transport-profiles', id ? 'PUT' : 'POST', {
      vehicleType: document.getElementById('wfProfileVehicleType').value,
      company: document.getElementById('wfProfileCompany').value,
      driver: document.getElementById('wfProfileDriver').value,
      contactNumber: document.getElementById('wfProfileContact').value,
      vehicleNumber: document.getElementById('wfProfileVehicleNumber').value
    });
    await refreshWorkforcePage();
    closeWorkforceModal('wfTransportProfileModal');
    renderTransportDirectory('');
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

function openTransportBooking(profileId, bookingId = '') {
  ensureWorkforceModals();
  const profile = workforcePageState.data.transportVendors.find(row => String(row.id) === String(profileId));
  const booking = workforcePageState.data.transportBookings.find(row => String(row.id) === String(bookingId));
  if (!profile) return;
  workforcePageState.selectedTransportProfileId = profile.id;
  workforcePageState.editingTransportId = booking?.id || null;
  document.getElementById('wfTransportBookingForm').reset();
  document.getElementById('wfTransportBookingModalTitle').textContent = booking ? 'Edit Event Transport' : 'Add Transport to Event';
  document.getElementById('wfBookingVehicle').textContent =
    `${profile.vehicleType} · ${profile.vehicleNumber} · ${profile.company} / ${profile.driver || profile.name}`;
  document.getElementById('wfSavedLocations').innerHTML = (workforcePageState.data.transportLocations || [])
    .map(row => `<option value="${wfAttr(row.address ? `${row.name} (${row.address})` : row.name)}"></option>`).join('');
  document.getElementById('wfLocationFrom').value = booking?.locationFrom || '';
  document.getElementById('wfLocationTo').value = booking?.locationTo || '';
  document.getElementById('wfDepartDate').value =
    booking?.departDate || workforcePageState.data.event.startDateValue || '';
  document.getElementById('wfDepartTime').value = booking?.departTime || '';
  document.getElementById('wfTransportCost').value = booking?.cost ?? 0;
  document.getElementById('wfTransportTwoWay').checked = Boolean(booking?.twoWay);
  document.getElementById('wfReturnDate').value =
    booking?.returnDate || workforcePageState.data.event.endDateValue || '';
  document.getElementById('wfReturnTime').value = booking?.returnTime || '';
  syncReturnFields();
  wfError('wfTransportBookingError');
  closeWorkforceModal('wfTransportDirectoryModal');
  openWorkforceModal('wfTransportBookingModal');
}

function syncReturnFields() {
  const enabled = document.getElementById('wfTransportTwoWay').checked;
  document.getElementById('wfReturnFields').hidden = !enabled;
  document.getElementById('wfReturnDate').required = enabled;
  document.getElementById('wfReturnTime').required = enabled;
}

async function saveTransportBooking(event) {
  event.preventDefault();
  const id = workforcePageState.editingTransportId;
  const currentBooking = workforcePageState.data.transportBookings
    .find(row => String(row.id) === String(id));
  try {
    const response = await apiCall(id
      ? `/api/events/${workforcePageState.eventId}/workforce/transport/${encodeURIComponent(id)}`
      : `/api/events/${workforcePageState.eventId}/workforce/transport`, id ? 'PUT' : 'POST', {
      vendorId: workforcePageState.selectedTransportProfileId,
      locationFrom: document.getElementById('wfLocationFrom').value,
      locationTo: document.getElementById('wfLocationTo').value,
      saveLocations: document.getElementById('wfSaveBookingLocations').checked,
      departDate: document.getElementById('wfDepartDate').value,
      departTime: document.getElementById('wfDepartTime').value,
      cost: document.getElementById('wfTransportCost').value,
      twoWay: document.getElementById('wfTransportTwoWay').checked,
      returnDate: document.getElementById('wfReturnDate').value,
      returnTime: document.getElementById('wfReturnTime').value,
      status: currentBooking?.status || 'Pending Review'
    });
    workforcePageState.data = response.data;
    closeWorkforceModal('wfTransportBookingModal');
    renderWorkforcePage();
    showNotification('success', 'Transport added to event');
  } catch (error) {
    wfError('wfTransportBookingError', error.message);
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
    workforcePageState.data = response.data;
    renderWorkforcePage();
    return true;
  } catch (error) {
    showNotification('error', error.message);
    return false;
  }
}

function openWorkforceDenialReason(id) {
  ensureWorkforceModals();
  const found = wfFindSubmission(id);
  if (!found) return;
  workforcePageState.denialSubmissionId = id;
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
    const saved = await applyWorkforceStatus(
      id,
      'Denied',
      document.getElementById('wfDenialReason').value
    );
    if (saved) closeWorkforceModal('wfDenialReasonModal');
  } catch (error) {
    wfError('wfDenialReasonError', error.message);
  } finally {
    button.disabled = false;
  }
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

async function openWorkforceReview(id, requestedStatus = '', skipOcrRetry = false) {
  ensureWorkforceModals();
  let found = wfFindSubmission(id);
  if (!found) return;
  if (found.record.processingState === 'Processing') {
    showNotification('info', 'This file is still being processed. It will update automatically.');
    return;
  }
  if (found.record.submissionStage === 'Details Required') {
    showNotification('info', 'The worker still needs to complete this claim’s details.');
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
  const freelancer = wfFindFreelancer(freelancerId) || {};
  const departments = wfDepartmentsForFreelancer(freelancerId);
  const verified = Boolean(record.verifiedAt);
  const savedAllocations = record.allocations || [];
  workforcePageState.autoAllocation =
    kind === 'invoice' && !savedAllocations.length && !verified;
  const allocations = savedAllocations.length
    ? Object.fromEntries(savedAllocations.map(row => [row.department, row.amount]))
    : wfEvenAllocationMap(departments, record.amount);
  const pdf = record.contentType === 'application/pdf';
  const selectedStatus = requestedStatus || '';
  document.getElementById('wfReviewModalTitle').textContent =
    `${verified ? 'View' : 'Review'} ${kind === 'invoice' ? 'Invoice' : 'Claim'}`;
  document.getElementById('wfReviewContent').innerHTML = `<div class="wf-review-layout">
    <div class="wf-preview">${pdf ? `<iframe src="${wfAttr(record.previewUrl)}#toolbar=1" title="Uploaded PDF"></iframe>`
      : `<img src="${wfAttr(record.previewUrl)}" alt="Uploaded claim">`}</div>
    <form class="wf-review-form" id="wfReviewForm"><p class="wf-form-intro">${wfEscape(freelancer.name || '')} &middot; ${wfEscape(record.originalName || '')}</p>
      ${kind === 'invoice' ? `<div class="wf-ocr-card"><strong>Detected total: ${record.amount == null ? 'Needs verification' : wfMoney(record.amount)}</strong><br>
        Confidence: ${wfEscape(record.ocrConfidence || 'Low')} &middot; ${wfEscape(record.ocrSource || 'No extractor result')}</div>`
        : `<div class="wf-ocr-card">${wfEscape(record.category || 'Claim')} &middot; ${wfEscape(record.claimDate || '')}<br>${wfEscape(record.description || '')}</div>`}
      ${verified ? `<div class="wf-verified-note">Amount and submission details were verified on ${wfEscape(wfDateTime(record.verifiedAt))}.</div>` : ''}
      <div class="wf-form-grid">
        <label class="wf-field"><span>Verified amount (SGD) *</span><input id="wfReviewAmount" type="number" min="0" step=".01" value="${record.amount ?? ''}" required ${verified ? 'disabled' : ''}></label>
        ${verified
          ? `<div class="wf-field"><span>Status</span><strong class="wf-readonly-status ${wfStatusClass(record.paymentConfirmedAt ? 'Payment Confirmed' : record.status)}">${wfEscape(record.paymentConfirmedAt ? 'Payment Confirmed' : record.status)}</strong></div>`
          : `<div class="wf-field"><span>Status *</span>${wfReviewStatusPicker(selectedStatus)}</div>`}
        ${!verified ? `<label class="wf-field full" id="wfReviewDenialReasonField" ${selectedStatus === 'Denied' ? '' : 'hidden'}>
          <span>Denial reason (optional)</span><textarea id="wfReviewDenialReason">${wfEscape(record.denialReason || '')}</textarea></label>` : ''}
      </div>
      ${kind === 'invoice' ? `<div class="wf-section-card"><h4>Department allocation</h4>
        ${departments.map(code => `<label class="wf-allocation-row"><span>${wfEscape(code)}</span>
          <input class="wf-allocation-input" data-department="${wfAttr(code)}" type="number" min="0" step=".01" value="${allocations[code] ?? ''}" ${verified ? 'disabled' : ''}></label>`).join('')}
        <div class="wf-allocation-progress" id="wfAllocationProgress"></div></div>` : ''}
      ${verified && record.status === 'Denied' ? `<div class="wf-denial-summary"><strong>Denial reason</strong><span>${wfEscape(record.denialReason || 'No reason was provided.')}</span></div>` : ''}
      <div class="wf-error" id="wfReviewError"></div>
    </form></div>
    <footer class="wf-review-actions"><button class="wf-button danger" type="button" onclick="deleteWorkforceSubmission('${wfAttr(id)}',true)">Delete Upload</button>
      <a class="wf-button" href="${wfAttr(record.downloadUrl)}">Download File</a>
      ${verified ? '' : '<button class="wf-button primary" type="button" onclick="saveWorkforceReview()">Confirm Review</button>'}</footer>`;
  document.querySelectorAll('.wf-allocation-input').forEach(input => input.addEventListener('input', () => {
    workforcePageState.autoAllocation = false;
    updateAllocationProgress();
  }));
  document.getElementById('wfReviewAmount')?.addEventListener('input', () => {
    applyDefaultReviewAllocations();
    updateAllocationProgress();
  });
  syncWorkforceReviewDenialField();
  updateAllocationProgress();
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

async function saveWorkforceReview() {
  const found = wfFindSubmission(workforcePageState.reviewSubmissionId);
  if (!found) return;
  const allocations = [...document.querySelectorAll('.wf-allocation-input')]
    .map(input => ({ department: input.dataset.department, amount: input.value }))
    .filter(row => Number(row.amount || 0) > 0);
  try {
    const reviewStatus = document.getElementById('wfReviewStatus')?.value || '';
    if (!reviewStatus) {
      wfError('wfReviewError', 'Select Pending Review, Approved or Denied.');
      return;
    }
    const response = await apiCall(`/api/workforce/submissions/${encodeURIComponent(found.record.id)}`, 'PUT', {
      amount: document.getElementById('wfReviewAmount').value,
      status: reviewStatus,
      denialReason: document.getElementById('wfReviewDenialReason').value,
      allocations,
      confirmReview: true,
      clearPaymentConfirmation: Boolean(found.record.paymentConfirmedAt)
    });
    workforcePageState.data = response.data;
    closeWorkforceModal('wfReviewModal');
    renderWorkforcePage();
  } catch (error) {
    wfError('wfReviewError', error.message);
  }
}

async function deleteWorkforceSubmission(id, fromReview = false) {
  const response = await apiCall(`/api/workforce/submissions/${encodeURIComponent(id)}`, 'DELETE');
  workforcePageState.data = response.data;
  if (fromReview) closeWorkforceModal('wfReviewModal');
  renderWorkforcePage();
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
