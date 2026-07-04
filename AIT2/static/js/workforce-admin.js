const workforcePageState = {
  eventId: null,
  eventOptions: [],
  data: null,
  loading: false,
  reviewSubmissionId: null,
  editingFreelancerId: null,
  selectedFreelancerId: null,
  directoryMode: 'manage',
  directoryDepartment: '',
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
  return `<div class="wf-status-control">
    <button class="wf-status-button ${wfStatusClass(record.status)}" type="button"
      onclick="toggleWorkforceStatusMenu(event,'${wfAttr(record.id)}')">
      ${wfEscape(record.status || 'Pending Review')} <span>&#9662;</span>
    </button>
    <div class="wf-status-menu" id="wfStatusMenu-${wfAttr(record.id)}">
      ${['Pending Review', 'Approved', 'Denied', 'Paid'].map(status =>
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
    ${wfEscape(row.roleName)} &middot; ${row.days} day${Number(row.days) === 1 ? '' : 's'} &middot; ${wfMoney(row.dailyRate)}/day
    <button type="button" title="Remove role" onclick="deleteWorkforceAssignment('${wfAttr(row.id)}')">&times;</button>
  </span>`).join('');
  return `<article class="wf-worker">
    <div class="wf-worker-identity"><div class="wf-worker-profile">
      <span class="wf-avatar">${wfEscape(wfInitials(freelancer.name))}</span>
      <div><strong>${wfEscape(freelancer.name)}</strong>
        <small>${wfEscape(freelancer.phone || 'No portal phone number')}</small></div>
    </div></div>
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
  return `<details class="wf-department" data-department="${wfAttr(department)}" ${index === 0 ? 'open' : ''}>
    <summary><span class="wf-department-title">${wfEscape(department)} <small>(${count})</small></span>
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
  return `<article class="wf-transport-card wf-trip-card ${isReturn ? 'return-trip' : 'depart-trip'}">
    <div class="wf-transport-heading">
      <div>
        <span class="wf-trip-direction">${directionLabel}</span>
        <h4>${wfEscape(booking.vehicleType || 'Transport')}${booking.vehicleNumber ? ` &middot; ${wfEscape(booking.vehicleNumber)}` : ''}</h4>
        <small>${wfEscape(booking.company || '')}${booking.driver || booking.companyDriver
          ? ` &middot; ${wfEscape(booking.driver || booking.companyDriver)}`
          : ''}</small>
      </div>
    </div>
    <div class="wf-transport-meta">
      <div><span>Contact</span><strong>${wfEscape(booking.contactNumber || '—')}</strong></div>
      <div class="wf-route"><span>Route</span><strong>${wfEscape(routeFrom || '—')} &rarr; ${wfEscape(routeTo || '—')}</strong></div>
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
        <div><span>Combined</span><strong>${wfMoney(totals.combined)}</strong></div>
        <div><span>With transport</span><strong>${wfMoney(grand)}</strong></div>
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
              <div class="plan-metric-icon">${planMetricIconSvg('lines')}</div>
              <div><strong>${wfMoney(totals.invoice)}</strong><span>Invoices</span></div>
            </div>
            <div class="plan-metric">
              <div class="plan-metric-icon">${planMetricIconSvg('quantity')}</div>
              <div><strong>${wfMoney(totals.claims)}</strong><span>Claims</span></div>
            </div>
            <div class="plan-metric">
              <div class="plan-metric-icon">${planMetricIconSvg('departments')}</div>
              <div><strong>${wfMoney(totals.combined)}</strong><span>Combined</span></div>
            </div>
            <div class="plan-metric">
              <div class="plan-metric-icon">${planMetricIconSvg('templates')}</div>
              <div><strong>${wfMoney(grand)}</strong><span>With Transport</span></div>
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
      <div class="wf-directory-list" id="wfFreelancerDirectoryList"></div></div>`, '', true) +
    wfModal('wfFreelancerProfileModal', 'Enroll New Freelancer', `<form id="wfFreelancerProfileForm">
      <div class="wf-modal-body"><div class="wf-form-grid">
        <label class="wf-field full"><span>Full name *</span><input id="wfFreelancerName" required maxlength="120"></label>
        <label class="wf-field"><span>Phone number</span><input id="wfFreelancerPhone" type="tel"></label>
        <label class="wf-field"><span>Email</span><input id="wfFreelancerEmail" type="email"></label>
        <label class="wf-field"><span>Company</span><input id="wfFreelancerCompany"></label>
        <label class="wf-field full"><span>Notes</span><textarea id="wfFreelancerNotes"></textarea></label>
        <label class="wf-check full"><input id="wfFreelancerActive" type="checkbox" checked> Active profile</label>
      </div><div class="wf-error" id="wfFreelancerProfileError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfFreelancerProfileModal')">Cancel</button>
        <button class="wf-button primary" type="submit">Save Freelancer</button></footer></form>`) +
    wfModal('wfAssignmentModal', 'Event Assignment', `<form id="wfAssignmentForm">
      <div class="wf-modal-body"><p class="wf-form-intro" id="wfAssignmentFreelancerName"></p><div class="wf-form-grid">
        <label class="wf-field"><span>Department *</span><select id="wfAssignmentDepartment" required></select></label>
        <label class="wf-field"><span>Role / Position *</span><input id="wfAssignmentRole" required maxlength="100"></label>
        <label class="wf-field"><span>Number of days *</span><input id="wfAssignmentDays" type="number" min="1" step="1" value="1" required></label>
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
      <div class="wf-directory-list" id="wfTransportDirectoryList"></div></div>`, '', true) +
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
      <form class="wf-inline-form" id="wfLocationForm"><input class="wf-search" id="wfLocationName" placeholder="Add a saved location" required>
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
        <div id="wfAdminClaimFields" hidden><div class="wf-form-grid">
          <label class="wf-field"><span>Amount (SGD) *</span><input id="wfAdminClaimAmount" name="amount" type="number" min="0" step=".01"></label>
          <label class="wf-field"><span>Claim date *</span><input id="wfAdminClaimDate" name="claimDate" type="date"></label>
          <label class="wf-field"><span>Category *</span><select id="wfAdminClaimCategory" name="category" onchange="syncAdminClaimCategory()"><option>Cab</option><option>Parking</option><option>Meal</option><option>Other</option></select></label>
          <label class="wf-field" id="wfAdminOtherCategoryField" hidden><span>Other category *</span><input id="wfAdminOtherCategory" name="otherCategory"></label>
          <label class="wf-field full"><span>Department *</span><select id="wfAdminClaimDepartment" name="department"></select></label>
          <label class="wf-field full"><span>Description *</span><textarea id="wfAdminClaimDescription" name="description"></textarea></label>
        </div></div>
        <label class="wf-field"><span id="wfAdminUploadFileLabel">Invoice PDF *</span><input id="wfAdminUploadFile" name="file" type="file" required></label>
        <div class="wf-error" id="wfAdminUploadError"></div></div>
      <footer class="wf-modal-actions"><button class="wf-button" type="button" onclick="closeWorkforceModal('wfAdminUploadModal')">Cancel</button>
        <button class="wf-button primary" type="submit">Upload File</button></footer></form>`) +
    wfModal('wfReviewModal', 'Review Submission', `<div id="wfReviewContent"></div>`, '', true)
  );
  document.getElementById('wfFreelancerProfileForm').addEventListener('submit', saveFreelancerProfile);
  document.getElementById('wfAssignmentForm').addEventListener('submit', saveFreelancerAssignment);
  document.getElementById('wfDepartmentForm').addEventListener('submit', saveManualDepartment);
  document.getElementById('wfTransportProfileForm').addEventListener('submit', saveTransportProfile);
  document.getElementById('wfLocationForm').addEventListener('submit', saveTransportLocation);
  document.getElementById('wfTransportBookingForm').addEventListener('submit', saveTransportBooking);
  document.getElementById('wfAdminUploadForm').addEventListener('submit', submitAdminWorkforceUpload);
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
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
  if (!document.querySelector('.wf-modal.open')) document.body.style.overflow = '';
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
    `<button class="wf-directory-row" type="button" onclick="${workforcePageState.directoryMode === 'assign'
      ? `openFreelancerAssignment('${wfAttr(row.id)}','${wfAttr(workforcePageState.directoryDepartment)}')`
      : `openFreelancerProfile('${wfAttr(row.id)}')`}">
      <span class="wf-avatar">${wfEscape(wfInitials(row.name))}</span><span><strong>${wfEscape(row.name)}</strong>
      <small>${wfEscape(row.phone || 'No phone')} ${row.company ? `&middot; ${wfEscape(row.company)}` : ''}</small></span>
      <span class="wf-directory-action">${workforcePageState.directoryMode === 'assign' ? 'Select' : 'Edit'} &rsaquo;</span>
    </button>`).join('') || '<div class="wf-empty">No matching freelancers.</div>';
}

function openFreelancerProfile(id = '') {
  ensureWorkforceModals();
  const row = wfFindFreelancer(id);
  workforcePageState.editingFreelancerId = row?.id || null;
  document.getElementById('wfFreelancerProfileModalTitle').textContent = row ? 'Edit Freelancer' : 'Enroll New Freelancer';
  document.getElementById('wfFreelancerProfileForm').reset();
  document.getElementById('wfFreelancerName').value = row?.name || '';
  document.getElementById('wfFreelancerPhone').value = row?.phone || '';
  document.getElementById('wfFreelancerEmail').value = row?.email || '';
  document.getElementById('wfFreelancerCompany').value = row?.company || '';
  document.getElementById('wfFreelancerNotes').value = row?.notes || '';
  document.getElementById('wfFreelancerActive').checked = row?.active !== false;
  wfError('wfFreelancerProfileError');
  openWorkforceModal('wfFreelancerProfileModal');
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
  } catch (error) {
    wfError('wfFreelancerProfileError', error.message);
  }
}

function openFreelancerAssignment(freelancerId, department = '') {
  ensureWorkforceModals();
  const freelancer = wfFindFreelancer(freelancerId);
  if (!freelancer) return;
  workforcePageState.selectedFreelancerId = freelancerId;
  document.getElementById('wfAssignmentForm').reset();
  document.getElementById('wfAssignmentFreelancerName').textContent = freelancer.name;
  document.getElementById('wfAssignmentDepartment').innerHTML = (workforcePageState.data.departments || [])
    .map(row => `<option value="${wfAttr(row.code)}" ${row.code === department ? 'selected' : ''}>${wfEscape(row.name)} (${wfEscape(row.code)})</option>`).join('');
  document.getElementById('wfAssignmentDays').value = 1;
  wfError('wfAssignmentError');
  closeWorkforceModal('wfFreelancerDirectoryModal');
  openWorkforceModal('wfAssignmentModal');
}

async function saveFreelancerAssignment(event) {
  event.preventDefault();
  try {
    const response = await apiCall(`/api/events/${workforcePageState.eventId}/workforce/assignments`, 'POST', {
      freelancerId: workforcePageState.selectedFreelancerId,
      department: document.getElementById('wfAssignmentDepartment').value,
      customRole: document.getElementById('wfAssignmentRole').value,
      saveRole: false,
      days: document.getElementById('wfAssignmentDays').value,
      dailyRate: document.getElementById('wfAssignmentRate').value
    });
    workforcePageState.data = response.data;
    closeWorkforceModal('wfAssignmentModal');
    renderWorkforcePage();
    showNotification('success', 'Event assignment added');
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
  for (const id of ['wfAdminClaimAmount', 'wfAdminClaimDate', 'wfAdminClaimCategory', 'wfAdminOtherCategory', 'wfAdminClaimDepartment', 'wfAdminClaimDescription']) {
    document.getElementById(id).disabled = !claim;
  }
  document.getElementById('wfAdminClaimAmount').required = claim;
  document.getElementById('wfAdminClaimDate').required = claim;
  document.getElementById('wfAdminClaimDescription').required = claim;
  document.getElementById('wfAdminClaimDepartment').innerHTML = wfDepartmentsForFreelancer(freelancerId)
    .map(code => `<option>${wfEscape(code)}</option>`).join('');
  if (claim) document.getElementById('wfAdminClaimDate').value = new Date().toISOString().slice(0, 10);
  const file = document.getElementById('wfAdminUploadFile');
  file.accept = claim ? '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg' : '.pdf,application/pdf';
  document.getElementById('wfAdminUploadFileLabel').textContent = claim ? 'Claim file (PDF, PNG or JPG) *' : 'Invoice PDF *';
  syncAdminClaimCategory();
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
  try {
    const response = await apiCall(`/api/events/${workforcePageState.eventId}/workforce/submissions/${encodeURIComponent(id)}`, 'POST', new FormData(event.currentTarget));
    workforcePageState.data = response.data;
    closeWorkforceModal('wfAdminUploadModal');
    renderWorkforcePage();
    showNotification('success', 'Crew upload added');
  } catch (error) {
    wfError('wfAdminUploadError', error.message);
  }
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
    `<div class="wf-directory-row"><span><strong>${wfEscape(row.name)}</strong></span>
      <button class="wf-button danger" type="button" onclick="deleteTransportLocation('${wfAttr(row.id)}')">Remove</button></div>`).join('') ||
      '<div class="wf-empty">No saved locations yet.</div>';
}

async function saveTransportLocation(event) {
  event.preventDefault();
  try {
    await apiCall('/api/workforce/transport-locations', 'POST', { name: document.getElementById('wfLocationName').value });
    document.getElementById('wfLocationName').value = '';
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
    .map(row => `<option value="${wfAttr(row.name)}"></option>`).join('');
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
  if (!found || found.record.status === status) return;
  if (!found.record.verifiedAt && status === 'Approved') {
    openWorkforceReview(id, 'Approved');
    return;
  }
  if (!found.record.verifiedAt && status === 'Paid') {
    openWorkforceReview(id, 'Approved');
    showNotification('info', 'Verify and approve this upload before marking it paid');
    return;
  }
  try {
    const response = await apiCall(`/api/workforce/submissions/${encodeURIComponent(id)}`, 'PUT', {
      status,
      amount: found.record.amount,
      allocations: found.record.allocations || [],
      department: found.record.department || ''
    });
    workforcePageState.data = response.data;
    renderWorkforcePage();
  } catch (error) {
    showNotification('error', error.message);
  }
}

async function openWorkforceReview(id, requestedStatus = '', skipOcrRetry = false) {
  ensureWorkforceModals();
  let found = wfFindSubmission(id);
  if (!found) return;
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
  const allocations = Object.fromEntries((record.allocations || []).map(row => [row.department, row.amount]));
  const pdf = record.contentType === 'application/pdf';
  document.getElementById('wfReviewModalTitle').textContent = `Review ${kind === 'invoice' ? 'Invoice' : 'Claim'}`;
  document.getElementById('wfReviewContent').innerHTML = `<div class="wf-review-layout">
    <div class="wf-preview">${pdf ? `<iframe src="${wfAttr(record.previewUrl)}#toolbar=1" title="Uploaded PDF"></iframe>`
      : `<img src="${wfAttr(record.previewUrl)}" alt="Uploaded claim">`}</div>
    <form class="wf-review-form" id="wfReviewForm"><p class="wf-form-intro">${wfEscape(freelancer.name || '')} &middot; ${wfEscape(record.originalName || '')}</p>
      ${kind === 'invoice' ? `<div class="wf-ocr-card"><strong>Detected total: ${record.amount == null ? 'Needs verification' : wfMoney(record.amount)}</strong><br>
        Confidence: ${wfEscape(record.ocrConfidence || 'Low')} &middot; ${wfEscape(record.ocrSource || 'No extractor result')}</div>`
        : `<div class="wf-ocr-card">${wfEscape(record.category || 'Claim')} &middot; ${wfEscape(record.claimDate || '')}<br>${wfEscape(record.description || '')}</div>`}
      <div class="wf-form-grid">
        <label class="wf-field"><span>Verified amount (SGD) *</span><input id="wfReviewAmount" type="number" min="0" step=".01" value="${record.amount ?? ''}" required></label>
        <label class="wf-field"><span>Status</span><select id="wfReviewStatus">${wfStatusOptions(requestedStatus || record.status)}</select></label>
        ${kind === 'claim' ? `<label class="wf-field full"><span>Department</span><select id="wfReviewDepartment">
          ${departments.map(code => `<option ${code === record.department ? 'selected' : ''}>${wfEscape(code)}</option>`).join('')}</select></label>` : ''}
        <label class="wf-field full"><span>Denial reason (optional)</span><textarea id="wfReviewDenialReason">${wfEscape(record.denialReason || '')}</textarea></label>
      </div>
      ${kind === 'invoice' ? `<div class="wf-section-card"><h4>Department allocation</h4>
        ${departments.map(code => `<label class="wf-allocation-row"><span>${wfEscape(code)}</span>
          <input class="wf-allocation-input" data-department="${wfAttr(code)}" type="number" min="0" step=".01" value="${allocations[code] ?? ''}"></label>`).join('')}
        <div class="wf-allocation-progress" id="wfAllocationProgress"></div></div>` : ''}
      <div class="wf-error" id="wfReviewError"></div>
    </form></div>
    <footer class="wf-review-actions"><button class="wf-button danger" type="button" onclick="deleteWorkforceSubmission('${wfAttr(id)}',true)">Delete Upload</button>
      <a class="wf-button" href="${wfAttr(record.downloadUrl)}">Download File</a>
      <button class="wf-button primary" type="button" onclick="saveWorkforceReview()">Save Review</button></footer>`;
  document.querySelectorAll('.wf-allocation-input').forEach(input => input.addEventListener('input', updateAllocationProgress));
  document.getElementById('wfReviewAmount')?.addEventListener('input', updateAllocationProgress);
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
    const response = await apiCall(`/api/workforce/submissions/${encodeURIComponent(found.record.id)}`, 'PUT', {
      amount: document.getElementById('wfReviewAmount').value,
      status: document.getElementById('wfReviewStatus').value,
      denialReason: document.getElementById('wfReviewDenialReason').value,
      department: document.getElementById('wfReviewDepartment')?.value || found.record.department || '',
      allocations
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
