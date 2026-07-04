const workforcePageState = {
  eventId: null,
  data: null,
  loading: false,
  reviewSubmissionId: null,
  editingTransportId: null
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
  const number = Number(value || 0);
  return `SGD ${number.toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function wfInitials(name) {
  return String(name || 'FW')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0].toUpperCase())
    .join('') || 'FW';
}

function wfStatusClass(status) {
  return `status-${String(status || 'Pending Review').toLowerCase().replace(/\s+/g, '-')}`;
}

function wfStatusOptions(current) {
  return ['Pending Review', 'Approved', 'Denied', 'Paid']
    .map(status => `<option value="${status}" ${status === current ? 'selected' : ''}>${status}</option>`)
    .join('');
}

function wfFormatDateTime(value) {
  if (!value) return '—';
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

function wfFindFreelancer(id) {
  return workforcePageState.data?.freelancers?.find(row => String(row.id) === String(id));
}

function wfFindSubmission(id) {
  const submissions = workforcePageState.data?.submissions || {};
  for (const [freelancerId, rows] of Object.entries(submissions)) {
    for (const kind of ['invoices', 'claims']) {
      const record = rows?.[kind]?.find(row => String(row.id) === String(id));
      if (record) return { record, freelancerId, kind: kind.slice(0, -1) };
    }
  }
  return null;
}

function wfAssignmentsForFreelancer(freelancerId) {
  return (workforcePageState.data?.assignments || []).filter(
    row => String(row.freelancerId) === String(freelancerId)
  );
}

function wfDepartmentsForFreelancer(freelancerId) {
  return [...new Set(
    wfAssignmentsForFreelancer(freelancerId)
      .map(row => row.department)
      .filter(Boolean)
  )];
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
  if (!root || !workforcePageState.eventId || workforcePageState.loading) return;
  workforcePageState.loading = true;
  if (!workforcePageState.data) {
    root.innerHTML = '<div class="loading">Loading manpower and transport...</div>';
  }
  try {
    const response = await apiCall(`/api/events/${workforcePageState.eventId}/workforce`);
    workforcePageState.data = response.data;
    renderWorkforcePage();
  } catch (error) {
    root.innerHTML = `
      <div class="wf-panel" style="padding:24px;">
        <h3>Manpower and transport could not be loaded</h3>
        <p>${wfEscape(error.message)}</p>
        <button class="wf-button primary" type="button" onclick="loadWorkforcePage()">Try again</button>
      </div>
    `;
  } finally {
    workforcePageState.loading = false;
  }
}

function wfSubmissionRow(record, kind) {
  const amount = record.amount == null ? 'Amount to verify' : wfMoney(record.amount);
  return `
    <div class="wf-file-row">
      <button class="wf-file-name" type="button" onclick="openWorkforceReview('${wfAttr(record.id)}')" title="${wfAttr(record.originalName)}">
        ${wfEscape(record.originalName || `${kind} upload`)}
      </button>
      <span class="wf-file-amount">${wfEscape(amount)}</span>
      <select
        class="wf-status-select ${wfStatusClass(record.status)}"
        aria-label="Change ${wfAttr(kind)} status"
        data-current-status="${wfAttr(record.status)}"
        onchange="quickWorkforceStatusChange('${wfAttr(record.id)}', this)"
      >${wfStatusOptions(record.status)}</select>
      <button class="wf-icon-button danger" type="button" title="Delete upload" onclick="deleteWorkforceSubmission('${wfAttr(record.id)}')">×</button>
    </div>
  `;
}

function wfWorkerHtml(freelancerId, assignments) {
  const freelancer = wfFindFreelancer(freelancerId) || { id: freelancerId, name: 'Unknown freelancer' };
  const rows = workforcePageState.data.submissions?.[freelancerId] || { invoices: [], claims: [] };
  const assignmentChips = assignments.map(assignment => `
    <span class="wf-assignment-chip">
      ${wfEscape(assignment.roleName)} · ${assignment.days} day${Number(assignment.days) === 1 ? '' : 's'} · ${wfMoney(assignment.dailyRate)}/day
      <button type="button" aria-label="Remove assignment" title="Remove assignment" onclick="deleteWorkforceAssignment('${wfAttr(assignment.id)}')">×</button>
    </span>
  `).join('');
  return `
    <article class="wf-worker">
      <div class="wf-worker-heading">
        <div class="wf-worker-profile">
          <span class="wf-avatar">${wfEscape(wfInitials(freelancer.name))}</span>
          <div>
            <strong>${wfEscape(freelancer.name)}</strong>
            <small>${wfEscape(freelancer.phone || 'No portal phone number')}</small>
          </div>
        </div>
        <button class="wf-link-button" type="button" onclick="openWorkforceFreelancerModal('${wfAttr(freelancer.id)}')">+ Add another assignment</button>
      </div>
      <div class="wf-assignment-list">${assignmentChips}</div>
      <div class="wf-submission-grid">
        <section class="wf-submission-box">
          <header><span>Invoice · one active PDF</span><span>${rows.invoices?.length || 0}</span></header>
          ${rows.invoices?.length
            ? rows.invoices.map(row => wfSubmissionRow(row, 'invoice')).join('')
            : '<div class="wf-empty">No invoice submitted.</div>'}
        </section>
        <section class="wf-submission-box">
          <header><span>Claims · up to five active files</span><span>${rows.claims?.length || 0}</span></header>
          ${rows.claims?.length
            ? rows.claims.map(row => wfSubmissionRow(row, 'claim')).join('')
            : '<div class="wf-empty">No claims submitted.</div>'}
        </section>
      </div>
    </article>
  `;
}

function wfDepartmentHtml(department, assignments, index) {
  const totals = workforcePageState.data.totals?.departments?.[department] || {
    invoice: 0,
    claims: 0,
    combined: 0
  };
  const byWorker = {};
  assignments.forEach(assignment => {
    (byWorker[assignment.freelancerId] ||= []).push(assignment);
  });
  return `
    <details class="wf-department" ${index === 0 ? 'open' : ''}>
      <summary>
        <span class="wf-department-title">${wfEscape(department)} <small>(${Object.keys(byWorker).length})</small></span>
        <span class="wf-dept-total"><span>Invoice total</span><strong>${wfMoney(totals.invoice)}</strong></span>
        <span class="wf-dept-total"><span>Claims total</span><strong>${wfMoney(totals.claims)}</strong></span>
        <span class="wf-dept-total"><span>Combined</span><strong>${wfMoney(totals.combined)}</strong></span>
      </summary>
      <div>${Object.entries(byWorker).map(([id, rows]) => wfWorkerHtml(id, rows)).join('')}</div>
    </details>
  `;
}

function wfTransportCard(booking) {
  const invoice = booking.invoice;
  return `
    <article class="wf-transport-card">
      <div class="wf-transport-heading">
        <div>
          <h4>${wfEscape(booking.vehicleType || 'Transport')}</h4>
          <small>${wfEscape(booking.purpose)} · ${wfEscape(booking.loadType)}</small>
        </div>
        <span class="wf-status-pill ${wfStatusClass(booking.status)}">${wfEscape(booking.status)}</span>
      </div>
      <div class="wf-transport-meta">
        <div><span>Company / Driver</span><strong>${wfEscape(booking.companyDriver)}</strong></div>
        <div><span>Contact / Vehicle</span><strong>${wfEscape(`${booking.contactNumber || '—'} · ${booking.vehicleNumber || '—'}`)}</strong></div>
        <div class="wf-route"><span>Route</span><strong>${wfEscape(booking.locationFrom)} → ${wfEscape(booking.locationTo)}</strong></div>
        <div><span>Outbound</span><strong>${wfEscape(`${booking.departDate} ${booking.departTime}`)}</strong></div>
        <div><span>${booking.twoWay ? 'Return' : 'One-way booking'}</span><strong>${booking.twoWay ? wfEscape(`${booking.returnDate} ${booking.returnTime}`) : '—'}</strong></div>
        <div><span>Cost</span><strong>${wfMoney(booking.cost)}</strong></div>
        <div><span>Vendor invoice</span><strong>${invoice
          ? `<button class="wf-link-button" type="button" onclick="window.open('${wfAttr(invoice.previewUrl)}', '_blank')">${wfEscape(invoice.originalName)}</button>`
          : 'Not uploaded'}</strong></div>
      </div>
      ${booking.notes ? `<p style="margin:11px 0 0;color:#64748b;font-size:12px;">${wfEscape(booking.notes)}</p>` : ''}
      <div class="wf-transport-footer">
        <label class="wf-link-button" style="cursor:pointer;">
          ${invoice ? 'Replace invoice' : 'Upload invoice'}
          <input type="file" accept=".pdf,application/pdf" hidden onchange="uploadTransportInvoice('${wfAttr(booking.id)}', this)" />
        </label>
        <div>
          <button class="wf-button" type="button" onclick="openTransportModal('${wfAttr(booking.id)}')">Edit</button>
          <button class="wf-button danger" type="button" onclick="deleteTransportBooking('${wfAttr(booking.id)}')">Remove</button>
        </div>
      </div>
    </article>
  `;
}

function renderWorkforcePage() {
  const root = document.getElementById('workforce-page-root');
  const data = workforcePageState.data;
  if (!root || !data) return;

  const grouped = {};
  data.assignments.forEach(assignment => {
    (grouped[assignment.department || 'Unassigned'] ||= []).push(assignment);
  });
  const departmentHtml = Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([department, assignments], index) => wfDepartmentHtml(department, assignments, index))
    .join('');
  const totals = data.totals || {};
  root.innerHTML = `
    <header class="wf-page-header">
      <div>
        <button class="wf-back" type="button" onclick="showSection('events')">← Back to All Events</button>
        <h2>Manpower &amp; Transport</h2>
        <p>Event ${data.event.id}: ${wfEscape(data.event.name)}</p>
      </div>
      <button class="wf-button" type="button" onclick="editEvent(${data.event.id})">Edit Event</button>
    </header>

    <section class="wf-event-summary" aria-label="Event summary">
      <div class="wf-summary-cell"><span>Start date</span><strong>${wfEscape(data.event.startDate)}</strong></div>
      <div class="wf-summary-cell"><span>End date</span><strong>${wfEscape(data.event.endDate)}</strong></div>
      <div class="wf-summary-cell location"><span>Location</span><strong>${wfEscape(data.event.location || '—')}</strong></div>
      <div class="wf-summary-cell"><span>Status</span><strong><span class="wf-status-pill">${wfEscape(data.event.state)}</span></strong></div>
      <div class="wf-summary-cell"><span>Transport spend</span><strong>${wfMoney(totals.transport)}</strong></div>
    </section>

    <div class="wf-layout">
      <section class="wf-panel">
        <header class="wf-panel-header">
          <div>
            <h3>Manpower / Freelance Crew</h3>
            <p>Assign reusable freelancers and review their event submissions.</p>
          </div>
          <div class="wf-toolbar">
            <a class="wf-button" href="/api/events/${data.event.id}/workforce/download/invoices">⇩ Invoices (.zip)</a>
            <a class="wf-button" href="/api/events/${data.event.id}/workforce/download/claims">⇩ Claims (.zip)</a>
            <button class="wf-button primary" type="button" onclick="openWorkforceFreelancerModal()">+ Add Freelancer</button>
          </div>
        </header>
        <div>
          ${departmentHtml || '<div class="wf-empty" style="padding:40px;">No freelancers have been assigned to this event.</div>'}
        </div>
        <div class="wf-event-totals">
          <h4>Event-wide submission totals</h4>
          <div><span>Invoices</span><strong>${wfMoney(totals.invoice)}</strong></div>
          <div><span>Claims</span><strong>${wfMoney(totals.claims)}</strong></div>
          <div><span>Combined</span><strong>${wfMoney(totals.combined)}</strong></div>
          <div><span>Including transport</span><strong>${wfMoney(Number(totals.combined || 0) + Number(totals.transport || 0))}</strong></div>
        </div>
      </section>

      <aside class="wf-panel">
        <header class="wf-panel-header">
          <div>
            <h3>Transport Details</h3>
            <p>Saved vehicle, driver, route and vendor costs.</p>
          </div>
          <button class="wf-button primary" type="button" onclick="openTransportModal()">+ Add Booking</button>
        </header>
        <div class="wf-transport-list">
          ${data.transportBookings.length
            ? data.transportBookings.map(wfTransportCard).join('')
            : '<div class="wf-empty">No transport bookings yet.</div>'}
        </div>
      </aside>
    </div>
  `;
}

function ensureWorkforceModals() {
  if (document.getElementById('wfFreelancerModal')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="wf-modal" id="wfFreelancerModal" aria-hidden="true">
      <div class="wf-modal-backdrop" onclick="closeWorkforceModal('wfFreelancerModal')"></div>
      <section class="wf-modal-card" role="dialog" aria-modal="true" aria-labelledby="wfFreelancerTitle">
        <header class="wf-modal-header">
          <h3 id="wfFreelancerTitle">Add Freelancer</h3>
          <button class="wf-icon-button" type="button" onclick="closeWorkforceModal('wfFreelancerModal')">×</button>
        </header>
        <form id="wfFreelancerForm">
          <div class="wf-modal-body">
            <div class="wf-form-grid">
              <label class="wf-field full"><span>Existing freelancer</span><select id="wfExistingFreelancer"></select></label>
            </div>
            <div class="wf-section-card" id="wfNewFreelancerFields">
              <h4 id="wfFreelancerProfileHeading">New freelancer profile</h4>
              <div class="wf-form-grid">
                <label class="wf-field"><span>Full name *</span><input id="wfFreelancerName" maxlength="120" /></label>
                <label class="wf-field"><span>Phone number</span><input id="wfFreelancerPhone" type="tel" placeholder="+65 9123 4567" /></label>
                <label class="wf-field"><span>Email</span><input id="wfFreelancerEmail" type="email" /></label>
                <label class="wf-field"><span>Company</span><input id="wfFreelancerCompany" /></label>
                <label class="wf-field full"><span>Profile notes</span><textarea id="wfFreelancerNotes"></textarea></label>
              </div>
            </div>
            <div class="wf-section-card">
              <h4>Event assignment</h4>
              <div class="wf-form-grid">
                <label class="wf-field"><span>Department *</span><select id="wfAssignmentDepartment" required></select></label>
                <label class="wf-field"><span>Saved role</span><select id="wfAssignmentRole"></select></label>
                <label class="wf-field full" id="wfCustomRoleField"><span>Role / position *</span><input id="wfCustomRole" maxlength="100" /></label>
                <label class="wf-field"><span>Number of days *</span><input id="wfAssignmentDays" type="number" min="1" step="1" value="1" required /></label>
                <label class="wf-field"><span>Daily rate (SGD) *</span><input id="wfAssignmentRate" type="number" min="0" step=".01" required /></label>
                <label class="wf-field full"><span>Assignment notes</span><textarea id="wfAssignmentNotes"></textarea></label>
              </div>
              <label class="wf-check" style="margin-top:12px;"><input id="wfSaveCustomRole" type="checkbox" checked /> Save a new custom role for future events</label>
            </div>
            <div class="wf-error" id="wfFreelancerError"></div>
          </div>
          <footer class="wf-modal-actions">
            <button class="wf-button" type="button" onclick="closeWorkforceModal('wfFreelancerModal')">Cancel</button>
            <button class="wf-button primary" type="submit">Add Assignment</button>
          </footer>
        </form>
      </section>
    </div>

    <div class="wf-modal" id="wfTransportModal" aria-hidden="true">
      <div class="wf-modal-backdrop" onclick="closeWorkforceModal('wfTransportModal')"></div>
      <section class="wf-modal-card" role="dialog" aria-modal="true" aria-labelledby="wfTransportTitle">
        <header class="wf-modal-header">
          <h3 id="wfTransportTitle">Add Transport Booking</h3>
          <button class="wf-icon-button" type="button" onclick="closeWorkforceModal('wfTransportModal')">×</button>
        </header>
        <form id="wfTransportForm">
          <div class="wf-modal-body">
            <div class="wf-form-grid">
              <label class="wf-field full"><span>Saved vendor / driver</span><select id="wfTransportVendor"></select></label>
              <label class="wf-field"><span>Vehicle type *</span><input id="wfVehicleType" placeholder="e.g. 24ft Lorry (Tail Lift)" required /></label>
              <label class="wf-field"><span>Purpose *</span><select id="wfTransportPurpose"><option>Depart</option><option>Return</option><option>Shuttle</option><option>Other</option></select></label>
              <label class="wf-field"><span>Load type *</span><select id="wfTransportLoad"><option>Equipment</option><option>Manpower</option><option>Mixed</option><option>Other</option></select></label>
              <label class="wf-field"><span>Company / driver *</span><input id="wfCompanyDriver" required /></label>
              <label class="wf-field"><span>Contact number *</span><input id="wfTransportContact" type="tel" required /></label>
              <label class="wf-field"><span>Vehicle / lorry number *</span><input id="wfVehicleNumber" required /></label>
              <label class="wf-field"><span>Location from *</span><input id="wfLocationFrom" required /></label>
              <label class="wf-field"><span>Location to *</span><input id="wfLocationTo" required /></label>
              <label class="wf-field"><span>Depart date *</span><input id="wfDepartDate" type="date" required /></label>
              <label class="wf-field"><span>Depart time *</span><input id="wfDepartTime" type="time" required /></label>
              <label class="wf-field"><span>Return date</span><input id="wfReturnDate" type="date" /></label>
              <label class="wf-field"><span>Return time</span><input id="wfReturnTime" type="time" /></label>
              <label class="wf-field"><span>Cost (SGD)</span><input id="wfTransportCost" type="number" min="0" step=".01" value="0" /></label>
              <label class="wf-field"><span>Payment status</span><select id="wfTransportStatus">${wfStatusOptions('Pending Review')}</select></label>
              <label class="wf-field full"><span>Notes / remarks</span><textarea id="wfTransportNotes"></textarea></label>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:18px;margin-top:14px;">
              <label class="wf-check"><input id="wfTransportTwoWay" type="checkbox" /> Two-way booking</label>
              <label class="wf-check"><input id="wfRememberVendor" type="checkbox" checked /> Remember vehicle, driver and contact</label>
            </div>
            <div class="wf-error" id="wfTransportError"></div>
          </div>
          <footer class="wf-modal-actions">
            <button class="wf-button" type="button" onclick="closeWorkforceModal('wfTransportModal')">Cancel</button>
            <button class="wf-button primary" type="submit">Save Booking</button>
          </footer>
        </form>
      </section>
    </div>

    <div class="wf-modal" id="wfReviewModal" aria-hidden="true">
      <div class="wf-modal-backdrop" onclick="closeWorkforceModal('wfReviewModal')"></div>
      <section class="wf-modal-card wide" role="dialog" aria-modal="true" aria-labelledby="wfReviewTitle">
        <header class="wf-modal-header">
          <div><h3 id="wfReviewTitle">Review Submission</h3><small id="wfReviewSubtitle"></small></div>
          <button class="wf-icon-button" type="button" onclick="closeWorkforceModal('wfReviewModal')">×</button>
        </header>
        <div id="wfReviewContent"></div>
      </section>
    </div>
  `);

  document.getElementById('wfFreelancerForm').addEventListener('submit', submitWorkforceAssignment);
  document.getElementById('wfExistingFreelancer').addEventListener('change', syncNewFreelancerFields);
  document.getElementById('wfAssignmentDepartment').addEventListener('change', renderWorkforceRoleOptions);
  document.getElementById('wfAssignmentRole').addEventListener('change', syncCustomRoleField);
  document.getElementById('wfTransportForm').addEventListener('submit', submitTransportBooking);
  document.getElementById('wfTransportVendor').addEventListener('change', applySavedTransportVendor);
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
  modal?.classList.remove('open');
  modal?.setAttribute('aria-hidden', 'true');
  if (!document.querySelector('.wf-modal.open')) document.body.style.overflow = '';
}

function wfError(id, message = '') {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('show', Boolean(message));
}

function openWorkforceFreelancerModal(preselectedId = '') {
  ensureWorkforceModals();
  const data = workforcePageState.data;
  const select = document.getElementById('wfExistingFreelancer');
  select.innerHTML = [
    '<option value="">Create a new freelancer</option>',
    ...data.freelancers
      .filter(row => row.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(row => `<option value="${wfAttr(row.id)}">${wfEscape(row.name)}${row.phone ? ` · ${wfEscape(row.phone)}` : ''}</option>`)
  ].join('');
  select.value = preselectedId || '';
  document.getElementById('wfAssignmentDepartment').innerHTML = data.departments
    .map(row => `<option value="${wfAttr(row.code)}">${wfEscape(row.name)} (${wfEscape(row.code)})</option>`)
    .join('');
  document.getElementById('wfFreelancerForm').reset();
  select.value = preselectedId || '';
  document.getElementById('wfAssignmentDays').value = '1';
  document.getElementById('wfSaveCustomRole').checked = true;
  syncNewFreelancerFields();
  renderWorkforceRoleOptions();
  wfError('wfFreelancerError');
  openWorkforceModal('wfFreelancerModal');
}

function syncNewFreelancerFields() {
  const freelancerId = document.getElementById('wfExistingFreelancer').value;
  const freelancer = workforcePageState.data.freelancers.find(
    row => String(row.id) === String(freelancerId)
  );
  document.getElementById('wfFreelancerProfileHeading').textContent = freelancer
    ? 'Freelancer profile'
    : 'New freelancer profile';
  document.getElementById('wfFreelancerName').value = freelancer?.name || '';
  document.getElementById('wfFreelancerPhone').value = freelancer?.phone || '';
  document.getElementById('wfFreelancerEmail').value = freelancer?.email || '';
  document.getElementById('wfFreelancerCompany').value = freelancer?.company || '';
  document.getElementById('wfFreelancerNotes').value = freelancer?.notes || '';
  document.getElementById('wfFreelancerName').required = true;
}

function renderWorkforceRoleOptions() {
  const department = document.getElementById('wfAssignmentDepartment').value;
  const roles = workforcePageState.data.roles.filter(
    role => !role.department || role.department === department
  );
  const select = document.getElementById('wfAssignmentRole');
  select.innerHTML = [
    '<option value="">Other / enter a role</option>',
    ...roles
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(role => `<option value="${wfAttr(role.id)}">${wfEscape(role.name)}</option>`)
  ].join('');
  syncCustomRoleField();
}

function syncCustomRoleField() {
  const custom = !document.getElementById('wfAssignmentRole').value;
  document.getElementById('wfCustomRoleField').hidden = !custom;
  document.getElementById('wfCustomRole').required = custom;
}

async function submitWorkforceAssignment(event) {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('[type="submit"]');
  submit.disabled = true;
  wfError('wfFreelancerError');
  try {
    let freelancerId = document.getElementById('wfExistingFreelancer').value;
    if (!freelancerId) {
      const created = await apiCall('/api/workforce/freelancers', 'POST', {
        name: document.getElementById('wfFreelancerName').value,
        phone: document.getElementById('wfFreelancerPhone').value,
        email: document.getElementById('wfFreelancerEmail').value,
        company: document.getElementById('wfFreelancerCompany').value,
        notes: document.getElementById('wfFreelancerNotes').value
      });
      freelancerId = created.data.id;
    } else {
      await apiCall(`/api/workforce/freelancers/${encodeURIComponent(freelancerId)}`, 'PUT', {
        name: document.getElementById('wfFreelancerName').value,
        phone: document.getElementById('wfFreelancerPhone').value,
        email: document.getElementById('wfFreelancerEmail').value,
        company: document.getElementById('wfFreelancerCompany').value,
        notes: document.getElementById('wfFreelancerNotes').value,
        active: true
      });
    }
    const response = await apiCall(
      `/api/events/${workforcePageState.eventId}/workforce/assignments`,
      'POST',
      {
        freelancerId,
        department: document.getElementById('wfAssignmentDepartment').value,
        roleId: document.getElementById('wfAssignmentRole').value,
        customRole: document.getElementById('wfCustomRole').value,
        saveRole: document.getElementById('wfSaveCustomRole').checked,
        days: document.getElementById('wfAssignmentDays').value,
        dailyRate: document.getElementById('wfAssignmentRate').value,
        notes: document.getElementById('wfAssignmentNotes').value
      }
    );
    workforcePageState.data = response.data;
    closeWorkforceModal('wfFreelancerModal');
    renderWorkforcePage();
    showNotification('success', 'Freelancer assignment added');
  } catch (error) {
    wfError('wfFreelancerError', error.message);
  } finally {
    submit.disabled = false;
  }
}

async function deleteWorkforceAssignment(assignmentId) {
  if (!confirm('Remove this assignment from the event? Existing submissions will remain.')) return;
  const response = await apiCall(
    `/api/events/${workforcePageState.eventId}/workforce/assignments/${encodeURIComponent(assignmentId)}`,
    'DELETE'
  );
  workforcePageState.data = response.data;
  renderWorkforcePage();
}

function openTransportModal(bookingId = '') {
  ensureWorkforceModals();
  workforcePageState.editingTransportId = bookingId || null;
  const data = workforcePageState.data;
  const form = document.getElementById('wfTransportForm');
  form.reset();
  document.getElementById('wfTransportTitle').textContent = bookingId ? 'Edit Transport Booking' : 'Add Transport Booking';
  document.getElementById('wfTransportVendor').innerHTML = [
    '<option value="">New or unsaved vendor</option>',
    ...data.transportVendors
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(row => `<option value="${wfAttr(row.id)}">${wfEscape(row.name)} · ${wfEscape(row.vehicleType || 'Vehicle')}</option>`)
  ].join('');
  document.getElementById('wfRememberVendor').checked = true;
  const booking = data.transportBookings.find(row => String(row.id) === String(bookingId));
  if (booking) {
    document.getElementById('wfTransportVendor').value = booking.vendorId || '';
    document.getElementById('wfVehicleType').value = booking.vehicleType || '';
    document.getElementById('wfTransportPurpose').value = booking.purpose || 'Depart';
    document.getElementById('wfTransportLoad').value = booking.loadType || 'Equipment';
    document.getElementById('wfCompanyDriver').value = booking.companyDriver || '';
    document.getElementById('wfTransportContact').value = booking.contactNumber || '';
    document.getElementById('wfVehicleNumber').value = booking.vehicleNumber || '';
    document.getElementById('wfLocationFrom').value = booking.locationFrom || '';
    document.getElementById('wfLocationTo').value = booking.locationTo || '';
    document.getElementById('wfDepartDate').value = booking.departDate || '';
    document.getElementById('wfDepartTime').value = booking.departTime || '';
    document.getElementById('wfReturnDate').value = booking.returnDate || '';
    document.getElementById('wfReturnTime').value = booking.returnTime || '';
    document.getElementById('wfTransportCost').value = booking.cost ?? 0;
    document.getElementById('wfTransportStatus').value = booking.status || 'Pending Review';
    document.getElementById('wfTransportNotes').value = booking.notes || '';
    document.getElementById('wfTransportTwoWay').checked = Boolean(booking.twoWay);
  }
  wfError('wfTransportError');
  openWorkforceModal('wfTransportModal');
}

function applySavedTransportVendor() {
  const id = document.getElementById('wfTransportVendor').value;
  const vendor = workforcePageState.data.transportVendors.find(row => String(row.id) === String(id));
  if (!vendor) return;
  document.getElementById('wfVehicleType').value = vendor.vehicleType || '';
  document.getElementById('wfCompanyDriver').value = vendor.name || '';
  document.getElementById('wfTransportContact').value = vendor.contactNumber || '';
  document.getElementById('wfVehicleNumber').value = vendor.vehicleNumber || '';
}

function transportFormPayload() {
  return {
    vendorId: document.getElementById('wfTransportVendor').value,
    vehicleType: document.getElementById('wfVehicleType').value,
    purpose: document.getElementById('wfTransportPurpose').value,
    loadType: document.getElementById('wfTransportLoad').value,
    companyDriver: document.getElementById('wfCompanyDriver').value,
    contactNumber: document.getElementById('wfTransportContact').value,
    vehicleNumber: document.getElementById('wfVehicleNumber').value,
    locationFrom: document.getElementById('wfLocationFrom').value,
    locationTo: document.getElementById('wfLocationTo').value,
    departDate: document.getElementById('wfDepartDate').value,
    departTime: document.getElementById('wfDepartTime').value,
    returnDate: document.getElementById('wfReturnDate').value,
    returnTime: document.getElementById('wfReturnTime').value,
    twoWay: document.getElementById('wfTransportTwoWay').checked,
    cost: document.getElementById('wfTransportCost').value,
    status: document.getElementById('wfTransportStatus').value,
    notes: document.getElementById('wfTransportNotes').value,
    rememberVendor: document.getElementById('wfRememberVendor').checked
  };
}

async function submitTransportBooking(event) {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('[type="submit"]');
  submit.disabled = true;
  wfError('wfTransportError');
  try {
    const bookingId = workforcePageState.editingTransportId;
    const endpoint = bookingId
      ? `/api/events/${workforcePageState.eventId}/workforce/transport/${encodeURIComponent(bookingId)}`
      : `/api/events/${workforcePageState.eventId}/workforce/transport`;
    const response = await apiCall(endpoint, bookingId ? 'PUT' : 'POST', transportFormPayload());
    workforcePageState.data = response.data;
    closeWorkforceModal('wfTransportModal');
    renderWorkforcePage();
    showNotification('success', 'Transport booking saved');
  } catch (error) {
    wfError('wfTransportError', error.message);
  } finally {
    submit.disabled = false;
  }
}

async function deleteTransportBooking(bookingId) {
  if (!confirm('Remove this transport booking and its uploaded vendor invoice?')) return;
  const response = await apiCall(
    `/api/events/${workforcePageState.eventId}/workforce/transport/${encodeURIComponent(bookingId)}`,
    'DELETE'
  );
  workforcePageState.data = response.data;
  renderWorkforcePage();
}

async function uploadTransportInvoice(bookingId, input) {
  const file = input.files?.[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const response = await apiCall(
      `/api/events/${workforcePageState.eventId}/workforce/transport/${encodeURIComponent(bookingId)}/invoice`,
      'POST',
      form
    );
    workforcePageState.data = response.data;
    renderWorkforcePage();
    showNotification('success', 'Transport invoice uploaded');
  } finally {
    input.value = '';
  }
}

async function quickWorkforceStatusChange(submissionId, select) {
  const found = wfFindSubmission(submissionId);
  if (!found) return;
  const nextStatus = select.value;
  if (found.record.amount == null || found.kind === 'invoice' && !found.record.allocations?.length) {
    select.value = select.dataset.currentStatus;
    openWorkforceReview(submissionId, nextStatus);
    return;
  }
  try {
    const response = await apiCall(`/api/workforce/submissions/${encodeURIComponent(submissionId)}`, 'PUT', {
      status: nextStatus,
      amount: found.record.amount,
      allocations: found.record.allocations || [],
      department: found.record.department || ''
    });
    workforcePageState.data = response.data;
    renderWorkforcePage();
  } catch (_error) {
    select.value = select.dataset.currentStatus;
  }
}

function openWorkforceReview(submissionId, requestedStatus = '') {
  ensureWorkforceModals();
  const found = wfFindSubmission(submissionId);
  if (!found) return;
  workforcePageState.reviewSubmissionId = submissionId;
  const { record, freelancerId, kind } = found;
  const freelancer = wfFindFreelancer(freelancerId) || {};
  const departments = wfDepartmentsForFreelancer(freelancerId);
  const allocationMap = Object.fromEntries((record.allocations || []).map(row => [row.department, row.amount]));
  const isPdf = record.contentType === 'application/pdf';
  document.getElementById('wfReviewTitle').textContent = `Review ${kind === 'invoice' ? 'Invoice' : 'Claim'}`;
  document.getElementById('wfReviewSubtitle').textContent = `${freelancer.name || 'Freelancer'} · ${record.originalName || 'Upload'}`;
  document.getElementById('wfReviewContent').innerHTML = `
    <div class="wf-review-layout">
      <div class="wf-preview">
        ${isPdf
          ? `<iframe src="${wfAttr(record.previewUrl)}#toolbar=1" title="Uploaded PDF"></iframe>`
          : `<img src="${wfAttr(record.previewUrl)}" alt="Uploaded claim" />`}
      </div>
      <form class="wf-review-form" id="wfReviewForm">
        ${kind === 'invoice' ? `
          <div class="wf-ocr-card">
            <strong>Detected total: ${record.amount == null ? 'Needs verification' : wfMoney(record.amount)}</strong><br />
            Confidence: ${wfEscape(record.ocrConfidence || 'Low')} · ${wfEscape(record.ocrSource || 'No extractor result')}
            ${record.ocrMatchedText ? `<br />Matched text: “${wfEscape(record.ocrMatchedText)}”` : ''}
          </div>
        ` : `
          <div class="wf-ocr-card">
            ${wfEscape(record.category || 'Claim')} · ${wfEscape(record.claimDate || '')}<br />
            ${wfEscape(record.description || '')}
          </div>
        `}
        <div class="wf-form-grid">
          <label class="wf-field"><span>Verified amount (SGD) *</span><input id="wfReviewAmount" type="number" min="0" step=".01" value="${record.amount ?? ''}" required /></label>
          <label class="wf-field"><span>Status</span><select id="wfReviewStatus">${wfStatusOptions(requestedStatus || record.status)}</select></label>
          ${kind === 'claim' ? `
            <label class="wf-field full"><span>Department</span><select id="wfReviewDepartment">
              ${departments.map(department => `<option value="${wfAttr(department)}" ${department === record.department ? 'selected' : ''}>${wfEscape(department)}</option>`).join('')}
            </select></label>
          ` : ''}
          <label class="wf-field full"><span>Denial reason (optional)</span><textarea id="wfReviewDenialReason">${wfEscape(record.denialReason || '')}</textarea></label>
        </div>
        ${kind === 'invoice' ? `
          <div class="wf-section-card">
            <h4>Department allocation</h4>
            ${departments.map(department => `
              <label class="wf-allocation-row">
                <span>${wfEscape(department)}</span>
                <input class="wf-allocation-input" data-department="${wfAttr(department)}" type="number" min="0" step=".01" value="${allocationMap[department] ?? ''}" />
              </label>
            `).join('') || '<p>No active assignment departments are available.</p>'}
            <div class="wf-allocation-progress" id="wfAllocationProgress"></div>
          </div>
        ` : ''}
        <div class="wf-section-card">
          <h4>Review history</h4>
          ${(record.reviewHistory || []).length
            ? record.reviewHistory.map(row => `<p style="margin:6px 0;color:#64748b;font-size:12px;">${wfEscape(wfFormatDateTime(row.at))} · ${wfEscape(row.by)} · ${wfEscape(row.from)} → ${wfEscape(row.to)}</p>`).join('')
            : '<p style="margin:0;color:#64748b;font-size:12px;">No status changes yet.</p>'}
        </div>
        <div class="wf-error" id="wfReviewError"></div>
      </form>
    </div>
    <footer class="wf-review-actions">
      <button class="wf-button danger" type="button" onclick="deleteWorkforceSubmission('${wfAttr(record.id)}', true)">Delete Upload</button>
      <a class="wf-button" href="${wfAttr(record.downloadUrl)}">Download File</a>
      <button class="wf-button primary" type="button" onclick="saveWorkforceReview()">Save Review</button>
    </footer>
  `;
  document.querySelectorAll('.wf-allocation-input').forEach(input => input.addEventListener('input', updateAllocationProgress));
  document.getElementById('wfReviewAmount')?.addEventListener('input', updateAllocationProgress);
  updateAllocationProgress();
  openWorkforceModal('wfReviewModal');
}

function updateAllocationProgress() {
  const progress = document.getElementById('wfAllocationProgress');
  if (!progress) return;
  const amount = Number(document.getElementById('wfReviewAmount')?.value || 0);
  const allocated = [...document.querySelectorAll('.wf-allocation-input')]
    .reduce((sum, input) => sum + Number(input.value || 0), 0);
  progress.textContent = `Allocated ${wfMoney(allocated)} of ${wfMoney(amount)}`;
  progress.style.color = Math.abs(allocated - amount) <= .01 || allocated === 0 ? '#166534' : '#b45309';
}

async function saveWorkforceReview() {
  const found = wfFindSubmission(workforcePageState.reviewSubmissionId);
  if (!found) return;
  wfError('wfReviewError');
  const allocations = [...document.querySelectorAll('.wf-allocation-input')]
    .map(input => ({ department: input.dataset.department, amount: input.value }))
    .filter(row => Number(row.amount || 0) > 0);
  try {
    const response = await apiCall(
      `/api/workforce/submissions/${encodeURIComponent(found.record.id)}`,
      'PUT',
      {
        amount: document.getElementById('wfReviewAmount').value,
        status: document.getElementById('wfReviewStatus').value,
        denialReason: document.getElementById('wfReviewDenialReason').value,
        department: document.getElementById('wfReviewDepartment')?.value || found.record.department || '',
        allocations
      }
    );
    workforcePageState.data = response.data;
    closeWorkforceModal('wfReviewModal');
    renderWorkforcePage();
    showNotification('success', 'Submission review saved');
  } catch (error) {
    wfError('wfReviewError', error.message);
  }
}

async function deleteWorkforceSubmission(submissionId, fromReview = false) {
  if (!confirm('Delete this upload? The worker will no longer see this record and may upload again.')) return;
  const response = await apiCall(
    `/api/workforce/submissions/${encodeURIComponent(submissionId)}`,
    'DELETE'
  );
  workforcePageState.data = response.data;
  if (fromReview) closeWorkforceModal('wfReviewModal');
  renderWorkforcePage();
  showNotification('success', 'Upload deleted');
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const modal = document.querySelector('.wf-modal.open');
  if (modal) closeWorkforceModal(modal.id);
});

document.addEventListener('DOMContentLoaded', ensureWorkforceModals);
