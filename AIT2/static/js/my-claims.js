const MY_CLAIMS_TRANSIENT_UPLOAD_STATUSES = new Set(['Uploading', 'Queueing']);
const MY_CLAIMS_PROCESSING_STATES = new Set(['Queued', 'Processing']);
const MY_CLAIMS_EDITABLE_STATUSES = new Set(['Pending Review', 'Denied']);

let myClaimsData = null;
let myClaimsSelectedEventId = '';
let myClaimsQueueActive = false;
let myClaimsSequence = 0;
let myClaimsUploadKind = 'claim';
let myClaimsPollTimer = null;
let myClaimsEditId = '';
let myClaimsEditKind = 'claim';
let myClaimsProgressFrame = null;

const myClaimsUploads = new Map();

function myClaimsEscape(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[character]);
}

function myClaimsMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `S$${amount.toFixed(2)}` : 'Processing';
}

function myClaimsEvent() {
  return (myClaimsData?.events || [])
    .find(event => Number(event.id) === Number(myClaimsSelectedEventId));
}

function myClaimsMonth(date) {
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? '---'
    : parsed.toLocaleString('en-GB', { month: 'short' }).toUpperCase();
}

function selectMyClaimsEvent(id) {
  myClaimsSelectedEventId = String(id);
  renderMyClaimsPage();
}

function myClaimsPicker(event) {
  const dates = event.startDate === event.endDate
    ? event.startDate
    : `${event.startDate} – ${event.endDate}`;

  return `
    <button type="button" class="plan-event-select-wrap my-claims-picker" aria-haspopup="dialog"
      aria-label="Choose an assigned event" onclick="planOpenEventChooser('my-claims')">
      <div class="plan-event-icon" aria-hidden="true">${planMetricIconSvg('calendar')}</div>
      <div class="my-claims-picker-copy">
        <div class="plan-event-title-row">
          <span class="plan-event-id">#${event.id}</span>
          <span class="plan-event-name">${myClaimsEscape(event.name)}</span>
        </div>
        <div class="plan-event-meta">
          <span>${myClaimsEscape(dates)}</span>
          ${event.location ? `<span aria-hidden="true">•</span><span>${myClaimsEscape(event.location)}</span>` : ''}
        </div>
      </div>
      <span class="plan-event-picker-chevron" aria-hidden="true">⌄</span>
    </button>`;
}

function myClaimsDisplayStatus(row) {
  const processing = String(row.processingState || '').trim();
  const stage = String(row.submissionStage || '').trim();
  if (MY_CLAIMS_PROCESSING_STATES.has(processing)) return processing;
  if (MY_CLAIMS_PROCESSING_STATES.has(stage) || stage === 'Details Required') return stage;
  return row.status === 'Pending Review' ? 'Submitted' : (row.status || 'Submitted');
}

function myClaimsStatus(row, kind) {
  const label = row.clientOnly ? row.status : myClaimsDisplayStatus(row);
  if (MY_CLAIMS_TRANSIENT_UPLOAD_STATUSES.has(label)) {
    const progress = label === 'Queueing' ? 100 : Math.round(Number(row.uploadProgress || 0));
    return `
      <span class="my-claim-upload-state" role="status" aria-live="polite" aria-atomic="true">
        <em class="status-${label.toLowerCase()}">${label}</em>
        <i aria-hidden="true"><b style="width:${progress}%"></b></i>
        <small>${label === 'Queueing' ? 'Queueing' : `${progress}%`}</small>
      </span>`;
  }
  if (MY_CLAIMS_PROCESSING_STATES.has(label)) {
    return `<em class="status-${label.toLowerCase()}" role="status" aria-live="polite">${label}</em>`;
  }
  if (label === 'Failed') {
    return `
      <span class="my-claim-upload-state" role="alert">
        <em class="status-failed">Failed</em>
        <small>${myClaimsEscape(row.processingError || 'Upload failed')}</small>
      </span>`;
  }
  if (label === 'Details Required') {
    return `
      <button class="my-claim-status-button status-details-required" type="button"
        data-edit-my-submission="${row.id}" data-kind="${kind}">Details Required</button>`;
  }
  const statusClass = String(label).toLowerCase().replace(/\s+/g, '-');
  return `<em class="status-${statusClass}">${myClaimsEscape(label)}</em>`;
}

function myClaimsRows(event, kind) {
  const key = kind === 'invoice' ? 'invoices' : 'claims';
  const pending = [...myClaimsUploads.values()].filter(row => (
    Number(row.eventId) === Number(event.id) && row.kind === kind
  ));
  return [...pending, ...(event[key] || [])];
}

function myClaimsRowActions(row) {
  if (row.clientOnly) return '';
  if (!MY_CLAIMS_EDITABLE_STATUSES.has(row.status)) return '';
  return `
    <span class="my-claim-actions">
      <button class="danger trash" type="button" data-delete-my-submission="${row.id}"
        title="Delete submission" aria-label="Delete submission">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path>
        </svg>
      </button>
    </span>`;
}

function myClaimsSection(event, kind) {
  const invoice = kind === 'invoice';
  const key = invoice ? 'invoices' : 'claims';
  const limit = event[`${kind}Limit`];
  const remaining = event[`${kind}SlotsRemaining`];
  const rows = myClaimsRows(event, kind);
  const active = limit - remaining;
  const acceptedFiles = invoice ? '.pdf,.xls,.xlsx,.csv' : 'PDF, PNG or JPG';
  const total = (event[key] || [])
    .filter(row => row.status !== 'Denied')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);

  const rowsMarkup = rows.length
    ? rows.map(row => {
      const editable = !row.clientOnly
        && MY_CLAIMS_EDITABLE_STATUSES.has(row.status)
        && !MY_CLAIMS_PROCESSING_STATES.has(row.processingState);
      const name = myClaimsEscape(row.originalName || `${kind} file`);
      const date = row.claimDate || row.submittedAt?.slice(0, 10) || 'Awaiting processing';
      return `
        <article class="my-claim-row">
          <div class="my-claim-file">
            <span>${invoice ? 'IN' : 'CL'}</span>
            <div>
              ${editable
                ? `<button type="button" data-edit-my-submission="${row.id}" data-kind="${kind}">${name}</button>`
                : `<strong>${name}</strong>`}
              <small>${myClaimsEscape(date)}${row.category ? ` · ${myClaimsEscape(row.category)}` : ''}</small>
            </div>
          </div>
          <b>${myClaimsMoney(row.amount)}</b>
          ${myClaimsStatus(row, kind)}
          ${myClaimsRowActions(row)}
          ${row.denialReason ? `<p>${myClaimsEscape(row.denialReason)}</p>` : ''}
        </article>`;
    }).join('')
    : `<div class="my-claims-empty compact"><p>No ${key} uploaded for this event.</p></div>`;

  const accept = invoice
    ? '.pdf,.xls,.xlsx,.csv,application/pdf'
    : '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';

  return `
    <section class="my-claims-submission-group" data-my-claims-drop="${kind}">
      <div class="my-claims-submissions-head">
        <div>
          <h3>${invoice ? 'Invoices' : 'Claims'} (${active} of ${limit})</h3>
          <p>${invoice ? 'Upload your invoice for this event.' : 'Upload receipts for expense claims.'}</p>
        </div>
        <button class="my-claims-primary" type="button" data-open-my-upload="${kind}"
          ${remaining <= 0 ? 'disabled' : ''}>Upload ${invoice ? 'invoice' : 'claim'} files</button>
      </div>
      <div class="my-claims-list">${rowsMarkup}</div>
      <label class="my-claims-inline-drop">
        <input type="file" data-inline-file="${kind}" accept="${accept}" multiple hidden>
        <strong>Drag &amp; drop or choose ${invoice ? 'invoice' : 'claim'} files</strong>
        <small>${remaining} slot${remaining === 1 ? '' : 's'} available · ${acceptedFiles}</small>
      </label>
      <footer><strong>Total ${key}</strong><b>${myClaimsMoney(total)}</b></footer>
    </section>`;
}

function renderMyClaimsPage() {
  const root = document.getElementById('my-claims-root');
  if (!root || !myClaimsData) return;

  const events = myClaimsData.events || [];
  if (!myClaimsSelectedEventId && events.length) {
    myClaimsSelectedEventId = String(events[0].id);
  }
  const event = myClaimsEvent();
  const pageMarkup = event
    ? `
      <div class="my-claims-selector-row">${myClaimsPicker(event)}</div>
      <section class="my-claims-event-card">
        <header>
          <div class="my-claims-date">
            <b>${myClaimsEscape(event.startDate.slice(8, 10) || '--')}</b>
            <span>${myClaimsMonth(event.startDate)}</span>
          </div>
          <div>
            <h2>${myClaimsEscape(event.name)}</h2>
            <p>${myClaimsEscape(event.location || 'Location not specified')}</p>
          </div>
          <div class="my-claims-event-meta">
            <span>${myClaimsEscape(event.startDate)} — ${myClaimsEscape(event.endDate)}</span>
            <small>${myClaimsEscape(event.departments.join(', '))}</small>
          </div>
        </header>
        <div class="my-claims-submissions">
          ${myClaimsSection(event, 'invoice')}
          ${myClaimsSection(event, 'claim')}
        </div>
      </section>`
    : `
      <div class="my-claims-empty">
        <h2>No assigned events</h2>
        <p>Your events will appear after an admin assigns you in Manpower &amp; Vendors.</p>
      </div>`;

  root.innerHTML = `
    <header class="my-claims-heading">
      <div>
        <span class="my-claims-eyebrow">EMPLOYEE PORTAL</span>
        <h1>My Events &amp; Submissions</h1>
        <p>Upload invoices and claims for your assigned events.</p>
      </div>
    </header>
    ${pageMarkup}
    <div class="my-claims-modal" id="myClaimsUploadModal" aria-hidden="true">
      <div class="my-claims-backdrop" data-close-my-claims></div>
      <section role="dialog" aria-modal="true" aria-labelledby="myClaimsUploadTitle">
        <header>
          <div>
            <span class="my-claims-eyebrow">NEW SUBMISSION</span>
            <h2 id="myClaimsUploadTitle">Upload files</h2>
          </div>
          <button type="button" data-close-my-claims aria-label="Close upload dialog">&times;</button>
        </header>
        <div class="my-claims-upload-context">
          <strong>${myClaimsEscape(event?.name || '')}</strong>
          <span id="myClaimsModalSlots"></span>
        </div>
        <label class="my-claims-dropzone" id="myClaimsDropzone">
          <input id="myClaimsFileInput" type="file" multiple hidden>
          <span class="my-claims-upload-icon" aria-hidden="true">↑</span>
          <strong>Drag &amp; drop files here</strong>
          <small>or click to choose files</small>
        </label>
        <p class="my-claims-upload-note">Files enter the upload and processing queues immediately.</p>
        <footer>
          <button class="my-claims-secondary" type="button" data-close-my-claims>Cancel</button>
          <button class="my-claims-primary" type="button" id="chooseMyClaimFiles">Choose files</button>
        </footer>
      </section>
    </div>`;
  bindMyClaimsActions();
}

function scheduleMyClaimsProgressRender() {
  if (myClaimsProgressFrame !== null) return;
  myClaimsProgressFrame = requestAnimationFrame(() => {
    myClaimsProgressFrame = null;
    renderMyClaimsPage();
  });
}

function bindMyClaimsActions() {
  ensureMyClaimsDetailsModal();
  document.querySelectorAll('[data-open-my-upload]').forEach(button => {
    button.addEventListener('click', () => openMyClaimsUpload(button.dataset.openMyUpload));
  });
  document.querySelectorAll('[data-close-my-claims]').forEach(node => {
    node.addEventListener('click', closeMyClaimsUpload);
  });
  document.querySelectorAll('[data-inline-file]').forEach(input => {
    input.addEventListener('change', () => queueMyClaimFiles(input.files, input.dataset.inlineFile));
  });
  document.querySelectorAll('[data-edit-my-submission]').forEach(button => {
    button.addEventListener('click', () => {
      openMyClaimsDetails(button.dataset.editMySubmission, button.dataset.kind);
    });
  });
  document.querySelectorAll('[data-delete-my-submission]').forEach(button => {
    button.addEventListener('click', () => deleteMyClaimsSubmission(button.dataset.deleteMySubmission));
  });
  document.querySelectorAll('[data-my-claims-drop]').forEach(zone => {
    ['dragenter', 'dragover'].forEach(eventName => {
      zone.addEventListener(eventName, event => {
        event.preventDefault();
        zone.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(eventName => {
      zone.addEventListener(eventName, event => {
        event.preventDefault();
        zone.classList.remove('dragging');
      });
    });
    zone.addEventListener('drop', event => {
      queueMyClaimFiles(event.dataTransfer.files, zone.dataset.myClaimsDrop);
    });
  });

  const input = document.getElementById('myClaimsFileInput');
  const zone = document.getElementById('myClaimsDropzone');
  document.getElementById('chooseMyClaimFiles')?.addEventListener('click', () => input.click());
  input?.addEventListener('change', () => queueMyClaimFiles(input.files, myClaimsUploadKind));
  ['dragenter', 'dragover'].forEach(eventName => {
    zone?.addEventListener(eventName, event => {
      event.preventDefault();
      zone.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach(eventName => {
    zone?.addEventListener(eventName, event => {
      event.preventDefault();
      zone.classList.remove('dragging');
    });
  });
  zone?.addEventListener('drop', event => {
    queueMyClaimFiles(event.dataTransfer.files, myClaimsUploadKind);
  });
}

function ensureMyClaimsDetailsModal() {
  if (document.getElementById('myClaimsDetailsModal')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="my-claims-modal" id="myClaimsDetailsModal" aria-hidden="true">
      <div class="my-claims-backdrop" data-close-my-details></div>
      <section class="my-claims-details-card wf-modal-card wide" role="dialog" aria-modal="true"
        aria-labelledby="myClaimsDetailsTitle">
        <header>
          <div>
            <span class="my-claims-eyebrow">SUBMISSION DETAILS</span>
            <h2 id="myClaimsDetailsTitle">Add details</h2>
          </div>
          <button type="button" data-close-my-details aria-label="Close submission details dialog">&times;</button>
        </header>
        <div class="my-claims-details-body wf-review-layout">
          <div class="my-claims-preview wf-preview" id="myClaimsPreview"></div>
          <form class="wf-review-form" id="myClaimsDetailsForm">
            <div class="my-claims-details-grid">
              <label><span>Amount (S$) *</span><input name="amount" type="number" min=".01" step=".01" required></label>
              <label data-claim-detail><span>Claim date *</span><input name="claimDate" type="date"></label>
              <label data-claim-detail>
                <span>Category *</span>
                <select name="category">
                  <option value="">Choose category</option>
                  <option>Meal</option>
                  <option>Transport</option>
                  <option>Purchase</option>
                  <option>Other</option>
                </select>
              </label>
              <label class="full"><span>Notes</span><textarea name="notes" rows="3"></textarea></label>
            </div>
            <footer>
              <button class="my-claims-secondary" type="button" data-close-my-details>Cancel</button>
              <button class="my-claims-primary" type="submit">Save details</button>
            </footer>
          </form>
        </div>
      </section>
    </div>`);
  document.querySelectorAll('[data-close-my-details]').forEach(node => {
    node.addEventListener('click', closeMyClaimsDetails);
  });
  document.getElementById('myClaimsDetailsForm').addEventListener('submit', saveMyClaimsDetails);
}

function findMyClaimsSubmission(id) {
  for (const event of myClaimsData?.events || []) {
    for (const kind of ['invoice', 'claim']) {
      const key = kind === 'invoice' ? 'invoices' : 'claims';
      const row = (event[key] || []).find(item => String(item.id) === String(id));
      if (row) return { row, kind };
    }
  }
  return null;
}

function openMyClaimsDetails(id, kind) {
  const found = findMyClaimsSubmission(id);
  if (!found) return;
  myClaimsEditId = id;
  myClaimsEditKind = kind;

  const form = document.getElementById('myClaimsDetailsForm');
  form.elements.amount.value = found.row.amount ?? '';
  form.elements.claimDate.value = found.row.claimDate || '';
  form.elements.category.value = found.row.category || '';
  form.elements.notes.value = found.row.notes || '';
  document.querySelectorAll('[data-claim-detail]').forEach(node => {
    node.hidden = kind !== 'claim';
  });
  form.elements.claimDate.required = kind === 'claim';
  form.elements.category.required = kind === 'claim';
  document.getElementById('myClaimsDetailsTitle').textContent = `${kind === 'invoice' ? 'Invoice' : 'Claim'} details`;

  const preview = document.getElementById('myClaimsPreview');
  const url = found.row.fileUrl;
  const name = String(found.row.originalName || '').toLowerCase();
  const type = String(found.row.contentType || '').toLowerCase();
  if (type.startsWith('image/') || /\.(png|jpe?g)$/.test(name)) {
    preview.innerHTML = `<img src="${myClaimsEscape(url)}" alt="Uploaded file preview">`;
  } else if (type === 'application/pdf' || name.endsWith('.pdf')) {
    preview.innerHTML = `<iframe src="${myClaimsEscape(url)}#toolbar=1" title="Uploaded PDF"></iframe>`;
  } else {
    preview.innerHTML = `
      <div>
        <strong>Preview unavailable</strong>
        <span>This file type cannot be previewed in the browser.</span>
        <a href="${myClaimsEscape(url)}?download=1">Download file</a>
      </div>`;
  }

  const modal = document.getElementById('myClaimsDetailsModal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeMyClaimsDetails() {
  const modal = document.getElementById('myClaimsDetailsModal');
  modal?.classList.remove('open');
  modal?.setAttribute('aria-hidden', 'true');
}

async function saveMyClaimsDetails(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const response = await apiCall(`/api/my-claims/${encodeURIComponent(myClaimsEditId)}`, 'PUT', {
      amount: form.elements.amount.value,
      claimDate: form.elements.claimDate.value,
      category: form.elements.category.value,
      notes: form.elements.notes.value
    });
    myClaimsData = response.data;
    closeMyClaimsDetails();
    renderMyClaimsPage();
    showNotification('success', response.message || 'Details saved');
  } catch (error) {
    showNotification('error', error.message);
  } finally {
    button.disabled = false;
  }
}

async function deleteMyClaimsSubmission(id) {
  const confirmed = await showAppConfirm({
    title: 'Delete submission?',
    message: 'This will permanently remove the uploaded file.',
    confirmText: 'Delete',
    variant: 'danger'
  });
  if (!confirmed) return;

  try {
    const response = await apiCall(`/api/my-claims/${encodeURIComponent(id)}`, 'DELETE');
    myClaimsData = response.data;
    renderMyClaimsPage();
    showNotification('success', response.message || 'Submission deleted');
  } catch (error) {
    showNotification('error', error.message);
  }
}

function openMyClaimsUpload(kind) {
  myClaimsUploadKind = kind;
  const event = myClaimsEvent();
  const invoice = kind === 'invoice';
  const input = document.getElementById('myClaimsFileInput');
  input.accept = invoice
    ? '.pdf,.xls,.xlsx,.csv,application/pdf'
    : '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';
  document.getElementById('myClaimsUploadTitle').textContent = `Upload ${kind} files`;
  document.getElementById('myClaimsModalSlots').textContent = `${event[`${kind}SlotsRemaining`]} upload slots available`;
  const modal = document.getElementById('myClaimsUploadModal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeMyClaimsUpload() {
  const modal = document.getElementById('myClaimsUploadModal');
  modal?.classList.remove('open');
  modal?.setAttribute('aria-hidden', 'true');
}

function queueMyClaimFiles(list, kind) {
  const event = myClaimsEvent();
  const files = [...list];
  const reserved = [...myClaimsUploads.values()].filter(row => (
    Number(row.eventId) === Number(event.id)
    && row.kind === kind
    && row.status !== 'Failed'
  )).length;
  const remaining = Number(event[`${kind}SlotsRemaining`] || 0) - reserved;
  if (!files.length) return;
  if (files.length > remaining) {
    closeMyClaimsUpload();
    showNotification('error', `Only ${remaining} ${kind} upload slots are available.`);
    return;
  }

  files.forEach(file => {
    const id = `my-upload-${Date.now()}-${++myClaimsSequence}`;
    myClaimsUploads.set(id, {
      id,
      eventId: event.id,
      kind,
      originalName: file.name,
      amount: null,
      status: 'Queued',
      processingState: 'Queued',
      uploadProgress: 0,
      clientOnly: true,
      file
    });
  });
  closeMyClaimsUpload();
  renderMyClaimsPage();
  processMyClaimsQueue();
}

async function processMyClaimsQueue() {
  if (myClaimsQueueActive) return;
  myClaimsQueueActive = true;
  const next = () => [...myClaimsUploads.values()].find(row => row.status === 'Queued');
  let row;
  while ((row = next())) {
    row.status = 'Uploading';
    renderMyClaimsPage();

    const form = new FormData();
    form.append('eventId', row.eventId);
    form.append('kind', row.kind);
    form.append('files', row.file, row.file.name);
    try {
      const payload = await myClaimsUpload(form, progress => {
        row.uploadProgress = progress;
        row.status = progress >= 100 ? 'Queueing' : 'Uploading';
        scheduleMyClaimsProgressRender();
      });
      myClaimsUploads.delete(row.id);
      myClaimsData = payload.data;
      showNotification('success', payload.message);
    } catch (error) {
      row.status = 'Failed';
      row.processingState = 'Failed';
      showNotification('error', error.message);
    }
    renderMyClaimsPage();
  }
  myClaimsQueueActive = false;
}

function myClaimsUpload(form, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/my-claims');
    request.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(event.loaded / event.total * 100);
    };
    request.upload.onload = () => onProgress(100);
    request.onload = () => {
      let payload = {};
      try {
        payload = JSON.parse(request.responseText || '{}');
      } catch (_error) {}
      if (request.status >= 200 && request.status < 300) resolve(payload);
      else reject(new Error(payload.error || 'Upload failed'));
    };
    request.onerror = () => reject(new Error('Upload failed'));
    request.send(form);
  });
}

function startMyClaimsPolling() {
  clearInterval(myClaimsPollTimer);
  myClaimsPollTimer = setInterval(async () => {
    if (
      document.hidden
      || myClaimsQueueActive
      || !document.getElementById('my-claims-section')?.classList.contains('active')
    ) return;

    try {
      const before = JSON.stringify(myClaimsData);
      const response = await apiCall('/api/my-claims');
      const after = JSON.stringify(response.data);
      myClaimsData = response.data;
      if (before !== after) renderMyClaimsPage();
    } catch (_error) {}
  }, 5000);
}

async function loadMyClaimsPage() {
  const root = document.getElementById('my-claims-root');
  if (root) root.innerHTML = '<div class="loading">Loading your submissions...</div>';
  try {
    const response = await apiCall('/api/my-claims');
    myClaimsData = response.data;
    renderMyClaimsPage();
    startMyClaimsPolling();
  } catch (error) {
    if (root) {
      root.innerHTML = `
        <div class="my-claims-empty">
          <h2>Submissions unavailable</h2>
          <p>${myClaimsEscape(error.message)}</p>
        </div>`;
    }
  }
}
