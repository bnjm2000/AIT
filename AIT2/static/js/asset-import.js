// Asset import file review, validation, preview plans, and confirmation.

let assetImportState = {
  rows: [],
  rejected: [],
  departments: [],
  fileName: '',
  submitting: false,
  planning: false,
  planToken: '',
  inventoryRevision: '',
  departmentRevision: '',
  validationCache: null,
  page: 0
};
const ASSET_IMPORT_REVIEW_PAGE_SIZE = 100;
let __assetImportPlanTimer = null;
let __assetImportPlanSequence = 0;

function downloadAssetImportTemplate() {
  const link = document.createElement('a');
  link.href = '/api/assets/import-template';
  link.download = 'Asset Import Template.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function chooseAssetImportTemplate() {
  const input = document.getElementById('assetImportFile');
  if (!input) return;
  input.value = '';
  input.click();
}

function assetImportBoolean(value) {
  if (value === true) return true;
  return ['yes', 'y', 'true', '1'].includes(String(value || '').trim().toLocaleLowerCase());
}

function assetImportValidationCache() {
  if (assetImportState.validationCache) return assetImportState.validationCache;
  const supplied = Array.isArray(assetImportState.departments) ? assetImportState.departments : [];
  const sourceDepartments = supplied.length ? supplied : Object.values(departments || {});
  const departmentList = sourceDepartments
    .map(department => ({
      code: assetImportNormaliseDepartmentCode(department?.code),
      name: String(department?.name || department?.code || '').trim(),
      pending: false
    }))
    .filter(department => department.code);
  const pendingCodeNames = new Map();
  const pendingNameCodes = new Map();
  assetImportState.rows.forEach(row => {
    if (!assetImportBoolean(row?.createDepartment)) return;
    const code = assetImportNormaliseDepartmentCode(row?.newDepartmentCode || row?.department);
    const name = String(row?.newDepartmentName || row?.department || code).trim();
    if (code) {
      if (!pendingCodeNames.has(code)) pendingCodeNames.set(code, new Set());
      pendingCodeNames.get(code).add(name.toLocaleLowerCase());
    }
    if (name) {
      const key = name.toLocaleLowerCase();
      if (!pendingNameCodes.has(key)) pendingNameCodes.set(key, new Set());
      pendingNameCodes.get(key).add(code);
    }
    if (code && !departmentList.some(department => department.code === code)) {
      departmentList.push({ code, name, pending: true });
    }
  });
  const descriptionsByModel = new Map();
  (assets || []).forEach(asset => {
    const key = `${normalizeAddAssetLookup(asset?.brand)}\u0000${normalizeAddAssetLookup(asset?.model)}`;
    if (!descriptionsByModel.has(key)) descriptionsByModel.set(key, new Set());
    descriptionsByModel.get(key).add(String(asset?.description || '').trim() || '(blank description)');
  });
  assetImportState.validationCache = {
    departmentList,
    pendingCodeNames,
    pendingNameCodes,
    descriptionsByModel
  };
  return assetImportState.validationCache;
}

function invalidateAssetImportValidationCache() {
  assetImportState.validationCache = null;
}

function assetImportExistingDescriptions(row) {
  const brand = normalizeAddAssetLookup(row?.brand);
  const model = normalizeAddAssetLookup(row?.model);
  const description = normalizeAddAssetLookup(row?.description);
  const descriptions = assetImportValidationCache().descriptionsByModel
    .get(`${brand}\u0000${model}`) || new Set();
  return [...descriptions]
    .filter(value => normalizeAddAssetLookup(value === '(blank description)' ? '' : value) !== description)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function assetImportNormaliseDepartmentCode(value) {
  return String(value || '').trim().toLocaleUpperCase().replace(/[^A-Z0-9_-]+/g, '');
}

function assetImportDepartmentConflictErrors(newCode, newName) {
  const errors = [];
  const cache = assetImportValidationCache();
  const codeNames = cache.pendingCodeNames.get(newCode) || new Set();
  const nameCodes = cache.pendingNameCodes.get(String(newName || '').toLocaleLowerCase()) || new Set();
  if (newCode && codeNames.size > 1) {
    errors.push(`New department code ${newCode} has conflicting names in this import`);
  }
  if (newName && nameCodes.size > 1) {
    errors.push(`New department name ${newName} has conflicting codes in this import`);
  }
  return errors;
}

function assetImportDepartmentResolution(value) {
  const input = String(value || '').trim();
  const list = assetImportValidationCache().departmentList;
  if (!input) return { matched: false, ambiguous: false, input, suggestedCode: '' };
  const normalizedCode = assetImportNormaliseDepartmentCode(input);
  const codeMatch = list.find(department => department.code === normalizedCode);
  if (codeMatch) return { matched: true, ambiguous: false, input, department: codeMatch, suggestedCode: codeMatch.code };
  const nameMatches = list.filter(department => department.name.toLocaleLowerCase() === input.toLocaleLowerCase());
  if (nameMatches.length === 1) {
    return { matched: true, ambiguous: false, input, department: nameMatches[0], suggestedCode: nameMatches[0].code };
  }
  return {
    matched: false,
    ambiguous: nameMatches.length > 1,
    input,
    matches: nameMatches,
    suggestedCode: normalizedCode
  };
}

function assetImportRowErrors(row, index) {
  const errors = [];
  const quantity = Number(row?.quantity);
  const isBulk = assetImportBoolean(row?.isBulk);
  if (!String(row?.brand || '').trim()) errors.push('Brand is required');
  if (!String(row?.model || '').trim()) errors.push('Model number is required');
  const departmentResolution = assetImportDepartmentResolution(row?.department);
  if (!departmentResolution.input) {
    errors.push('Department is required');
  } else if (!departmentResolution.matched) {
    if (departmentResolution.ambiguous) {
      errors.push(`Department name ${departmentResolution.input} matches more than one code; enter a code instead`);
    } else if (!assetImportBoolean(row?.createDepartment)) {
      errors.push(`Department ${departmentResolution.input} was not found. Enter an existing code/name or create a new department.`);
    } else {
      const newCode = assetImportNormaliseDepartmentCode(row?.newDepartmentCode);
      const newName = String(row?.newDepartmentName || '').trim();
      const departmentList = (Array.isArray(assetImportState.departments) ? assetImportState.departments : [])
        .map(department => ({
          code: assetImportNormaliseDepartmentCode(department?.code),
          name: String(department?.name || department?.code || '').trim()
        }));
      if (!newCode) errors.push('New department code is required');
      if (!newName) errors.push('New department name is required');
      const codeMatch = departmentList.find(department => department.code === newCode);
      if (codeMatch) errors.push(`Department code ${newCode} already exists as ${codeMatch.name}`);
      const nameMatch = departmentList.find(department => department.name.toLocaleLowerCase() === newName.toLocaleLowerCase());
      if (nameMatch) errors.push(`Department name ${newName} already exists as ${nameMatch.code}`);
      errors.push(...assetImportDepartmentConflictErrors(newCode, newName));
    }
  }
  if (assetImportBoolean(row?.createDepartment) && departmentResolution.matched) {
    const newCode = assetImportNormaliseDepartmentCode(row?.newDepartmentCode || row?.department);
    const newName = String(row?.newDepartmentName || '').trim();
    const existingDepartments = (Array.isArray(assetImportState.departments) ? assetImportState.departments : [])
      .map(department => ({
        code: assetImportNormaliseDepartmentCode(department?.code),
        name: String(department?.name || department?.code || '').trim()
      }));
    if (!newCode) errors.push('New department code is required');
    if (!newName) errors.push('New department name is required');
    const codeMatch = existingDepartments.find(department => department.code === newCode);
    if (codeMatch) errors.push(`Department code ${newCode} already exists as ${codeMatch.name}`);
    const nameMatch = existingDepartments.find(department => department.name.toLocaleLowerCase() === newName.toLocaleLowerCase());
    if (nameMatch) errors.push(`Department name ${newName} already exists as ${nameMatch.code}`);
    errors.push(...assetImportDepartmentConflictErrors(newCode, newName));
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) errors.push('Quantity must be a whole number from 1 to 500');
  if (row?.dateOfPurchase && !/^\d{4}-\d{2}-\d{2}$/.test(String(row.dateOfPurchase))) {
    errors.push('Date of purchase must be YYYY-MM-DD');
  }
  if (row?.validationError) errors.push(String(row.validationError));
  if (row?.serverError) errors.push(String(row.serverError));
  return [...new Set(errors)];
}

function assetImportTodayIso() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function assetImportRowWarnings(row) {
  const warnings = Array.isArray(row?.validationWarnings)
    ? row.validationWarnings.map(String)
    : [];
  const quantity = Number(row?.quantity);
  const isBulk = assetImportBoolean(row?.isBulk);
  if (!isBulk && Number.isInteger(quantity) && quantity > 0) {
    [
      ['Primary', positionalAssetSerialList(row?.serials), false],
      ['Secondary', positionalAssetSerialList(row?.secondarySerials), true],
    ].forEach(([label, serials, optional]) => {
      const count = serials.filter(serial => String(serial || '').trim()).length;
      if (count === quantity || (optional && count === 0)) return;
      if (count < quantity) {
        const missing = quantity - count;
        warnings.push(`${label} serial numbers: ${count}/${quantity}; ${missing} asset${missing === 1 ? '' : 's'} will be saved without one`);
      } else {
        const extra = count - quantity;
        warnings.push(`${label} serial numbers: ${count}/${quantity}; ${extra} extra serial number${extra === 1 ? '' : 's'} will not be saved`);
      }
    });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(row?.dateOfPurchase || '')) && String(row.dateOfPurchase) > assetImportTodayIso()) {
    warnings.push('Date of purchase is in the future');
  }
  const descriptions = assetImportExistingDescriptions(row);
  if (descriptions.length) warnings.push(`Same brand/model exists with a different description: ${descriptions.join(', ')}`);
  return [...new Set(warnings.filter(Boolean))];
}

function assetImportRowStatus(row, index) {
  if (assetImportRowErrors(row, index).length) return 'error';
  if (assetImportRowWarnings(row).length) return 'warning';
  return 'ready';
}

function assetImportPreviewIds(row) {
  const ids = Array.isArray(row?.assetIdsPreview) && row.assetIdsPreview.length
    ? row.assetIdsPreview
    : (Array.isArray(row?.suggestedAssetIds) ? row.suggestedAssetIds : []);
  return ids.filter(Boolean);
}

function assetImportPreviewIdText(row) {
  const ids = assetImportPreviewIds(row);
  if (!ids.length) return 'ID preview unavailable';
  if (ids.length <= 3) return ids.join(', ');
  return `${ids.slice(0, 2).join(', ')} … ${ids[ids.length - 1]}`;
}

function assetImportIssueHtml(row, index) {
  const errors = assetImportRowErrors(row, index);
  const warnings = assetImportRowWarnings(row);
  const departmentResolution = assetImportDepartmentResolution(row?.department);
  return `
    ${errors.length ? `<div class="asset-import-message">${errors.map(escapeHtml).join('<br>')}</div>` : ''}
    ${warnings.length ? `<div class="asset-import-message warning">${warnings.map(escapeHtml).join('<br>')}</div>` : ''}
    ${departmentResolution.matched ? `<div class="asset-import-message success">Department: ${escapeHtml(departmentResolution.department.code)} - ${escapeHtml(departmentResolution.department.name)}${departmentResolution.department.pending ? ' (will be created)' : ''}</div>` : ''}
    ${departmentResolution.input && !departmentResolution.matched && !departmentResolution.ambiguous ? `
      <div class="asset-import-department-action">
        <button type="button" class="asset-import-use-suggestion" onclick="setAssetImportDepartmentCreation(${index},${assetImportBoolean(row?.createDepartment) ? 'false' : 'true'})">${assetImportBoolean(row?.createDepartment) ? 'Use an existing department instead' : 'Create new department'}</button>
      </div>
    ` : ''}
    <div class="asset-import-message success">Asset ID preview: ${escapeHtml(assetImportPreviewIdText(row))}</div>
  `;
}

function assetImportFieldHtml(index, field, label, value, options = {}) {
  const classes = ['asset-import-field', options.wide ? 'wide' : '', options.full ? 'full' : ''].filter(Boolean).join(' ');
  const disabled = options.disabled ? ' disabled' : '';
  const escapedValue = escapeHtmlAttr(String(value ?? ''));
  if (options.type === 'textarea') {
    return `<div class="${classes}"><label>${escapeHtml(label)}</label><textarea data-import-field="${field}" oninput="updateAssetImportRow(${index},'${field}',this.value)" onchange="commitAssetImportRowChanges()"${disabled}>${escapeHtml(String(value ?? ''))}</textarea></div>`;
  }
  if (options.type === 'select') {
    return `<div class="${classes}"><label>${escapeHtml(label)}</label><select data-import-field="${field}" onchange="updateAssetImportRow(${index},'${field}',this.value);commitAssetImportRowChanges()"${disabled}>${options.options.map(option => `<option value="${escapeHtmlAttr(option.value)}"${String(option.value) === String(value) ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select></div>`;
  }
  return `<div class="${classes}"><label>${escapeHtml(label)}</label><input type="${options.type || 'text'}" value="${escapedValue}" data-import-field="${field}" oninput="updateAssetImportRow(${index},'${field}',this.value)" onchange="commitAssetImportRowChanges()"${options.min ? ` min="${options.min}"` : ''}${options.max ? ` max="${options.max}"` : ''}${disabled}></div>`;
}

function renderAssetImportReview() {
  const rowsContainer = document.getElementById('assetImportRows');
  const summary = document.getElementById('assetImportSummary');
  const rejected = document.getElementById('assetImportRejected');
  if (!rowsContainer || !summary || !rejected) return;

  const openRows = new Set(
    [...rowsContainer.querySelectorAll('.asset-import-row[open]')]
      .map(element => Number(element.dataset.importIndex))
      .filter(Number.isInteger)
  );

  const totalUnits = assetImportState.rows.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
  const bulkRows = assetImportState.rows.filter(row => assetImportBoolean(row.isBulk)).length;
  const errorRows = assetImportState.rows.filter((row, index) => assetImportRowStatus(row, index) === 'error').length;
  const warningRows = assetImportState.rows.filter((row, index) => assetImportRowStatus(row, index) === 'warning').length;
  summary.innerHTML = `
    <span>${assetImportState.rows.length} row${assetImportState.rows.length === 1 ? '' : 's'}</span>
    <span>${totalUnits} total unit${totalUnits === 1 ? '' : 's'}</span>
    <span>${bulkRows} bulk row${bulkRows === 1 ? '' : 's'}</span>
    <span class="asset-import-summary-error">${errorRows} need attention</span>
    <span class="asset-import-summary-warning">${warningRows} warning${warningRows === 1 ? '' : 's'}</span>
    <span>${escapeHtml(assetImportState.fileName || 'Uploaded file')}</span>
  `;

  rejected.hidden = !assetImportState.rejected.length;
  rejected.innerHTML = assetImportState.rejected.length
    ? `<strong>${assetImportState.rejected.length} row${assetImportState.rejected.length === 1 ? '' : 's'} initially need attention.</strong> You can correct them below.<br>${assetImportState.rejected.map(item => `File row ${Number(item.sourceRow) || '-'}: ${escapeHtml(item.error)}`).join('<br>')}`
    : '';

  const pageCount = Math.max(1, Math.ceil(assetImportState.rows.length / ASSET_IMPORT_REVIEW_PAGE_SIZE));
  assetImportState.page = Math.max(0, Math.min(Number(assetImportState.page) || 0, pageCount - 1));
  const pageStart = assetImportState.page * ASSET_IMPORT_REVIEW_PAGE_SIZE;
  const pageRows = assetImportState.rows
    .map((row, index) => ({ row, index }))
    .slice(pageStart, pageStart + ASSET_IMPORT_REVIEW_PAGE_SIZE);
  const categorizedRows = { error: [], warning: [], ready: [] };
  pageRows.forEach(({ row, index }) => categorizedRows[assetImportRowStatus(row, index)].push({ row, index }));
  const categories = [
    { key: 'error', title: 'Needs attention', description: 'Fix these rows before importing.' },
    { key: 'warning', title: 'Warnings', description: 'These rows can still be imported.' },
    { key: 'ready', title: 'Ready', description: 'No issues detected.' },
  ];

  const rowHtml = (row, index, status) => {
    const isBulk = assetImportBoolean(row.isBulk);
    const errors = assetImportRowErrors(row, index);
    const warnings = assetImportRowWarnings(row);
    const departmentResolution = assetImportDepartmentResolution(row.department);
    const isCreatingDepartment = assetImportBoolean(row.createDepartment);
    const rowLabel = Number(row.sourceRow) > 0 ? `File row ${Number(row.sourceRow)}` : `Import row ${index + 1}`;
    const title = [row.brand, row.model].filter(Boolean).join(' ') || 'Unnamed asset';
    const description = String(row.description || '').trim();
    const departmentLabel = departmentResolution.matched ? departmentResolution.department.code : (row.department || 'No department');
    const issueLabel = errors.length
      ? `${errors.length} error${errors.length === 1 ? '' : 's'}`
      : (warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : 'Ready');
    const shouldOpen = status === 'error' || openRows.has(index);
    return `
      <details class="asset-import-row has-${status}" id="assetImportRow-${index}" data-import-index="${index}"${shouldOpen ? ' open' : ''}>
        <summary class="asset-import-row-head">
          <span class="asset-import-state-dot" aria-hidden="true"></span>
          <span class="asset-import-row-title">
            <span class="asset-import-row-label">${escapeHtml(rowLabel)}</span>
            <strong id="assetImportRowTitle-${index}">${escapeHtml(title)}</strong>
            ${description ? `<span class="asset-import-row-description">${escapeHtml(description)}</span>` : ''}
          </span>
          <span class="asset-import-row-facts">
            <span>${escapeHtml(String(Number(row.quantity) || 0))} ${isBulk ? 'bulk units' : 'assets'}</span>
            <span>${escapeHtml(String(departmentLabel))}</span>
            <span id="assetImportRowIds-${index}">${escapeHtml(assetImportPreviewIdText(row))}</span>
          </span>
          <span class="asset-import-row-status" id="assetImportRowStatus-${index}">${escapeHtml(issueLabel)}</span>
        </summary>
        <div class="asset-import-fields">
          ${assetImportFieldHtml(index, 'brand', 'Brand *', row.brand)}
          ${assetImportFieldHtml(index, 'model', 'Model *', row.model)}
          ${assetImportFieldHtml(index, 'description', 'Description', row.description, { wide: true })}
          ${assetImportFieldHtml(index, 'version', 'Version', row.version)}
          ${assetImportFieldHtml(index, 'department', 'Department Code or Name *', row.department)}
          ${isCreatingDepartment ? assetImportFieldHtml(index, 'newDepartmentCode', 'New Department Code *', row.newDepartmentCode) : ''}
          ${isCreatingDepartment ? assetImportFieldHtml(index, 'newDepartmentName', 'New Department Name *', row.newDepartmentName, { wide: true }) : ''}
          ${assetImportFieldHtml(index, 'quantity', 'Quantity *', row.quantity, { type: 'number', min: 1, max: 500 })}
          ${assetImportFieldHtml(index, 'isBulk', 'Bulk Asset', isBulk ? 'Yes' : 'No', { type: 'select', options: [{ value: 'No', label: 'No' }, { value: 'Yes', label: 'Yes' }] })}
          ${assetImportFieldHtml(index, 'defaultLocation', 'Default Location', row.defaultLocation)}
          ${assetImportFieldHtml(index, 'dateOfPurchase', 'Date of Purchase', row.dateOfPurchase, { type: 'date' })}
          ${assetImportFieldHtml(index, 'assetIdPrefix', 'Custom ID Prefix', row.assetIdPrefix, { disabled: isBulk })}
          ${assetImportFieldHtml(index, 'tags', 'Tags', (row.tags || []).join(', '), { wide: true })}
          ${assetImportFieldHtml(index, 'serials', 'Primary Serial Numbers', positionalAssetSerialList(row.serials).join('\n'), { type: 'textarea', wide: true, disabled: isBulk })}
          ${assetImportFieldHtml(index, 'secondarySerials', 'Secondary Serial Numbers', positionalAssetSerialList(row.secondarySerials).join('\n'), { type: 'textarea', wide: true, disabled: isBulk })}
          ${assetImportFieldHtml(index, 'notes', 'Notes', row.notes, { type: 'textarea', wide: true })}
          <div class="asset-import-field full" id="assetImportIssues-${index}">${assetImportIssueHtml(row, index)}</div>
          <div class="asset-import-row-actions"><button type="button" class="asset-import-remove" onclick="removeAssetImportRow(${index})">Remove this row</button></div>
        </div>
      </details>
    `;
  };

  const paginationHtml = pageCount > 1 ? `
    <div class="asset-import-pagination">
      <button type="button" class="btn btn-secondary btn-sm" onclick="setAssetImportPage(${assetImportState.page - 1})"${assetImportState.page <= 0 ? ' disabled' : ''}>Previous</button>
      <span>Rows ${pageStart + 1}-${Math.min(pageStart + ASSET_IMPORT_REVIEW_PAGE_SIZE, assetImportState.rows.length)} of ${assetImportState.rows.length} · Page ${assetImportState.page + 1} of ${pageCount}</span>
      <button type="button" class="btn btn-secondary btn-sm" onclick="setAssetImportPage(${assetImportState.page + 1})"${assetImportState.page >= pageCount - 1 ? ' disabled' : ''}>Next</button>
    </div>
  ` : '';
  const categoryHtml = categories.map(category => {
    const categoryRows = categorizedRows[category.key];
    if (!categoryRows.length) return '';
    return `
      <section class="asset-import-category asset-import-category-${category.key}">
        <div class="asset-import-category-head">
          <div><strong>${escapeHtml(category.title)}</strong><span>${escapeHtml(category.description)}</span></div>
          <span>${categoryRows.length}</span>
        </div>
        <div class="asset-import-category-rows">${categoryRows.map(({ row, index }) => rowHtml(row, index, category.key)).join('')}</div>
      </section>
    `;
  }).join('') || '<div class="inventory-empty">No assets remain on this page.</div>';
  rowsContainer.innerHTML = `${paginationHtml}${categoryHtml}${paginationHtml}`;
  refreshAssetImportStatus();
}

function setAssetImportPage(page) {
  assetImportState.page = Number(page) || 0;
  renderAssetImportReview();
  document.querySelector('.asset-import-body')?.scrollTo({ top: 0, behavior: 'smooth' });
}

function refreshAssetImportStatus() {
  let issueCount = 0;
  let warningCount = 0;
  assetImportState.rows.forEach((row, index) => {
    const errors = assetImportRowErrors(row, index);
    const warnings = assetImportRowWarnings(row);
    issueCount += errors.length ? 1 : 0;
    warningCount += !errors.length && warnings.length ? 1 : 0;
    const section = document.getElementById(`assetImportRow-${index}`);
    if (section) {
      section.classList.toggle('has-error', errors.length > 0);
      section.classList.toggle('has-warning', !errors.length && warnings.length > 0);
      section.classList.toggle('has-ready', !errors.length && !warnings.length);
    }
    const issues = document.getElementById(`assetImportIssues-${index}`);
    if (issues) issues.innerHTML = assetImportIssueHtml(row, index);
    const title = document.getElementById(`assetImportRowTitle-${index}`);
    if (title) title.textContent = [row.brand, row.model].filter(Boolean).join(' ') || 'Unnamed asset';
    const ids = document.getElementById(`assetImportRowIds-${index}`);
    if (ids) ids.textContent = assetImportPreviewIdText(row);
    const rowStatus = document.getElementById(`assetImportRowStatus-${index}`);
    if (rowStatus) rowStatus.textContent = errors.length
      ? `${errors.length} error${errors.length === 1 ? '' : 's'}`
      : (warnings.length ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : 'Ready');
  });
  const status = document.getElementById('assetImportFooterStatus');
  if (status) {
    const parts = [];
    if (issueCount) parts.push(`${issueCount} row${issueCount === 1 ? '' : 's'} must be fixed`);
    if (warningCount) parts.push(`${warningCount} warning row${warningCount === 1 ? '' : 's'} can still be imported`);
    if (!parts.length) parts.push(`${assetImportState.rows.length} row${assetImportState.rows.length === 1 ? '' : 's'} ready to import`);
    status.textContent = parts.join(' · ');
  }
  const button = document.getElementById('assetImportConfirmButton');
  if (button) {
    button.disabled = assetImportState.submitting || assetImportState.planning || !assetImportState.planToken || issueCount > 0 || assetImportState.rows.length === 0;
    button.textContent = assetImportState.submitting
      ? 'Importing…'
      : (assetImportState.planning ? 'Planning IDs…' : 'Import Assets');
  }
}

function updateAssetImportRow(index, field, value) {
  const row = assetImportState.rows[index];
  if (!row) return;
  row.validationWarnings = [];
  row.duplicateSerials = [];
  row.serverError = '';
  row.validationError = '';
  assetImportState.planToken = '';
  assetImportState.inventoryRevision = '';
  if (field === 'quantity') row[field] = Number(value);
  else if (field === 'isBulk') row[field] = assetImportBoolean(value);
  else if (field === 'tags') row[field] = normalizeAssetTags(value);
  else if (field === 'serials' || field === 'secondarySerials') row[field] = positionalAssetSerialList(value);
  else row[field] = value;
  invalidateAssetImportValidationCache();
  if (field === 'department') {
    row.createDepartment = false;
    row.newDepartmentCode = '';
    row.newDepartmentName = '';
  }
  if (field === 'isBulk') {
    if (row.isBulk) {
      row.serials = [];
      row.secondarySerials = [];
      row.assetIdPrefix = '';
    }
    renderAssetImportReview();
    return;
  }
  refreshAssetImportStatus();
}

function commitAssetImportRowChanges() {
  assetImportState.planToken = '';
  assetImportState.inventoryRevision = '';
  assetImportState.departmentRevision = '';
  invalidateAssetImportValidationCache();
  refreshAssetImportStatus();
  clearTimeout(__assetImportPlanTimer);
  __assetImportPlanTimer = setTimeout(refreshAssetImportPlan, 180);
}

async function refreshAssetImportPlan() {
  if (!assetImportState.rows.length || assetImportState.submitting) return;
  const sequence = ++__assetImportPlanSequence;
  assetImportState.planning = true;
  assetImportState.planToken = '';
  refreshAssetImportStatus();
  try {
    const response = await apiCall('/api/assets/import-plan', 'POST', { rows: assetImportState.rows });
    if (sequence !== __assetImportPlanSequence) return false;
    const plannedRows = response.data?.rows || [];
    assetImportState.rows = assetImportState.rows.map((row, index) => ({
      ...row,
      ...(plannedRows[index] || {}),
      serverError: row.serverError || '',
    }));
    assetImportState.planToken = String(response.data?.planToken || '');
    assetImportState.inventoryRevision = String(response.data?.inventoryRevision || '');
    assetImportState.departmentRevision = String(response.data?.departmentRevision || '');
    invalidateAssetImportValidationCache();
    assetImportState.planning = false;
    renderAssetImportReview();
    return Boolean(assetImportState.planToken);
  } catch (error) {
    // Local validation remains visible; the next successful plan refresh will update IDs.
    if (sequence === __assetImportPlanSequence) {
      assetImportState.planning = false;
      refreshAssetImportStatus();
    }
    return false;
  }
}

function setAssetImportDepartmentCreation(index, enabled) {
  const row = assetImportState.rows[index];
  if (!row) return;
  row.createDepartment = Boolean(enabled);
  row.serverError = '';
  if (enabled) {
    const resolution = assetImportDepartmentResolution(row.department);
    row.newDepartmentCode = row.newDepartmentCode || resolution.suggestedCode;
    row.newDepartmentName = row.newDepartmentName || resolution.input;
  }
  renderAssetImportReview();
  commitAssetImportRowChanges();
}

function removeAssetImportRow(index) {
  assetImportState.rows.splice(index, 1);
  invalidateAssetImportValidationCache();
  renderAssetImportReview();
  commitAssetImportRowChanges();
}

async function previewAssetImportFile(input) {
  const file = input?.files?.[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const response = await apiCall('/api/assets/import-preview', 'POST', formData);
    assetImportState = {
      rows: response.data?.rows || [],
      rejected: response.data?.rejected || [],
      departments: response.data?.departments || [],
      fileName: file.name,
      submitting: false,
      planning: false,
      planToken: String(response.data?.planToken || ''),
      inventoryRevision: String(response.data?.inventoryRevision || ''),
      departmentRevision: String(response.data?.departmentRevision || ''),
      validationCache: null,
      page: 0
    };
    closeModal('addAssetModal');
    renderAssetImportReview();
    openModal('assetImportModal');
  } catch (error) {
    // apiCall already displays the server's validation message.
  } finally {
    input.value = '';
  }
}

function cancelAssetImport() {
  closeModal('assetImportModal');
  openModal('addAssetModal');
}

async function confirmAssetImport() {
  if (assetImportState.rows.some((row, index) => assetImportRowErrors(row, index).length)) {
    const firstErrorIndex = assetImportState.rows.findIndex((row, index) => assetImportRowErrors(row, index).length);
    assetImportState.page = Math.floor(firstErrorIndex / ASSET_IMPORT_REVIEW_PAGE_SIZE);
    renderAssetImportReview();
    refreshAssetImportStatus();
    document.querySelector('.asset-import-row.has-error')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  clearTimeout(__assetImportPlanTimer);
  if (!await refreshAssetImportPlan()) return;
  assetImportState.submitting = true;
  refreshAssetImportStatus();
  try {
    const response = await apiCall('/api/assets/import', 'POST', {
      rows: assetImportState.rows,
      planToken: assetImportState.planToken
    });
    closeModal('assetImportModal');
    assetImportState = {
      rows: [], rejected: [], departments: [], fileName: '', submitting: false,
      planning: false, planToken: '', inventoryRevision: '',
      departmentRevision: '', validationCache: null, page: 0
    };
    const created = Number(response.data?.inventoryRecordsCreated || 0);
    showNotification('success', `${response.message || 'Assets imported'} (${created} inventory record${created === 1 ? '' : 's'})`);
    await loadInventory();
  } catch (error) {
    if (error.payload?.code === 'asset_import_plan_stale' && error.payload?.data) {
      assetImportState.rows = error.payload.data.rows || assetImportState.rows;
      assetImportState.planToken = String(error.payload.data.planToken || '');
      assetImportState.inventoryRevision = String(error.payload.data.inventoryRevision || '');
      assetImportState.departmentRevision = String(error.payload.data.departmentRevision || '');
      invalidateAssetImportValidationCache();
      showNotification('warning', 'Inventory or departments changed. The preview has been refreshed; review it and confirm again.');
      renderAssetImportReview();
      return;
    }
    (error.payload?.rowErrors || []).forEach(item => {
      const row = assetImportState.rows[Number(item.index)];
      if (!row) return;
      row.serverError = item.error || 'This row could not be imported';
      if (item.suggestedAssetIds) row.suggestedAssetIds = item.suggestedAssetIds;
    });
    renderAssetImportReview();
  } finally {
    assetImportState.submitting = false;
    refreshAssetImportStatus();
  }
}
