// Client directory workspace and Delivery Order client picker.
// Loads after finance.js, reusing its formatting and document client cache.

const clientDirectoryState = {
  rows: [],
  query: '',
  editingName: null,
  draft: null,
  loading: false,
  saving: false
};

function clientsRoot() {
  return document.getElementById('clients-page-root');
}

function clientDirectoryBlankClient() {
  return {
    salutation: '',
    name: '',
    company: '',
    contactPerson: '',
    email: '',
    phone: '',
    taxNumber: '',
    address1: '',
    address2: '',
    address3: '',
    postalCode: ''
  };
}

function clientDirectoryFilteredRows() {
  const query = String(clientDirectoryState.query || '').trim().toLowerCase();
  return clientDirectoryState.rows
    .map((client, index) => ({ client, index }))
    .filter(({ client }) => !query || Object.values(client || {}).some(
      value => String(value || '').toLowerCase().includes(query)
    ));
}

function clientDirectoryAddress(client) {
  return [client.address1, client.address2, client.address3, client.postalCode]
    .filter(Boolean)
    .join(', ');
}

function clientDirectoryListMarkup() {
  const rows = clientDirectoryFilteredRows();
  if (!rows.length) {
    return `<div class="finance-clients-empty">
      <strong>${clientDirectoryState.query ? 'No clients match this search.' : 'No clients yet.'}</strong>
      <span>${clientDirectoryState.query ? 'Try another name, company, email, phone number or address.' : 'Add the first client to reuse their details in quotations and delivery orders.'}</span>
    </div>`;
  }
  return `
    <div class="finance-clients-table-wrap">
      <table class="finance-clients-table">
        <thead><tr><th>Client</th><th>Company</th><th>Contact</th><th>Billing / delivery address</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${rows.map(({ client, index }) => `
          <tr>
            <td data-label="Client"><strong>${financeEscape(financeClientName(client) || client.name || 'Unnamed client')}</strong>${client.contactPerson ? `<small>Attn: ${financeEscape(client.contactPerson)}</small>` : ''}</td>
            <td data-label="Company"><span>${financeEscape(client.company || '—')}</span>${client.taxNumber ? `<small>Tax no. ${financeEscape(client.taxNumber)}</small>` : ''}</td>
            <td data-label="Contact"><span>${financeEscape(client.email || '—')}</span><small>${financeEscape(client.phone || '')}</small></td>
            <td data-label="Address"><span>${financeEscape(clientDirectoryAddress(client) || '—')}</span></td>
            <td data-label="Actions"><div class="finance-clients-row-actions"><button type="button" class="btn btn-secondary compact" onclick="clientDirectoryStartEdit(${index})">Edit</button><button type="button" class="btn btn-danger compact" onclick="clientDirectoryDelete(${index})">Delete</button></div></td>
          </tr>
        `).join('')}</tbody>
      </table>
    </div>
  `;
}

function clientDirectoryEditorMarkup() {
  const client = clientDirectoryState.draft;
  if (!client) {
    return `
      <div class="finance-clients-editor-empty">
        <span class="finance-clients-editor-mark" aria-hidden="true">👤</span>
        <strong>Select a client to edit</strong>
        <p>Or add a client to create a reusable address-book record for Quotations and Delivery Orders.</p>
        <button type="button" class="btn btn-primary" onclick="clientDirectoryStartCreate()">+ Add Client</button>
      </div>
    `;
  }
  const editing = clientDirectoryState.editingName !== '';
  return `
    <form class="finance-clients-form" onsubmit="clientDirectorySave(event)">
      <div class="finance-clients-form-heading">
        <div><h3>${editing ? 'Edit client' : 'Add client'}</h3><p>${editing ? `Updating ${financeEscape(clientDirectoryState.editingName)}` : 'Create a reusable client record.'}</p></div>
        <button type="button" class="finance-clients-form-close" aria-label="Close client editor" onclick="clientDirectoryCancelEdit()">×</button>
      </div>
      <div class="finance-clients-form-body">
        <div class="finance-clients-name-grid">
          <label class="finance-field"><span>Salutation</span><select class="finance-input" name="salutation">${FINANCE_SALUTATIONS.map(value => `<option value="${financeEscapeAttr(value)}" ${value === client.salutation ? 'selected' : ''}>${financeEscape(value || 'None')}</option>`).join('')}</select></label>
          <label class="finance-field"><span>Client name *</span><input class="finance-input" name="name" maxlength="160" required autocomplete="name" value="${financeEscapeAttr(client.name || '')}"></label>
        </div>
        <label class="finance-field"><span>Company</span><input class="finance-input" name="company" maxlength="200" autocomplete="organization" value="${financeEscapeAttr(client.company || '')}"></label>
        <label class="finance-field"><span>Contact person</span><input class="finance-input" name="contactPerson" maxlength="160" value="${financeEscapeAttr(client.contactPerson || '')}"></label>
        <div class="finance-clients-pair-grid">
          <label class="finance-field"><span>Email</span><input class="finance-input" type="email" name="email" maxlength="200" autocomplete="email" value="${financeEscapeAttr(client.email || '')}"></label>
          <label class="finance-field"><span>Phone</span><input class="finance-input" type="tel" name="phone" maxlength="80" autocomplete="tel" value="${financeEscapeAttr(client.phone || '')}"></label>
        </div>
        <label class="finance-field"><span>Tax / registration number</span><input class="finance-input" name="taxNumber" maxlength="100" value="${financeEscapeAttr(client.taxNumber || '')}"></label>
        <div class="finance-clients-address-group">
          <span>Billing / delivery address</span>
          <input class="finance-input" name="address1" maxlength="240" autocomplete="address-line1" placeholder="Address line 1" value="${financeEscapeAttr(client.address1 || '')}">
          <input class="finance-input" name="address2" maxlength="240" autocomplete="address-line2" placeholder="Address line 2" value="${financeEscapeAttr(client.address2 || '')}">
          <input class="finance-input" name="address3" maxlength="240" autocomplete="address-line3" placeholder="Address line 3" value="${financeEscapeAttr(client.address3 || '')}">
          <input class="finance-input" name="postalCode" maxlength="40" autocomplete="postal-code" placeholder="Postal code" value="${financeEscapeAttr(client.postalCode || '')}">
        </div>
      </div>
      <div class="finance-clients-form-actions">
        <button type="button" class="btn btn-secondary" onclick="clientDirectoryCancelEdit()">Cancel</button>
        <button type="submit" class="btn btn-primary" ${clientDirectoryState.saving ? 'disabled' : ''}>${clientDirectoryState.saving ? 'Saving…' : (editing ? 'Save Changes' : 'Add Client')}</button>
      </div>
    </form>
  `;
}

function clientDirectoryRenderList() {
  const results = document.getElementById('clientDirectoryResults');
  if (results) results.innerHTML = clientDirectoryListMarkup();
  const count = document.getElementById('clientDirectoryCount');
  if (count) {
    const visible = clientDirectoryFilteredRows().length;
    const total = clientDirectoryState.rows.length;
    count.textContent = clientDirectoryState.query ? `${visible} of ${total} clients` : `${total} client${total === 1 ? '' : 's'}`;
  }
}

function clientDirectoryRender() {
  const root = clientsRoot();
  if (!root) return;
  root.innerHTML = `
    <div class="finance-toolbar finance-clients-toolbar">
      <div class="finance-toolbar-heading"><h2>Clients</h2><p class="finance-subtitle">Shared client details for Quotations and Delivery Orders.</p></div>
      <div class="finance-toolbar-actions">
        <input class="finance-search" type="search" value="${financeEscapeAttr(clientDirectoryState.query)}" placeholder="Search clients..." autocomplete="off" oninput="clientDirectorySetQuery(this.value)">
        <button type="button" class="btn btn-primary" onclick="clientDirectoryStartCreate()">+ Add Client</button>
      </div>
    </div>
    <div class="finance-clients-guidance"><strong>One shared address book.</strong><span>Selecting a saved client in a quotation or delivery order copies these details into that document.</span></div>
    <div class="finance-clients-layout">
      <section class="finance-card finance-clients-list-card">
        <div class="finance-clients-list-heading"><h3>Client directory</h3><span id="clientDirectoryCount"></span></div>
        <div id="clientDirectoryResults">${clientDirectoryListMarkup()}</div>
      </section>
      <aside class="finance-card finance-clients-editor" id="clientDirectoryEditor">${clientDirectoryEditorMarkup()}</aside>
    </div>
  `;
  clientDirectoryRenderList();
}

function clientDirectorySetQuery(value) {
  clientDirectoryState.query = String(value || '');
  clientDirectoryRenderList();
}

function clientDirectoryStartCreate() {
  clientDirectoryState.editingName = '';
  clientDirectoryState.draft = clientDirectoryBlankClient();
  clientDirectoryRender();
  setTimeout(() => document.querySelector('#clientDirectoryEditor [name="name"]')?.focus(), 0);
}

function clientDirectoryStartEdit(index) {
  const client = clientDirectoryState.rows[Number(index)];
  if (!client) return;
  clientDirectoryState.editingName = client.name;
  clientDirectoryState.draft = { ...clientDirectoryBlankClient(), ...client };
  clientDirectoryRender();
  document.getElementById('clientDirectoryEditor')?.scrollIntoView({ block: 'nearest' });
}

function clientDirectoryCancelEdit() {
  clientDirectoryState.editingName = null;
  clientDirectoryState.draft = null;
  clientDirectoryRender();
}

async function clientDirectoryDelete(index) {
  const client = clientDirectoryState.rows[Number(index)];
  if (!client) return;
  const confirmed = await showAppConfirm({
    title: 'Remove client from directory?',
    message: `${client.name} will no longer appear in client suggestions. Existing quotations, invoices and delivery orders will keep their saved client details.`,
    confirmText: 'Remove Client',
    cancelText: 'Cancel',
    destructive: true
  });
  if (!confirmed) return;
  try {
    await apiCall(`/api/clients/${encodeURIComponent(client.name)}`, 'DELETE');
    if (clientDirectoryState.editingName === client.name) {
      clientDirectoryState.editingName = null;
      clientDirectoryState.draft = null;
    }
    await loadClientsPage({ silent: true });
    showNotification('success', 'Client removed from suggestions');
  } catch (error) {
    // apiCall displays the server message.
  }
}

function clientDirectoryRefreshDocumentCaches(rows) {
  financeState.clients = rows.map(client => ({ ...client }));
  if (typeof invoiceState !== 'undefined') {
    invoiceState.clients = rows.map(client => ({ ...client }));
  }
}

async function loadClientsPage(options = {}) {
  const root = clientsRoot();
  if (!root || clientDirectoryState.loading) return;
  clientDirectoryState.loading = true;
  if (!options.silent) root.innerHTML = '<div class="loading">Loading clients...</div>';
  try {
    const response = await apiCall('/api/clients');
    clientDirectoryState.rows = response.data || [];
    clientDirectoryRefreshDocumentCaches(clientDirectoryState.rows);
    if (clientDirectoryState.editingName !== null && clientDirectoryState.editingName !== '') {
      const selected = clientDirectoryState.rows.find(row => row.name === clientDirectoryState.editingName);
      clientDirectoryState.draft = selected ? { ...selected } : null;
      if (!selected) clientDirectoryState.editingName = null;
    }
    clientDirectoryRender();
  } catch (error) {
    root.innerHTML = '<div class="finance-empty">Could not load clients.</div>';
  } finally {
    clientDirectoryState.loading = false;
  }
}

async function clientDirectorySave(event) {
  event.preventDefault();
  if (clientDirectoryState.saving) return;
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.name = String(payload.name || '').trim();
  if (!payload.name) return;
  clientDirectoryState.draft = { ...clientDirectoryBlankClient(), ...payload };
  clientDirectoryState.saving = true;
  clientDirectoryRender();
  try {
    const editingName = clientDirectoryState.editingName;
    const endpoint = editingName
      ? `/api/clients/${encodeURIComponent(editingName)}`
      : '/api/clients';
    const response = await apiCall(endpoint, editingName ? 'PUT' : 'POST', payload);
    clientDirectoryState.editingName = response.data.name;
    clientDirectoryState.draft = { ...response.data };
    showNotification('success', editingName ? 'Client updated' : 'Client added');
    await loadClientsPage({ silent: true });
  } catch (error) {
    clientDirectoryRender();
  } finally {
    clientDirectoryState.saving = false;
    clientDirectoryRender();
  }
}

// --- Client directory helpers ---
async function fetchClients(query = '') {
  try {
    const res = await apiCall(`/api/clients${query ? `?query=${encodeURIComponent(query)}` : ''}`);
    return res.success ? res.data : [];
  } catch (e) {
    console.error('fetchClients error', e);
    return [];
  }
}

async function fetchClientByName(name) {
  try {
    const res = await apiCall(`/api/clients/${encodeURIComponent(name)}`);
    return res.success ? res.data : null;
  } catch { return null; }
}

async function saveClient(client) {
  const res = await apiCall('/api/clients', 'POST', client);
  return res.success ? res.data : null;
}

async function updateClient(name, data) {
  const res = await apiCall(`/api/clients/${encodeURIComponent(name)}`, 'PUT', data);
  return res && res.success ? res.data : null;
}

async function deleteClient(name) {
  const res = await apiCall(`/api/clients/${encodeURIComponent(name)}`, 'DELETE');
  return !!(res && res.success);
}

function fillClientFieldsFromRecord(rec) {
  if (!rec) return;
  const companyEl = document.getElementById('clientCompany');
  const a1 = document.getElementById('deliveryAddress1');
  const a2 = document.getElementById('deliveryAddress2');
  const a3 = document.getElementById('deliveryAddress3');
  const phoneEl = document.getElementById('clientPhone');
  const postalEl = document.getElementById('clientPostalCode'); // optional input if you add it to the form

  if (companyEl) companyEl.value = rec.company || '';
  if (a1) a1.value = rec.address1 || '';
  if (a2) a2.value = rec.address2 || '';
  // The Delivery Order's third recipient field is explicitly the postal code.
  if (a3) a3.value = rec.postalCode || rec.address3 || '';
  if (phoneEl) phoneEl.value = rec.phone || '';

  // If you add a dedicated postal code input:
  if (postalEl) postalEl.value = rec.postalCode || '';
}

async function setupClientAutocomplete() {
  const input = document.getElementById('clientName');
  if (!input) return;

  // Create or reuse a datalist for suggestions
  let dl = document.getElementById('clientNameList');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'clientNameList';
    document.body.appendChild(dl);
  }
  input.setAttribute('list', 'clientNameList');

  // Populate suggestions
  const all = await fetchClients('');
  dl.innerHTML = all.map(c => `<option value="${c.name}">`).join('');

  // When user chooses a known name, auto-fill the rest
  input.addEventListener('change', async () => {
    const name = input.value.trim();
    if (!name) return;
    const rec = (all.find(x => x.name.toLowerCase() === name.toLowerCase())) || await fetchClientByName(name);
    if (rec) fillClientFieldsFromRecord(rec);
  });
}

function ensureKnownClientsButton() {
  const input = document.getElementById('clientName');
  if (!input || document.getElementById('btnKnownClients')) return;

  const btn = document.createElement('button');
  btn.id = 'btnKnownClients';
  btn.type = 'button';
  btn.className = 'btn btn-secondary';
  btn.style.marginLeft = '8px';
  btn.textContent = 'Known Clients';
  btn.onclick = openClientsManager;

  // Try to place next to the clientName input
  if (input.parentElement) input.parentElement.appendChild(btn);
  else input.insertAdjacentElement('afterend', btn);
}
// Client directory manager
async function openClientsManager() {
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.innerHTML = `
    <div class="modal-content" style="max-width: 900px;">
      <div class="modal-header">
        <h3 class="modal-title">Known Clients</h3>
        <button class="close-btn" id="kcClose">&times;</button>
      </div>

      <div class="modal-body">
        <!-- Client Form -->
        <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 25px;">
          <h4 style="margin-bottom: 15px; color: #495057;">Add/Edit Client</h4>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; margin-bottom: 15px;">
            <div class="form-group">
              <label class="form-label">Name *</label>
              <input class="form-input" id="kcName" placeholder="Client name">
            </div>
            <div class="form-group">
              <label class="form-label">Company</label>
              <input class="form-input" id="kcCompany" placeholder="Company name">
            </div>
            <div class="form-group">
              <label class="form-label">Address Line 1</label>
              <input class="form-input" id="kcA1" placeholder="Address line 1">
            </div>
            <div class="form-group">
              <label class="form-label">Address Line 2</label>
              <input class="form-input" id="kcA2" placeholder="Address line 2">
            </div>
            <div class="form-group">
              <label class="form-label">Address Line 3</label>
              <input class="form-input" id="kcA3" placeholder="Address line 3">
            </div>
            <div class="form-group">
              <label class="form-label">Postal Code</label>
              <input class="form-input" id="kcPostal" placeholder="Postal code">
            </div>
            <div class="form-group">
              <label class="form-label">Phone</label>
              <input class="form-input" id="kcPhone" placeholder="Phone number">
            </div>
          </div>
          <div style="text-align: right;">
            <button class="btn btn-primary" id="kcSave">Save Client</button>
          </div>
        </div>

        <!-- Search & Client List -->
        <div>
          <div class="form-group">
            <label class="form-label">Search Clients</label>
            <input class="form-input" id="kcSearch" placeholder="Search by name, company, phone, or postal code...">
          </div>

          <div style="border: 1px solid #e9ecef; border-radius: 8px; overflow: hidden; max-height: 400px; overflow-y: auto;">
            <table class="table" style="margin: 0;">
              <thead style="background: #f8f9fa; position: sticky; top: 0; z-index: 1;">
                <tr>
                  <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e9ecef;">Name</th>
                  <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e9ecef;">Company</th>
                  <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e9ecef;">Phone</th>
                  <th style="padding: 12px; text-align: left; border-bottom: 1px solid #e9ecef;">Postal</th>
                  <th style="padding: 12px; text-align: center; border-bottom: 1px solid #e9ecef; width: 140px;">Actions</th>
                </tr>
              </thead>
              <tbody id="kcBody">
                <tr>
                  <td colspan="5" style="padding: 40px; text-align: center; color: #666;">
                    Loading clients...
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('#kcClose').onclick = close;

  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  // Close on Escape key
  document.addEventListener('keydown', function escapeHandler(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', escapeHandler);
    }
  });

  let editingName = null; // track original name when editing

  async function refreshList(query = '') {
    const list = await fetchClients(query);
    const tbody = modal.querySelector('#kcBody');

    if (list.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="padding: 40px; text-align: center; color: #666;">
            ${query ? 'No clients found matching your search.' : 'No clients found. Add your first client above.'}
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = list.map(c => `
      <tr style="cursor: pointer; transition: background-color 0.2s;" data-name="${escapeHtmlAttr(c.name)}">
        <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; font-weight: 500;">${escapeHtml(c.name)}</td>
        <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; color: #666;">${escapeHtml(c.company || '')}</td>
        <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; color: #666;">${escapeHtml(c.phone || '')}</td>
        <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; color: #666;">${escapeHtml(c.postalCode || '')}</td>
        <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; text-align: center;">
          <div style="display: flex; gap: 6px; justify-content: center;">
            <button class="btn btn-secondary kc-edit" data-name="${escapeHtmlAttr(c.name)}" style="padding: 4px 8px; font-size: 12px;">Edit</button>
            <button class="btn btn-danger kc-del" data-name="${escapeHtmlAttr(c.name)}" style="padding: 4px 8px; font-size: 12px;">Delete</button>
          </div>
        </td>
      </tr>
    `).join('');

    // Add hover effects to rows
    tbody.querySelectorAll('tr[data-name]').forEach(row => {
      row.addEventListener('mouseenter', () => {
        row.style.backgroundColor = '#f8f9fa';
      });
      row.addEventListener('mouseleave', () => {
        row.style.backgroundColor = '';
      });
    });

    // Row click selects client into DO form and closes
    tbody.querySelectorAll('tr[data-name]').forEach(tr => {
      tr.onclick = async (e) => {
        // Don't trigger row click if clicking on buttons
        if (e.target.closest('button')) return;

        const name = tr.getAttribute('data-name');
        const rec = await fetchClientByName(name);
        if (rec) {
          const input = document.getElementById('clientName');
          if (input) input.value = rec.name;
          fillClientFieldsFromRecord(rec);
          close();
        }
      };
    });

    // Edit buttons
    tbody.querySelectorAll('.kc-edit').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const name = btn.getAttribute('data-name');
        const rec = await fetchClientByName(name);
        if (!rec) return;

        editingName = rec.name;
        modal.querySelector('#kcName').value = rec.name || '';
        modal.querySelector('#kcCompany').value = rec.company || '';
        modal.querySelector('#kcA1').value = rec.address1 || '';
        modal.querySelector('#kcA2').value = rec.address2 || '';
        modal.querySelector('#kcA3').value = rec.address3 || '';
        modal.querySelector('#kcPostal').value = rec.postalCode || '';
        modal.querySelector('#kcPhone').value = rec.phone || '';
        modal.querySelector('#kcName').focus();

        // Update button text to indicate editing
        modal.querySelector('#kcSave').textContent = 'Update Client';
      };
    });

    // Delete buttons
    tbody.querySelectorAll('.kc-del').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const name = btn.getAttribute('data-name');
        const ok = await showCustomConfirm('Delete Client', `Are you sure you want to delete client "${name}"? This action cannot be undone.`);
        if (!ok) return;

        try {
          const done = await deleteClient(name);
          if (done) {
            showNotification('success', `Deleted client ${name}`);

            // If we were editing this one, clear the form
            if (editingName === name) {
              clearClientForm();
            }
            await refreshList(modal.querySelector('#kcSearch').value.trim());
          } else {
            showNotification('error', 'Delete failed. You may not have permission to delete clients.');
          }
        } catch (err) {
          showNotification('error', err?.message || 'Delete failed');
        }
      };
    });
  }

  function clearClientForm() {
    editingName = null;
    modal.querySelector('#kcName').value = '';
    modal.querySelector('#kcCompany').value = '';
    modal.querySelector('#kcA1').value = '';
    modal.querySelector('#kcA2').value = '';
    modal.querySelector('#kcA3').value = '';
    modal.querySelector('#kcPostal').value = '';
    modal.querySelector('#kcPhone').value = '';
    modal.querySelector('#kcSave').textContent = 'Save Client';
  }

  // Search input handler
  modal.querySelector('#kcSearch').addEventListener('input', (e) => {
    refreshList(e.target.value.trim());
  });

  // Save button handler
  modal.querySelector('#kcSave').onclick = async () => {
    const client = {
      name: modal.querySelector('#kcName').value.trim(),
      company: modal.querySelector('#kcCompany').value.trim(),
      address1: modal.querySelector('#kcA1').value.trim(),
      address2: modal.querySelector('#kcA2').value.trim(),
      address3: modal.querySelector('#kcA3').value.trim(),
      postalCode: modal.querySelector('#kcPostal').value.trim(),
      phone: modal.querySelector('#kcPhone').value.trim(),
    };

    if (!client.name) {
      showNotification('warning', 'Name is required');
      modal.querySelector('#kcName').focus();
      return;
    }

    try {
      if (editingName && editingName === client.name) {
        // Update in-place
        await updateClient(editingName, client);
        showNotification('success', `Updated client ${client.name}`);
      } else if (editingName && editingName !== client.name) {
        // Rename: create new + offer to delete old
        await saveClient(client);
        const removeOld = await showCustomConfirm(
          'Replace Client',
          `Created new client "${client.name}". Would you like to delete the old client "${editingName}"?`
        );
        if (removeOld) {
          await deleteClient(editingName);
        }
        showNotification('success', `Saved ${client.name}`);
      } else {
        // Create new
        await saveClient(client);
        showNotification('success', `Saved ${client.name}`);
      }

      clearClientForm();
      await refreshList(modal.querySelector('#kcSearch').value.trim());
    } catch (e) {
      showNotification('error', e?.message || 'Save/Update failed');
    }
  };

  // Initial load
  await refreshList('');
}
