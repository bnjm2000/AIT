let workerPortalData = { companies: [] };
let workerPollTimer = null;
let uploadContext = null;

const byId = id => document.getElementById(id);

function escapeHtml(value) {
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function statusClass(status) {
  return `status-${String(status || 'Pending Review').toLowerCase().replace(/\s+/g, '-')}`;
}

function formatSubmissionDate(value) {
  if (!value) return 'Submitted';
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

function showMessage(element, message, type = 'error') {
  if (!element) return;
  element.textContent = message || '';
  element.className = message ? `${element.className.split(' ')[0]} show ${type}` : element.className.split(' ')[0];
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  let payload = {};
  try {
    payload = await response.json();
  } catch (_error) {
    payload = {};
  }
  if (!response.ok) throw new Error(payload.error || 'Something went wrong. Please try again.');
  return payload;
}

function renderSubmissionRows(rows) {
  if (!rows?.length) {
    return '<div class="submission-row"><span>No submission yet</span></div>';
  }
  return rows.map(row => `
    <div class="submission-row">
      <span>${escapeHtml(formatSubmissionDate(row.submittedAt))}</span>
      <span class="status-badge ${statusClass(row.status)}">${escapeHtml(row.status)}</span>
      ${row.status === 'Denied' && row.denialReason
        ? `<p class="denial-reason">${escapeHtml(row.denialReason)}</p>`
        : ''}
    </div>
  `).join('');
}

function renderEvent(company, event) {
  const assignments = event.assignments.map(assignment => `
    <span class="assignment-chip">
      ${escapeHtml(assignment.department)} · ${escapeHtml(assignment.role)} · ${escapeHtml(assignment.days)} day${assignment.days === 1 ? '' : 's'}
    </span>
  `).join('');
  const invoiceButton = event.canUploadInvoice
    ? `<button class="upload-button" type="button" data-upload-kind="invoice" data-company="${escapeHtml(company.code)}" data-event="${event.id}">Upload invoice</button>`
    : '';
  const claimButton = event.claimSlotsRemaining > 0
    ? `<button class="upload-button" type="button" data-upload-kind="claim" data-company="${escapeHtml(company.code)}" data-event="${event.id}">Add claim (${event.claimSlotsRemaining} left)</button>`
    : '';
  return `
    <article class="worker-event">
      <div>
        <span class="event-date">${escapeHtml(event.startDate === event.endDate ? event.startDate : `${event.startDate} – ${event.endDate}`)}</span>
        <h3>${escapeHtml(event.name)}</h3>
        ${event.location ? `<div class="event-location">⌖ ${escapeHtml(event.location)}</div>` : ''}
      </div>
      <div>
        <p class="assignment-meta"><strong>Your assignments</strong></p>
        ${assignments}
      </div>
      <div class="submission-panel">
        <div>
          <div class="submission-heading">
            <strong>Invoice · PDF only</strong>
            ${invoiceButton}
          </div>
          ${renderSubmissionRows(event.submissions.invoices)}
        </div>
        <div>
          <div class="submission-heading">
            <strong>Claims · up to 5</strong>
            ${claimButton}
          </div>
          ${renderSubmissionRows(event.submissions.claims)}
        </div>
      </div>
    </article>
  `;
}

function renderCompany(company) {
  const current = company.events.filter(event => !event.isPast);
  const past = company.events.filter(event => event.isPast);
  return `
    <section class="company-section" data-company-section="${escapeHtml(company.code)}">
      <header>
        <div>
          <p class="eyebrow">${escapeHtml(company.code)}</p>
          <h2>${escapeHtml(company.name)}</h2>
        </div>
        <span>${company.events.length} event${company.events.length === 1 ? '' : 's'}</span>
      </header>
      <div class="event-list">
        ${current.length ? current.map(event => renderEvent(company, event)).join('') : '<div class="worker-event"><p>No current or upcoming events.</p></div>'}
      </div>
      ${past.length ? `
        <details class="past-events">
          <summary>Past events (${past.length})</summary>
          <div class="event-list">${past.map(event => renderEvent(company, event)).join('')}</div>
        </details>
      ` : ''}
    </section>
  `;
}

function applyCompanyFilter() {
  const selected = byId('companyFilter').value;
  document.querySelectorAll('[data-company-section]').forEach(section => {
    section.hidden = selected !== 'all' && section.dataset.companySection !== selected;
  });
}

function bindUploadButtons() {
  document.querySelectorAll('[data-upload-kind]').forEach(button => {
    button.addEventListener('click', () => {
      const company = workerPortalData.companies.find(row => row.code === button.dataset.company);
      const event = company?.events.find(row => Number(row.id) === Number(button.dataset.event));
      if (company && event) openUploadModal(company, event, button.dataset.uploadKind);
    });
  });
}

function renderPortal() {
  const companies = workerPortalData.companies || [];
  if (!companies.length) return;
  byId('workerGreeting').textContent = `Hello, ${companies[0].freelancer.name}`;
  byId('companyFilter').innerHTML = [
    '<option value="all">All companies</option>',
    ...companies.map(company => `<option value="${escapeHtml(company.code)}">${escapeHtml(company.name)}</option>`)
  ].join('');
  byId('companyEvents').innerHTML = companies.map(renderCompany).join('');
  bindUploadButtons();
  applyCompanyFilter();
}

function setPortalData(data) {
  workerPortalData = data || { companies: [] };
  byId('lookupView').hidden = true;
  byId('portalView').hidden = false;
  renderPortal();
  startStatusPolling();
}

function openUploadModal(company, event, kind) {
  uploadContext = { company, event, kind };
  const isClaim = kind === 'claim';
  byId('uploadToken').value = company.token;
  byId('uploadEventId').value = event.id;
  byId('uploadKind').value = kind;
  byId('uploadModalTitle').textContent = isClaim ? 'Review claim before submitting' : 'Review invoice before submitting';
  byId('uploadContext').textContent = `${company.name} · ${event.name}`;
  byId('claimFields').hidden = !isClaim;
  byId('workerUploadFile').accept = isClaim ? '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg' : '.pdf,application/pdf';
  byId('filePickerHelp').textContent = isClaim ? 'PDF, PNG or JPG · Maximum 10 MB' : 'PDF only · Maximum 10 MB';
  byId('filePickerLabel').textContent = isClaim ? 'Choose claim file' : 'Choose invoice PDF';
  byId('claimDepartment').innerHTML = event.departments.map(department => `<option value="${escapeHtml(department)}">${escapeHtml(department)}</option>`).join('');
  byId('claimDepartmentField').hidden = event.departments.length <= 1;
  if (event.departments.length === 1) byId('claimDepartment').value = event.departments[0];
  byId('workerUploadForm').reset();
  byId('uploadToken').value = company.token;
  byId('uploadEventId').value = event.id;
  byId('uploadKind').value = kind;
  if (isClaim && event.departments.length === 1) byId('claimDepartment').value = event.departments[0];
  showMessage(byId('uploadMessage'), '');
  const modal = byId('uploadModal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeUploadModal() {
  const modal = byId('uploadModal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  uploadContext = null;
}

async function refreshCompany(company) {
  try {
    const response = await fetchJson('/api/worker/company', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: company.token })
    });
    return response.data;
  } catch (_error) {
    return company;
  }
}

function startStatusPolling() {
  clearInterval(workerPollTimer);
  workerPollTimer = setInterval(async () => {
    if (document.hidden || !workerPortalData.companies?.length) return;
    workerPortalData.companies = await Promise.all(workerPortalData.companies.map(refreshCompany));
    renderPortal();
  }, 15000);
}

byId('workerLookupForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  showMessage(byId('lookupMessage'), '');
  try {
    const response = await fetchJson('/api/worker/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: byId('workerPhone').value })
    });
    setPortalData(response.data);
  } catch (error) {
    showMessage(byId('lookupMessage'), error.message);
  } finally {
    button.disabled = false;
  }
});

byId('companyFilter').addEventListener('change', applyCompanyFilter);

byId('changePhoneButton').addEventListener('click', () => {
  clearInterval(workerPollTimer);
  workerPortalData = { companies: [] };
  byId('portalView').hidden = true;
  byId('lookupView').hidden = false;
  byId('workerPhone').focus();
});

byId('claimCategory').addEventListener('change', event => {
  const isOther = event.target.value === 'Other';
  byId('otherCategoryField').hidden = !isOther;
  byId('otherCategory').required = isOther;
});

document.querySelectorAll('[data-close-upload]').forEach(button => {
  button.addEventListener('click', closeUploadModal);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && byId('uploadModal').classList.contains('open')) {
    closeUploadModal();
  }
});

byId('workerUploadFile').addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) byId('filePickerLabel').textContent = file.name;
});

byId('workerUploadForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!uploadContext) return;
  const button = byId('submitUploadButton');
  button.disabled = true;
  showMessage(byId('uploadMessage'), '');
  try {
    const formData = new FormData(event.currentTarget);
    const response = await fetchJson('/api/worker/submissions', {
      method: 'POST',
      body: formData
    });
    const companyIndex = workerPortalData.companies.findIndex(row => row.code === response.data.code);
    if (companyIndex >= 0) workerPortalData.companies[companyIndex] = response.data;
    closeUploadModal();
    renderPortal();
    showMessage(byId('portalMessage'), response.message || 'Submission received.', 'success');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    showMessage(byId('uploadMessage'), error.message);
  } finally {
    button.disabled = false;
  }
});
