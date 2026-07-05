let workerPortalData = { companies: [] };
let workerEventTab = 'active';
let workerPollTimer = null;
let pendingClaimContext = null;
let activeUploads = 0;

const byId = id => document.getElementById(id);

function escapeHtml(value) {
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function money(value) {
  return `SGD ${Number(value || 0).toLocaleString('en-SG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function initials(name) {
  return String(name || 'FW').split(/\s+/).filter(Boolean).slice(0, 2)
    .map(part => part[0].toUpperCase()).join('');
}

function formatDate(value, withTime = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-SG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {})
  });
}

function displayStatus(status) {
  return status === 'Pending Review' ? 'Submitted' : status;
}

function statusClass(status) {
  return `status-${String(displayStatus(status)).toLowerCase().replace(/\s+/g, '-')}`;
}

function submissionStatusBadge(row) {
  const status = displayStatus(row.status);
  if (status === 'Uploading') {
    return `<span class="upload-status"><em class="status-badge status-uploading">Uploading</em>
      <span class="upload-progress-track"><span data-upload-progress="${escapeHtml(row.id)}" style="width:${Number(row.uploadProgress || 0)}%"></span></span>
      <small data-upload-progress-label="${escapeHtml(row.id)}">${Math.round(Number(row.uploadProgress || 0))}%</small></span>`;
  }
  if (status === 'Denied') {
    return `<button class="status-badge status-denied denial-reason-button" type="button"
      data-denial-toggle="${escapeHtml(row.id)}" aria-expanded="false"
      aria-controls="denialReason-${escapeHtml(row.id)}">Denied</button>`;
  }
  return `<em class="status-badge ${statusClass(status)}">${escapeHtml(status)}</em>`;
}

function submissionDenialReason(row) {
  if (displayStatus(row.status) !== 'Denied') return '';
  return `<small class="row-note" id="denialReason-${escapeHtml(row.id)}" hidden>
    ${escapeHtml(row.denialReason || 'No reason was provided by the administrator.')}
  </small>`;
}

function showMessage(element, message, type = 'error') {
  if (!element) return;
  element.textContent = message || '';
  element.className = message
    ? `${element.className.split(' ')[0]} show ${type}`
    : element.className.split(' ')[0];
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function savePortalSession() {
  sessionStorage.setItem('aimWorkerPortal', JSON.stringify(workerPortalData));
}

function replaceCompany(company) {
  const index = workerPortalData.companies.findIndex(row => row.code === company.code);
  if (index >= 0) workerPortalData.companies[index] = company;
  else workerPortalData.companies.push(company);
  savePortalSession();
  renderPortal();
}

function allEvents() {
  return workerPortalData.companies.flatMap(company =>
    company.events.map(event => ({ company, event }))
  );
}

function submissionStatusSummary(rows) {
  if (!rows.length) return 'Not submitted';
  if (rows.some(row => row.status === 'Uploading')) return 'Uploading';
  if (rows.some(row => row.status === 'Processing')) return 'Processing';
  if (rows.some(row => row.status === 'Details Required')) return 'Details Required';
  if (rows.every(row => row.status === 'Payment Confirmed')) return 'Payment Confirmed';
  if (rows.some(row => row.adminStatus === 'Paid')) return 'Paid';
  if (rows.some(row => row.adminStatus === 'Approved')) return 'Approved';
  if (rows.every(row => row.adminStatus === 'Denied')) return 'Denied';
  return 'Submitted';
}

function submissionActions(company, row) {
  const received = row.canConfirmPayment
    ? `<button class="received-button" type="button" data-confirm-payment="${escapeHtml(row.id)}" data-company="${escapeHtml(company.code)}">Received</button>`
    : '';
  const remove = row.canEdit
    ? `<button class="delete-upload" type="button" title="Remove and upload again"
        data-delete-submission="${escapeHtml(row.id)}" data-company="${escapeHtml(company.code)}">🗑</button>`
    : '';
  return received || remove || '<span class="locked-action">—</span>';
}

function invoiceRows(company, rows) {
  if (!rows.length) return '<div class="empty-submissions">No invoice submitted yet.</div>';
  return `<div class="submission-table invoice-table">
    <div class="submission-head"><span>File Name</span><span>Uploaded On</span><span>Amount (SGD)</span><span>Status</span><span>Action</span></div>
    ${rows.map(row => `<div class="submission-line">
      ${row.clientOnly
        ? `<span class="uploading-file-name">▣ ${escapeHtml(row.originalName || 'Invoice PDF')}</span>`
        : `<a href="${escapeHtml(row.fileUrl)}" target="_blank">▣ ${escapeHtml(row.originalName || 'Invoice PDF')}</a>`}
      <span>${escapeHtml(formatDate(row.submittedAt))}</span>
      <strong>${row.amount == null ? '—' : Number(row.amount).toLocaleString('en-SG', { minimumFractionDigits: 2 })}</strong>
      <span>${submissionStatusBadge(row)}</span>
      <span>${submissionActions(company, row)}</span>
      ${submissionDenialReason(row)}
    </div>`).join('')}
  </div>`;
}

function claimRows(company, rows) {
  if (!rows.length) return '<div class="empty-submissions">No claims submitted yet.</div>';
  return `<div class="submission-table claim-table">
    <div class="submission-head"><span>File Name</span><span>Category</span><span>Claim Date</span><span>Uploaded On</span><span>Amount</span><span>Status</span><span>Action</span></div>
    ${rows.map(row => `<div class="submission-line ${row.needsDetails ? 'claim-details-required' : ''}"
      ${row.needsDetails ? `data-claim-details="${escapeHtml(row.id)}" data-company="${escapeHtml(company.code)}"` : ''}>
      ${row.clientOnly
        ? `<span class="uploading-file-name">▣ ${escapeHtml(row.originalName || 'Claim file')}</span>`
        : row.needsDetails
        ? `<button class="claim-detail-link" type="button">▣ ${escapeHtml(row.originalName || 'Claim file')}</button>`
        : `<a href="${escapeHtml(row.fileUrl)}" target="_blank">▣ ${escapeHtml(row.originalName || 'Claim file')}</a>`}
      <span>${escapeHtml(row.category || '—')}</span>
      <span>${escapeHtml(row.claimDate ? formatDate(row.claimDate) : '—')}</span>
      <span>${escapeHtml(formatDate(row.submittedAt))}</span>
      <strong>${row.amount == null ? '—' : Number(row.amount).toLocaleString('en-SG', { minimumFractionDigits: 2 })}</strong>
      <span>${submissionStatusBadge(row)}</span>
      <span>${submissionActions(company, row)}</span>
      ${submissionDenialReason(row)}
    </div>`).join('')}
  </div>`;
}

function dropZone(company, event, kind) {
  const remaining = kind === 'invoice'
    ? event.invoiceSlotsRemaining
    : event.claimSlotsRemaining;
  if (remaining <= 0) return '';
  const accept = kind === 'invoice' ? '.pdf,application/pdf' : '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';
  return `<label class="event-dropzone" data-drop-kind="${kind}" data-company="${escapeHtml(company.code)}" data-event="${event.id}">
    <input type="file" accept="${accept}" multiple hidden>
    <strong>↥ &nbsp; Drag &amp; drop or choose ${kind === 'invoice' ? 'invoice files' : 'claim files'}</strong>
    <span>${remaining} upload slot${remaining === 1 ? '' : 's'} available</span>
  </label>`;
}

function eventDateBlock(event) {
  const raw = String(event.startDate || '');
  const match = raw.match(/(\d{4})[\/-](\d{2})[\/-](\d{2})/);
  if (!match) return `<span>${escapeHtml(raw || 'TBC')}</span>`;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00`);
  return `<strong>${date.getDate()}</strong><span>${date.toLocaleDateString('en-SG', { month: 'short' }).toUpperCase()}</span>`;
}

function renderEvent(company, event, open = false) {
  const invoices = event.submissions.invoices || [];
  const claims = event.submissions.claims || [];
  const roles = [...new Set(event.assignments.map(row => row.role))].join(', ');
  const departments = [...new Set(event.assignments.map(row => row.department))].join(', ');
  return `<details class="event-card" data-event-key="${escapeHtml(company.code)}:${event.id}" ${open ? 'open' : ''}>
    <summary>
      <div class="date-block">${eventDateBlock(event)}</div>
      <div class="event-name"><strong>${escapeHtml(event.name)}</strong><span>⌖ &nbsp; ${escapeHtml(event.location || 'Location TBC')}</span></div>
      <div class="summary-cell"><span>Role / Dept</span><strong>${escapeHtml(roles || 'Freelancer')}</strong><small>${escapeHtml(departments)}</small></div>
      <div class="summary-cell"><span>Invoices</span><strong>${invoices.length} / ${event.invoiceLimit}</strong><em class="status-badge ${statusClass(submissionStatusSummary(invoices))}">${submissionStatusSummary(invoices)}</em></div>
      <div class="summary-cell"><span>Claims</span><strong>${claims.length} / ${event.claimLimit}</strong><em class="status-badge ${statusClass(submissionStatusSummary(claims))}">${submissionStatusSummary(claims)}</em></div>
      <div class="summary-cell totals"><span>Totals (Submitted)</span><strong>Invoice: &nbsp; ${money(event.invoiceTotal)}</strong><strong>Claims: &nbsp; ${money(event.claimTotal)}</strong></div>
      <span class="event-chevron">⌄</span>
    </summary>
    <div class="event-submissions">
      <section><header><h3>Invoices (${invoices.length} of ${event.invoiceLimit})</h3></header>
        ${invoiceRows(company, invoices)}${dropZone(company, event, 'invoice')}
        <footer><strong>Total Invoice Amount</strong><b>${money(event.invoiceTotal)}</b></footer></section>
      <section><header><h3>Claims (${claims.length} of ${event.claimLimit})</h3></header>
        ${claimRows(company, claims)}${dropZone(company, event, 'claim')}
        <footer><strong>Total Claims Amount</strong><b>${money(event.claimTotal)}</b></footer></section>
    </div>
  </details>`;
}

function renderCompanies() {
  const existingCards = [...document.querySelectorAll('.event-card[data-event-key]')];
  const previousState = {
    hadCards: existingCards.length > 0,
    openEvents: new Set(
      existingCards.filter(card => card.open).map(card => card.dataset.eventKey)
    ),
    openReasons: new Set(
      [...document.querySelectorAll('[data-denial-toggle][aria-expanded="true"]')]
        .map(button => button.dataset.denialToggle)
    ),
    scrollY: window.scrollY
  };
  const selectedCompany = byId('companyFilter').value || 'all';
  const desiredPast = workerEventTab === 'past';
  let opened = false;
  const html = workerPortalData.companies.map(company => {
    if (selectedCompany !== 'all' && selectedCompany !== company.code) return '';
    const events = company.events.filter(event => Boolean(event.isPast) === desiredPast);
    if (!events.length) return '';
    return `<section class="company-section"><header><span class="company-icon">▥</span>
      <h2>${escapeHtml(company.name)}</h2></header>
      ${events.map(event => {
        const eventKey = `${company.code}:${event.id}`;
        const shouldOpen = previousState.hadCards
          ? previousState.openEvents.has(eventKey)
          : false;
        const result = renderEvent(company, event, shouldOpen);
        opened = true;
        return result;
      }).join('')}</section>`;
  }).join('');
  byId('companyEvents').innerHTML = html || `<div class="empty-view">No ${desiredPast ? 'past' : 'active'} events match this company filter.</div>`;
  bindPortalActions();
  previousState.openReasons.forEach(id => {
    const button = [...document.querySelectorAll('[data-denial-toggle]')]
      .find(item => item.dataset.denialToggle === id);
    const note = byId(`denialReason-${id}`);
    if (button && note) {
      button.setAttribute('aria-expanded', 'true');
      note.hidden = false;
    }
  });
  requestAnimationFrame(() => window.scrollTo({
    top: previousState.scrollY,
    behavior: 'auto'
  }));
}

function renderStatistics() {
  const events = allEvents();
  const period = byId('statisticsPeriod').value || 'year';
  const month = byId('statisticsMonth').value;
  const year = byId('statisticsYear').value;
  const submissions = events.flatMap(({ event }) => [
    ...event.submissions.invoices.map(row => ({ ...row, kind: 'Invoice' })),
    ...event.submissions.claims.map(row => ({ ...row, kind: 'Claim' }))
  ]).filter(row => {
    const earned = ['Approved', 'Paid'].includes(row.adminStatus) || row.status === 'Payment Confirmed';
    if (!earned) return false;
    const date = new Date(row.submittedAt);
    if (Number.isNaN(date.getTime())) return false;
    if (period === 'month') return month && row.submittedAt.slice(0, 7) === month;
    return String(date.getFullYear()) === String(year);
  });
  const invoiceTotal = submissions.filter(row => row.kind === 'Invoice')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const claimTotal = submissions.filter(row => row.kind === 'Claim')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const total = invoiceTotal + claimTotal;
  byId('statisticsGrid').innerHTML = [
    ['Total Earned', money(total)],
    ['Invoices', money(invoiceTotal)],
    ['Claims', money(claimTotal)],
    ['Approved / Paid Files', submissions.length]
  ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join('');
}

function renderPortal() {
  const companies = workerPortalData.companies || [];
  if (!companies.length) {
    sessionStorage.removeItem('aimWorkerPortal');
    window.location.href = '/login?worker=1';
    return;
  }
  const worker = companies[0].freelancer;
  byId('workerName').textContent = worker.name;
  byId('workerPhone').textContent = worker.phone;
  byId('workerAvatar').textContent = initials(worker.name);
  if (!byId('workerProfileForm').contains(document.activeElement)) {
    byId('profilePhone').value = worker.phone;
    byId('profileCredentialType').value = worker.credentialType || 'password';
  }
  const activeCount = allEvents().filter(row => !row.event.isPast).length;
  const pastCount = allEvents().filter(row => row.event.isPast).length;
  byId('activeEventCount').textContent = activeCount;
  byId('pastEventCount').textContent = pastCount;
  const currentFilter = byId('companyFilter').value || 'all';
  byId('companyFilter').innerHTML = [
    '<option value="all">All Companies</option>',
    ...companies.map(company => `<option value="${escapeHtml(company.code)}">${escapeHtml(company.name)}</option>`)
  ].join('');
  if ([...byId('companyFilter').options].some(option => option.value === currentFilter)) {
    byId('companyFilter').value = currentFilter;
  }
  renderCompanies();
  renderStatistics();
}

function findContext(companyCode, eventId) {
  const company = workerPortalData.companies.find(row => row.code === companyCode);
  const event = company?.events.find(row => Number(row.id) === Number(eventId));
  return { company, event };
}

async function uploadFiles(company, event, kind, files) {
  const selectedFiles = [...files];
  if (!selectedFiles.length) return;
  if (activeUploads > 0) {
    showMessage(byId('portalMessage'), 'Please wait for the current upload to finish.');
    return;
  }
  const remaining = kind === 'invoice'
    ? event.invoiceSlotsRemaining
    : event.claimSlotsRemaining;
  if (selectedFiles.length > remaining) {
    showMessage(byId('portalMessage'), `Only ${remaining} ${kind} upload slot${remaining === 1 ? ' is' : 's are'} available.`);
    return;
  }
  const form = new FormData();
  form.append('token', company.token);
  form.append('eventId', event.id);
  form.append('kind', kind);
  form.append('warningAcknowledged', 'true');
  selectedFiles.forEach(file => form.append('files', file, file.name));
  const plural = kind === 'invoice' ? 'invoices' : 'claims';
  const optimisticIds = selectedFiles.map((file, index) => {
    const id = `uploading-${Date.now()}-${index}`;
    event.submissions[plural].push({
      id,
      originalName: file.name,
      submittedAt: new Date().toISOString(),
      amount: null,
      claimDate: '',
      category: '',
      status: 'Uploading',
      adminStatus: 'Pending Review',
      contentType: file.type,
      clientOnly: true,
      canEdit: false,
      canConfirmPayment: false
    });
    return id;
  });
  const slotsKey = kind === 'invoice' ? 'invoiceSlotsRemaining' : 'claimSlotsRemaining';
  event[slotsKey] = Math.max(0, Number(event[slotsKey] || 0) - selectedFiles.length);
  activeUploads += 1;
  showMessage(byId('portalMessage'), '');
  renderPortal();
  try {
    let processingShown = false;
    const response = await uploadWithProgress('/api/worker/submissions', form, (progress, phase) => {
      if (phase === 'processing' && !processingShown) {
        processingShown = true;
        event.submissions[plural].forEach(row => {
          if (optimisticIds.includes(row.id)) {
            row.status = 'Processing';
            row.processingState = 'Processing';
          }
        });
        renderPortal();
        return;
      }
      optimisticIds.forEach(id => {
        const bar = document.querySelector(`[data-upload-progress="${id}"]`);
        const label = document.querySelector(`[data-upload-progress-label="${id}"]`);
        if (bar) bar.style.width = `${progress}%`;
        if (label) label.textContent = `${Math.round(progress)}%`;
      });
    });
    replaceCompany(response.data);
  } catch (error) {
    event.submissions[plural] = event.submissions[plural].filter(
      row => !optimisticIds.includes(row.id)
    );
    event[slotsKey] = Number(event[slotsKey] || 0) + selectedFiles.length;
    renderPortal();
    showMessage(byId('portalMessage'), error.message);
  } finally {
    activeUploads = Math.max(0, activeUploads - 1);
  }
}

function uploadWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable) {
        const percent = (event.loaded / event.total) * 100;
        onProgress(percent, percent >= 100 ? 'processing' : 'uploading');
      }
    });
    xhr.upload.addEventListener('load', () => onProgress(100, 'processing'));
    xhr.addEventListener('load', () => {
      let payload = {};
      try { payload = JSON.parse(xhr.responseText || '{}'); } catch (_error) {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else {
        const error = new Error(payload.error || 'The upload could not be completed.');
        error.status = xhr.status;
        reject(error);
      }
    });
    xhr.addEventListener('error', () => reject(new Error('The upload could not be completed.')));
    xhr.send(formData);
  });
}

function openClaimModal(company, event, row) {
  pendingClaimContext = { company, event, row };
  byId('claimDetailsForm').reset();
  byId('claimToken').value = company.token;
  byId('claimEventId').value = event.id;
  byId('claimSubmissionId').value = row.id;
  byId('claimContext').textContent = `${company.name} · ${event.name} · ${row.originalName}`;
  byId('claimAmount').value = row.amount == null ? '' : Number(row.amount).toFixed(2);
  byId('claimDate').value = row.claimDate || '';
  byId('claimCategory').value = ['Cab', 'Parking', 'Meal'].includes(row.category) ? row.category : (row.category ? 'Other' : '');
  byId('otherCategoryField').hidden = byId('claimCategory').value !== 'Other';
  byId('otherCategory').required = byId('claimCategory').value === 'Other';
  byId('otherCategory').value = byId('claimCategory').value === 'Other' ? row.category : '';
  byId('claimNotes').value = row.notes || '';
  byId('claimPreview').innerHTML = String(row.contentType || '').startsWith('image/')
    ? `<img src="${escapeHtml(row.fileUrl)}" alt="Claim preview">`
    : `<iframe src="${escapeHtml(row.fileUrl)}" title="Claim preview"></iframe>`;
  showMessage(byId('claimMessage'), '');
  byId('claimModal').classList.add('open');
  byId('claimModal').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeClaimModal() {
  byId('claimModal').classList.remove('open');
  byId('claimModal').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  pendingClaimContext = null;
}

function handleDroppedFiles(zone, files) {
  if (!files?.length) return;
  const { company, event } = findContext(zone.dataset.company, zone.dataset.event);
  if (!company || !event) return;
  uploadFiles(company, event, zone.dataset.dropKind, files);
}

function bindPortalActions() {
  document.querySelectorAll('.event-dropzone').forEach(zone => {
    const input = zone.querySelector('input');
    input.addEventListener('change', () => handleDroppedFiles(zone, input.files));
    for (const eventName of ['dragenter', 'dragover']) {
      zone.addEventListener(eventName, event => {
        event.preventDefault();
        zone.classList.add('dragging');
      });
    }
    for (const eventName of ['dragleave', 'drop']) {
      zone.addEventListener(eventName, event => {
        event.preventDefault();
        zone.classList.remove('dragging');
      });
    }
    zone.addEventListener('drop', event => handleDroppedFiles(zone, event.dataTransfer.files));
  });
  document.querySelectorAll('[data-claim-details]').forEach(rowElement => {
    rowElement.addEventListener('click', event => {
      if (event.target.closest('[data-delete-submission]')) return;
      const company = workerPortalData.companies.find(item => item.code === rowElement.dataset.company);
      const eventRow = company?.events.find(item =>
        item.submissions.claims.some(claim => claim.id === rowElement.dataset.claimDetails)
      );
      const claim = eventRow?.submissions.claims.find(item => item.id === rowElement.dataset.claimDetails);
      if (company && eventRow && claim) openClaimModal(company, eventRow, claim);
    });
  });
  document.querySelectorAll('[data-delete-submission]').forEach(button => {
    button.addEventListener('click', async () => {
      const company = workerPortalData.companies.find(row => row.code === button.dataset.company);
      if (!company) return;
      try {
        const response = await fetchJson(`/api/worker/submissions/${encodeURIComponent(button.dataset.deleteSubmission)}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: company.token })
        });
        replaceCompany(response.data);
        showMessage(byId('portalMessage'), 'Submission removed. You may upload a replacement.', 'success');
      } catch (error) {
        showMessage(byId('portalMessage'), error.message);
      }
    });
  });
  document.querySelectorAll('[data-confirm-payment]').forEach(button => {
    button.addEventListener('click', async () => {
      const company = workerPortalData.companies.find(row => row.code === button.dataset.company);
      if (!company) return;
      try {
        const response = await fetchJson(`/api/worker/submissions/${encodeURIComponent(button.dataset.confirmPayment)}/confirm-payment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: company.token })
        });
        replaceCompany(response.data);
        showMessage(byId('portalMessage'), 'Payment receipt confirmed.', 'success');
      } catch (error) {
        showMessage(byId('portalMessage'), error.message);
      }
    });
  });
  document.querySelectorAll('[data-denial-toggle]').forEach(button => {
    button.addEventListener('click', () => {
      const note = byId(`denialReason-${button.dataset.denialToggle}`);
      if (!note) return;
      const opening = note.hidden;
      note.hidden = !opening;
      button.setAttribute('aria-expanded', String(opening));
    });
  });
}

function showWorkerView(view) {
  document.querySelectorAll('.worker-view').forEach(node => node.classList.toggle('active', node.id === `${view}View`));
  document.querySelectorAll('[data-worker-view]').forEach(button => button.classList.toggle('active', button.dataset.workerView === view));
  document.body.classList.remove('mobile-nav-open');
}

async function refreshCompany(company) {
  try {
    const response = await fetchJson('/api/worker/company', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: company.token })
    });
    return response.data;
  } catch (error) {
    if (error.status === 401) {
      sessionStorage.removeItem('aimWorkerPortal');
      window.location.replace('/login');
    }
    return company;
  }
}

function portalContentSignature(companies) {
  return JSON.stringify(companies, (key, value) => {
    if (key === 'token') return '';
    if (key === 'fileUrl' && typeof value === 'string') {
      return value.replace(/([?&])token=[^&]*/g, '$1token=');
    }
    return value;
  });
}

function startStatusPolling() {
  clearInterval(workerPollTimer);
  workerPollTimer = setInterval(async () => {
    if (document.hidden || activeUploads > 0) return;
    const previousSignature = portalContentSignature(workerPortalData.companies);
    const refreshedCompanies = await Promise.all(workerPortalData.companies.map(refreshCompany));
    const nextSignature = portalContentSignature(refreshedCompanies);
    workerPortalData.companies = refreshedCompanies;
    savePortalSession();
    if (previousSignature !== nextSignature) renderPortal();
  }, 5000);
}

document.querySelectorAll('[data-worker-view]').forEach(button =>
  button.addEventListener('click', () => showWorkerView(button.dataset.workerView))
);
document.querySelectorAll('[data-event-tab]').forEach(button => {
  button.addEventListener('click', () => {
    workerEventTab = button.dataset.eventTab;
    document.querySelectorAll('[data-event-tab]').forEach(item => item.classList.toggle('active', item === button));
    renderCompanies();
  });
});
byId('companyFilter').addEventListener('change', renderCompanies);
byId('statisticsPeriod').addEventListener('change', event => {
  const monthly = event.target.value === 'month';
  byId('statisticsMonth').hidden = !monthly;
  byId('statisticsYear').hidden = monthly;
  renderStatistics();
});
byId('statisticsMonth').addEventListener('change', renderStatistics);
byId('statisticsYear').addEventListener('change', renderStatistics);
byId('mobileMenuButton').addEventListener('click', () => document.body.classList.toggle('mobile-nav-open'));
byId('workerSignout').addEventListener('click', () => {
  sessionStorage.removeItem('aimWorkerPortal');
  window.location.href = '/login';
});
document.querySelectorAll('[data-close-claim]').forEach(button => button.addEventListener('click', closeClaimModal));
byId('claimCategory').addEventListener('change', event => {
  const other = event.target.value === 'Other';
  byId('otherCategoryField').hidden = !other;
  byId('otherCategory').required = other;
});
byId('claimDetailsForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!pendingClaimContext) return;
  const button = event.currentTarget.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const response = await fetchJson(
      `/api/worker/submissions/${encodeURIComponent(byId('claimSubmissionId').value)}/details`,
      {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: byId('claimToken').value,
        amount: byId('claimAmount').value,
        claimDate: byId('claimDate').value,
        category: byId('claimCategory').value,
        otherCategory: byId('otherCategory').value,
        notes: byId('claimNotes').value
      })
    });
    replaceCompany(response.data);
    closeClaimModal();
    showMessage(byId('portalMessage'), 'Claim details submitted for review.', 'success');
  } catch (error) {
    showMessage(byId('claimMessage'), error.message);
  } finally {
    button.disabled = false;
  }
});
byId('workerProfileForm').addEventListener('submit', async event => {
  event.preventDefault();
  const worker = workerPortalData.companies[0]?.freelancer;
  if (!worker) return;
  const button = event.currentTarget.querySelector('[type="submit"]');
  button.disabled = true;
  showMessage(byId('profileMessage'), '');
  try {
    const response = await fetchJson('/api/worker/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: worker.phone,
        newPhone: byId('profilePhone').value,
        currentPassword: byId('profileCurrentPassword').value,
        newPassword: byId('profileNewPassword').value,
        confirmation: byId('profileNewPasswordConfirmation').value,
        credentialType: byId('profileCredentialType').value
      })
    });
    workerPortalData = response.data;
    savePortalSession();
    event.currentTarget.reset();
    renderPortal();
    showMessage(byId('profileMessage'), 'Profile updated.', 'success');
  } catch (error) {
    showMessage(byId('profileMessage'), error.message);
  } finally {
    button.disabled = false;
  }
});

try {
  workerPortalData = JSON.parse(sessionStorage.getItem('aimWorkerPortal') || '{"companies":[]}');
} catch (_error) {
  workerPortalData = { companies: [] };
}
const statisticsNow = new Date();
byId('statisticsMonth').value = `${statisticsNow.getFullYear()}-${String(statisticsNow.getMonth() + 1).padStart(2, '0')}`;
const statisticsYears = [...new Set([
  statisticsNow.getFullYear(),
  ...allEvents().flatMap(({ event }) => [
    ...(event.submissions?.invoices || []),
    ...(event.submissions?.claims || [])
  ]).map(row => new Date(row.submittedAt).getFullYear()).filter(Number.isFinite)
])].sort((a, b) => b - a);
byId('statisticsYear').innerHTML = statisticsYears.map(year => `<option>${year}</option>`).join('');
if (!workerPortalData.companies?.length) {
  window.location.replace('/login');
} else {
  renderPortal();
  startStatusPolling();
}
