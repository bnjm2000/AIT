// Asset-check workspace. Loaded after the shared application shell.

let assetCheckState = {
  group: null,
  assets: [],
  checked: new Set(),
  checkIds: {},
  seedIdentifier: ''
};

function ensureAssetCheckStyles() {
  if (document.getElementById('asset-check-styles')) return;

  const style = document.createElement('style');
  style.id = 'asset-check-styles';
  style.textContent = `
    .asset-check-panel {
      background: #fff;
      border: 1px solid #e9ecef;
      border-radius: 14px;
      padding: 20px;
      box-shadow: 0 4px 15px rgba(0,0,0,0.06);
      margin-bottom: 18px;
    }

    .asset-check-scan-row {
      display: grid;
      grid-template-columns: minmax(240px, 1fr) auto auto;
      gap: 10px;
      align-items: end;
    }

    .asset-check-summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      margin: 16px 0;
    }

    .asset-check-summary-card {
      background: #f8f9fa;
      border: 1px solid #e9ecef;
      border-radius: 12px;
      padding: 14px;
    }

    .asset-check-summary-value {
      font-size: 1.6rem;
      font-weight: 700;
      color: #764ba2;
      margin-bottom: 4px;
    }

    .asset-check-summary-label {
      color: #666;
      font-size: 13px;
    }

    .asset-check-table-wrap {
      overflow-x: auto;
      border: 1px solid #e9ecef;
      border-radius: 12px;
      background: #fff;
    }

    .asset-check-table {
      width: 100%;
      min-width: 680px;
      border-collapse: collapse;
    }

    .asset-check-table th,
    .asset-check-table td {
      padding: 10px 12px;
      border-bottom: 1px solid #f1f1f1;
      text-align: left;
      vertical-align: top;
    }

    .asset-check-table th {
      background: #f8f9fa;
      font-weight: 700;
      color: #495057;
      position: sticky;
      top: 0;
      z-index: 1;
    }

    .asset-check-row-checked {
      background: #eefaf1;
    }

    .asset-check-row-excluded {
      background: #f8f9fa;
      color: #777;
    }

    .asset-check-row-missing {
      background: #fff3cd;
      color: #856404;
    }

    .asset-check-row-untagged { background:#f0fafb; }

    .asset-check-row-flash {
      outline: 3px solid #667eea;
      outline-offset: -3px;
      transition: outline 0.3s ease;
    }

    .asset-check-badge {
      display: inline-block;
      padding: 4px 9px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }

    .asset-check-badge.checked { background: #d4edda; color: #155724; }
    .asset-check-badge.pending { background: #e2e3e5; color: #383d41; }
    .asset-check-badge.ooc { background: #fff3cd; color: #856404; }
    .asset-check-badge.excluded { background: #e9ecef; color: #495057; }
    .asset-check-badge.missing { background: #f8d7da; color: #721c24; }
    .asset-check-badge.untagged { background: #e7f7fa; color: #0e7490; }
    .asset-check-badge.deployed { background: var(--status-deployed-color, #1769aa); color: var(--status-deployed-text, #fff); }
    .asset-check-badge.away { background: #d1ecf1; color: #0c5460; }

    .asset-check-help {
      color: #666;
      font-size: 13px;
      line-height: 1.45;
      margin-top: 6px;
    }

    .asset-check-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .asset-check-row-actions {
      display:grid;
      grid-template-columns:repeat(3,minmax(0,1fr));
      gap:6px;
      align-items:stretch;
      width:100%;
    }
    .asset-check-row-actions .btn {
      min-width:0;
      padding-left:5px;
      padding-right:5px;
      white-space:nowrap;
    }

    @media (max-width: 850px) {
      .asset-check-scan-row {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 640px) {
      .asset-check-panel {
        padding: 14px;
        border-radius: 12px;
      }

      .asset-check-actions {
        display: grid;
        grid-template-columns: 1fr;
        width: 100%;
      }

      .asset-check-table {
        min-width: 620px;
      }
    }
  `;

  style.textContent += `
    #asset-check-section { --check-green:var(--brand-primary,#0f766e);--check-ink:#172b26;--check-muted:#64748b;--check-line:#dce7e3; }
    .asset-check-panel { margin-bottom:12px;padding:14px;border:1px solid var(--check-line);border-radius:7px;box-shadow:none; }
    .asset-check-intro { display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,.75fr);gap:18px;align-items:center; }
    .asset-check-intro h3,.asset-check-session-title h3 { margin:0;color:var(--check-ink);font-size:16px; }
    .asset-check-intro p,.asset-check-session-title p { margin:5px 0 0;color:var(--check-muted);font-size:11px;line-height:1.45; }
    .asset-check-steps { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px; }
    .asset-check-step { min-height:54px;padding:8px;border:1px solid #dfe8e5;border-radius:6px;background:#f8fbfa;color:#50655f;font-size:9px;line-height:1.35; }
    .asset-check-step strong { display:block;margin-bottom:3px;color:var(--check-green);font-size:10px; }
    .asset-check-scan-row { grid-template-columns:minmax(220px,1fr) auto auto auto;gap:8px;align-items:end;margin-top:13px;padding-top:13px;border-top:1px solid #e4ece9; }
    .asset-check-scan-row .form-input { min-height:39px;border-color:#cbdad5;border-radius:6px;font-size:12px; }
    .asset-check-scan-row .form-label { color:#40564f;font-size:10px;font-weight:800; }
    .asset-check-help { margin-top:5px;color:var(--check-muted);font-size:9px; }
    .asset-check-session-head { display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap; }
    .asset-check-progress { margin-top:13px; }
    .asset-check-progress-meta { display:flex;justify-content:space-between;gap:10px;margin-bottom:5px;color:var(--check-muted);font-size:9px;font-weight:700; }
    .asset-check-progress-track { height:7px;overflow:hidden;border-radius:4px;background:#e5eeeb; }
    .asset-check-progress-fill { height:100%;border-radius:inherit;background:var(--check-green);transition:width .2s ease; }
    .asset-check-summary-grid { grid-template-columns:repeat(4,minmax(0,1fr));gap:0;margin:12px 0 0;border:1px solid var(--check-line);border-radius:7px;overflow:hidden; }
    .asset-check-summary-card { min-height:66px;padding:10px 12px;border:0;border-right:1px solid var(--check-line);border-radius:0;background:#fff; }
    .asset-check-summary-card:last-child { border-right:0; }
    .asset-check-summary-value { margin:0 0 4px;color:var(--check-ink);font-size:19px; }
    .asset-check-summary-label { color:var(--check-muted);font-size:9px;font-weight:700; }
    .asset-check-table-wrap { overflow:hidden;border-color:var(--check-line);border-radius:7px; }
    .asset-check-table { min-width:0;font-size:10px; }
    .asset-check-table th { padding:7px 10px;background:#f2f7f5;color:#62756f;font-size:9px;text-transform:uppercase; }
    .asset-check-table td { padding:7px 10px;border-bottom-color:#e7eeec; }
    .asset-check-table tbody tr { transition:background .16s ease; }
    .asset-check-row-checked { background:#f0faf6; }
    .asset-check-row-excluded { background:#f7f9f8;color:#70827c; }
    .asset-check-row-missing { background:#fff5f5;color:#8f2731; }
    .asset-check-row-flash { outline:2px solid var(--check-green); }
    .asset-check-badge { padding:3px 6px;border-radius:4px;font-size:9px; }
    .asset-check-badge.checked { background:#e7f6ee;color:#13734c; }
    .asset-check-badge.pending { background:#edf3f1;color:#536861; }
    .asset-check-badge.ooc { background:#fdebed;color:#a61b29; }
    .asset-check-badge.excluded { background:#edf0f2;color:#4f5d58; }
    .asset-check-badge.missing { background:#fdebed;color:#a61b29; }
    .asset-check-badge.untagged { background:#e7f7fa;color:#0e7490; }
    .asset-check-badge.deployed { background:var(--status-deployed-color, #1769aa);color:var(--status-deployed-text, #fff); }
    .asset-check-badge.away { background:#fff3df;color:#8a5b08; }
    .asset-check-actions .btn,.asset-check-table .btn { min-height:31px;padding:5px 8px;font-size:9px; }
    @media(max-width:800px) {
      .asset-check-intro { grid-template-columns:1fr; }
      .asset-check-scan-row { grid-template-columns:1fr 1fr; }
      .asset-check-scan-row .form-group { grid-column:1/-1; }
      .asset-check-summary-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .asset-check-summary-card { border-top:1px solid var(--check-line); }
      .asset-check-summary-card:nth-child(-n+2) { border-top:0; }
      .asset-check-summary-card:nth-child(even) { border-right:0; }
    }
    @media(max-width:620px) {
      .asset-check-steps { grid-template-columns:1fr; }
      .asset-check-step { min-height:0; }
      .asset-check-scan-row { grid-template-columns:1fr; }
      .asset-check-scan-row > * { grid-column:1!important; }
      .asset-check-actions { width:100%;grid-template-columns:1fr; }
      .asset-check-table-wrap { border:0;background:transparent;overflow:visible; }
      .asset-check-table,.asset-check-table tbody,.asset-check-table tr,.asset-check-table td { display:block;width:100%;min-width:0; }
      .asset-check-table thead { display:none; }
      .asset-check-table tbody { display:grid;gap:7px; }
      .asset-check-table tr { position:relative;padding:10px 10px 9px;border:1px solid var(--check-line);border-radius:7px;background:#fff; }
      .asset-check-table tr.asset-check-row-checked { border-left:4px solid #159f6a;background:#f5fbf8; }
      .asset-check-table tr.asset-check-row-missing { border-left:4px solid #d84b52;background:#fff8f8; }
      .asset-check-table tr.asset-check-row-excluded { background:#f7f9f8; }
      .asset-check-table td { display:grid;grid-template-columns:80px minmax(0,1fr);gap:7px;padding:3px 0;border:0;line-height:1.35; }
      .asset-check-table td::before { color:var(--check-muted);font-size:8px;font-weight:800;text-transform:uppercase;content:attr(data-label); }
      .asset-check-table td:last-child { display:block;margin-top:5px;padding-top:7px;border-top:1px solid #e3ebe8; }
      .asset-check-table td:last-child::before { display:block;margin-bottom:6px; }
      .asset-check-table td:last-child .btn { width:100%;font-size:8px; }
      .asset-check-row-actions { grid-template-columns:repeat(3,minmax(0,1fr));gap:4px; }
    }
  `;

  document.head.appendChild(style);
}

function resetAssetCheckState() {
  assetCheckState = {
    group: null,
    assets: [],
    checked: new Set(),
    checkIds: {},
    seedIdentifier: ''
  };
}

function loadAssetCheck() {
  ensureAssetCheckStyles();
  resetAssetCheckState();

  const container = document.getElementById("asset-check-content");
  if (!container) return;

  container.innerHTML = `
    <div class="asset-check-panel">
      <div class="asset-check-intro">
        <div>
          <h3>Start a stock check</h3>
          <p>Scan one Asset ID or serial number to load every matching asset by department, brand, model, and description.</p>
        </div>
        <div class="asset-check-steps" aria-label="Asset check workflow">
          <div class="asset-check-step"><strong>1. Scan</strong>Start with any asset in the model group.</div>
          <div class="asset-check-step"><strong>2. Count</strong>Scan or sight each item physically in Store.</div>
          <div class="asset-check-step"><strong>3. Resolve</strong>Review items not sighted before marking missing.</div>
        </div>
      </div>

      <div class="asset-check-scan-row">
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">First Asset ID or Serial Number</label>
          <input
            type="text"
            class="form-input"
            id="assetCheckSeedInput"
            placeholder="Scan or type the first asset..."
            autocomplete="off"
          >
          <div class="asset-check-help">
            Assets currently out on show or away from Store will still be shown, but they will be excluded from the missing check.
          </div>
        </div>

        <button class="btn btn-success" onclick="startAssetCheck()">Start check</button>
        ${scannerButtonHtml("scanForAssetCheck('assetCheckSeedInput', 'start')")}
        <button class="btn btn-secondary" onclick="loadAssetCheck()">Reset</button>
      </div>
    </div>
  `;

  const input = document.getElementById('assetCheckSeedInput');
  if (input) {
    input.focus();
    input.addEventListener('keypress', function (e) {
      if (e.key === 'Enter') startAssetCheck();
    });
  }
}

function createAssetCheckLogId(assetId) {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return `asset-check-${window.crypto.randomUUID()}`;
  }
  return `asset-check-${Date.now()}-${Math.random().toString(16).slice(2)}-${String(assetId || '').replace(/[^A-Za-z0-9_-]+/g, '')}`;
}

async function setAssetCheckChecked(assetId, checked) {
  const cleanAssetId = String(assetId || '').trim();
  if (!cleanAssetId) throw new Error('Asset ID is required');

  const checkId = checked
    ? (assetCheckState.checkIds[cleanAssetId] || createAssetCheckLogId(cleanAssetId))
    : (assetCheckState.checkIds[cleanAssetId] || '');

  const response = await apiCall('/api/asset-check/sighting', 'POST', {
    assetId: cleanAssetId,
    groupKey: assetCheckState.group?.key || '',
    checkId,
    checked: !!checked
  });

  if (checked) {
    assetCheckState.checked.add(cleanAssetId);
    assetCheckState.checkIds[cleanAssetId] = response.data?.checkId || checkId;
  } else {
    assetCheckState.checked.delete(cleanAssetId);
    delete assetCheckState.checkIds[cleanAssetId];
  }

  return response;
}

// Event handler functions

function populateTransferDropdowns(options) {
  const fromSelect = document.getElementById("transferFromEvent");
  const toSelect = document.getElementById("transferToEvent");
  if (!fromSelect || !toSelect) return;

  const sourceEvents = Array.isArray(options) ? options : (options?.sourceEvents || []);
  const targetEvents = Array.isArray(options) ? options : (options?.targetEvents || []);

  fromSelect.innerHTML = '<option value="">Select source event...</option>';
  toSelect.innerHTML = '<option value="">Select destination event...</option>';

  sourceEvents.forEach((event) => {
    const tagPrefix = event.tag === 'dry hire' ? '[DH]' : '[E]';
    const option = document.createElement("option");
    option.value = event.id;
    option.textContent = `${tagPrefix} ${event.id}: ${event.name} (${eventStateDisplayLabel(event.state)})`;
    fromSelect.appendChild(option);
  });

  targetEvents.forEach((event) => {
    const tagPrefix = event.tag === 'dry hire' ? '[DH]' : '[E]';
    const option = document.createElement("option");
    option.value = event.id;
    option.textContent = `${tagPrefix} ${event.id}: ${event.name} (${eventStateDisplayLabel(event.state)})`;
    toSelect.appendChild(option);
  });
}

async function startAssetCheck() {
  const input = document.getElementById('assetCheckSeedInput') || document.getElementById('assetCheckInput');
  const identifier = input ? input.value.trim() : '';

  if (!identifier) {
    showNotification('warning', 'Scan or enter an Asset ID first');
    input?.focus();
    return;
  }

  try {
    const response = await apiCall('/api/asset-check/group', 'POST', { identifier });
    const data = response.data || {};

    assetCheckState.group = data.group || null;
    assetCheckState.assets = Array.isArray(data.assets) ? data.assets : [];
    assetCheckState.checked = new Set();
    assetCheckState.checkIds = {};
    assetCheckState.seedIdentifier = identifier;

    const scannedAsset = data.scannedAsset;
    if (scannedAsset && scannedAsset.checkEligible && scannedAsset.id) {
      await setAssetCheckChecked(scannedAsset.id, true);
    }

    renderAssetCheckSession();

    if (scannedAsset && scannedAsset.checkEligible) {
      showNotification('success', `${scannedAsset.id} sighted. Loaded ${assetCheckState.assets.length} matching assets.`);
    } else if (scannedAsset) {
      showNotification('warning', `${scannedAsset.id || identifier} loaded, but it is excluded from the check: ${scannedAsset.exclusionReason || 'Not checkable'}`);
    }
  } catch (error) {
    showNotification('error', `Failed to start Asset Check: ${error.message}`);
    input?.focus();
  }
}

function renderAssetCheckSession() {
  ensureAssetCheckStyles();

  const container = document.getElementById('asset-check-content');
  if (!container) return;

  const group = assetCheckState.group || {};
  const checkableAssets = assetCheckState.assets.filter(asset => asset.checkEligible);
  const checkedCount = checkableAssets.filter(asset => asset.id && assetCheckState.checked.has(asset.id)).length;
  const uncheckedCount = Math.max(checkableAssets.length - checkedCount, 0);
  const excludedCount = assetCheckState.assets.filter(asset => asset.excluded && !asset.isMissing).length;
  const missingCount = assetCheckState.assets.filter(asset => asset.isMissing).length;
  const completion = checkableAssets.length ? Math.round((checkedCount / checkableAssets.length) * 100) : 0;

  container.innerHTML = `
    <div class="asset-check-panel">
      <div class="asset-check-session-head">
        <div class="asset-check-session-title">
          <h3>${escapeHtml(group.displayName || 'Asset Check')}</h3>
          <p>Scan or sight each item physically present in Store. Use Mark untagged when the ID label is missing but the serial number confirms the asset.</p>
        </div>
        <div class="asset-check-actions">
          <button class="btn btn-danger" onclick="markUncheckedAssetCheckMissing()" ${uncheckedCount === 0 ? 'disabled' : ''}>
            Mark not sighted as missing
          </button>
          <button class="btn btn-secondary" onclick="loadAssetCheck()">New check</button>
        </div>
      </div>

      <div class="asset-check-progress">
        <div class="asset-check-progress-meta"><span>${checkedCount} of ${checkableAssets.length} checkable assets sighted</span><strong>${completion}%</strong></div>
        <div class="asset-check-progress-track"><div class="asset-check-progress-fill" style="width:${completion}%"></div></div>
      </div>

      <div class="asset-check-summary-grid">
        <div class="asset-check-summary-card">
          <div class="asset-check-summary-value">${checkedCount}</div>
          <div class="asset-check-summary-label">Sighted in Store</div>
        </div>
        <div class="asset-check-summary-card">
          <div class="asset-check-summary-value">${uncheckedCount}</div>
          <div class="asset-check-summary-label">Not sighted in Store</div>
        </div>
        <div class="asset-check-summary-card">
          <div class="asset-check-summary-value">${excludedCount}</div>
          <div class="asset-check-summary-label">Excluded but visible</div>
        </div>
        <div class="asset-check-summary-card">
          <div class="asset-check-summary-value">${missingCount}</div>
          <div class="asset-check-summary-label">Already Missing</div>
        </div>
      </div>

      <div class="asset-check-scan-row" style="margin-top: 12px;">
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Continue Scanning Asset ID or Serial Number</label>
          <input
            type="text"
            class="form-input"
            id="assetCheckScanInput"
            placeholder="Scan the next matching asset..."
            autocomplete="off"
          >
        </div>
        <button class="btn btn-success" onclick="checkAsset()">Sighted</button>
        ${scannerButtonHtml("scanForAssetCheck('assetCheckScanInput', 'continue')")}
        <button class="btn btn-secondary" onclick="renderAssetCheckSession()">Refresh</button>
      </div>
    </div>

    <div class="asset-check-table-wrap">
      <table class="asset-check-table">
        <thead>
          <tr>
            <th style="width:130px;">Asset ID</th>
            <th>Serial</th>
            <th>Status</th>
            <th>Location</th>
            <th>Notes</th>
            <th style="width:230px;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${assetCheckState.assets.map(renderAssetCheckRow).join('')}
        </tbody>
      </table>
    </div>
  `;

  const scanInput = document.getElementById('assetCheckScanInput');
  if (scanInput) {
    scanInput.focus();
    scanInput.addEventListener('keypress', function (e) {
      if (e.key === 'Enter') checkAsset();
    });
  }
}

function renderAssetCheckRow(asset) {
  const assetId = asset.id || asset.internalId || '';
  const encodedAssetId = encodeURIComponent(assetId);
  const isChecked = asset.checkEligible && assetId && assetCheckState.checked.has(assetId);

  let rowClass = '';
  if (asset.isMissing) rowClass = 'asset-check-row-missing';
  else if (asset.excluded) rowClass = 'asset-check-row-excluded';
  else if (asset.isUntagged) rowClass = 'asset-check-row-untagged';
  else if (isChecked) rowClass = 'asset-check-row-checked';

  return `
    <tr id="asset-check-row-${escapeHtmlAttr(encodedAssetId)}" class="${rowClass}">
      <td data-label="Asset ID"><strong>${escapeHtml(assetId || 'Bulk Item')}</strong></td>
      <td data-label="Serial">${escapeHtml(asset.serial || '-')}</td>
      <td data-label="Status">${getAssetCheckStatusBadge(asset, isChecked)}</td>
      <td data-label="Location">${escapeHtml(asset.location || 'Store')}</td>
      <td data-label="Notes">${escapeHtml(asset.exclusionReason || (asset.isOOC ? 'OOC, but still checkable because it is in Store' : ''))}</td>
      <td data-label="Action">
        ${asset.checkEligible ? `
          <div class="asset-check-row-actions">
            <button type="button" class="btn ${isChecked ? 'btn-secondary' : 'btn-success'} btn-sm" onclick="toggleAssetCheck('${escapeHtmlAttr(encodedAssetId)}')">
              ${isChecked ? 'Undo sighting' : 'Sighted'}
            </button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="markAssetCheckUntagged('${escapeHtmlAttr(encodedAssetId)}')" ${asset.isUntagged ? 'disabled' : ''}>
              ${asset.isUntagged ? 'Untagged' : 'Mark untagged'}
            </button>
            <button type="button" class="btn btn-warning btn-sm" onclick="openAssetCheckFault('${escapeHtmlAttr(encodedAssetId)}')">
              Log fault
            </button>
          </div>
        ` : '<span style="font-size:12px;color:#777;">Excluded</span>'}
      </td>
    </tr>
  `;
}

function getAssetCheckStatusBadge(asset, isChecked) {
  if (asset.isMissing) return '<span class="asset-check-badge missing">Missing</span>';
  if (asset.status === 'deployed') return '<span class="asset-check-badge deployed">Out on Show</span>';
  if (asset.status === 'away') return '<span class="asset-check-badge away">Away</span>';
  if (asset.status === 'bulk') return '<span class="asset-check-badge excluded">Bulk</span>';
  if (asset.status === 'ooc') return '<span class="asset-check-badge ooc">OOC / Checkable</span>';
  if (asset.isUntagged || asset.status === 'untagged') return `<span class="asset-check-badge untagged">Untagged${isChecked ? ' / Sighted' : ''}</span>`;
  if (isChecked) return '<span class="asset-check-badge checked">Sighted</span>';
  if (asset.excluded) return '<span class="asset-check-badge excluded">Excluded</span>';
  return '<span class="asset-check-badge pending">Not sighted</span>';
}

async function toggleAssetCheck(encodedAssetId) {
  const assetId = decodeURIComponent(encodedAssetId || '');
  const asset = assetCheckState.assets.find(item => item.id === assetId);

  if (!asset) {
    showNotification('warning', 'Asset not found in this check group');
    return;
  }

  if (!asset.checkEligible) {
    showNotification('warning', `${assetId} is excluded: ${asset.exclusionReason || 'Not checkable'}`);
    flashAssetCheckRow(assetId);
    return;
  }

  const shouldCheck = !assetCheckState.checked.has(assetId);

  try {
    await setAssetCheckChecked(assetId, shouldCheck);
  } catch (error) {
    showNotification('error', `Failed to ${shouldCheck ? 'sight' : 'undo sighting for'} ${assetId}: ${error.message}`);
    return;
  }

  renderAssetCheckSession();
  flashAssetCheckRow(assetId);
}

async function markAssetCheckUntagged(encodedAssetId) {
  const assetId = decodeURIComponent(encodedAssetId || '');
  const asset = assetCheckState.assets.find(item => item.id === assetId);

  if (!asset || !asset.checkEligible) {
    showNotification('warning', asset?.exclusionReason || 'This asset cannot be marked Untagged');
    return;
  }
  if (asset.isUntagged) {
    showNotification('info', `${assetId} is already marked Untagged`);
    return;
  }

  const serial = String(asset.serial || asset.serial2 || '').trim();
  const confirmed = await showAppConfirm({
    title: 'Mark asset untagged',
    message: `${assetId}${serial ? ` (serial ${serial})` : ''} will be marked Untagged and recorded as sighted. Use this when the physical ID label is missing but the asset has been verified by serial number.`,
    confirmText: 'Mark untagged',
    cancelText: 'Cancel'
  });
  if (!confirmed) return;

  const checkId = assetCheckState.checkIds[assetId] || createAssetCheckLogId(assetId);
  try {
    const response = await apiCall('/api/asset-check/mark-untagged', 'POST', {
      assetId,
      groupKey: assetCheckState.group?.key || '',
      checkId
    });
    assetCheckState.checked.add(assetId);
    assetCheckState.checkIds[assetId] = response.data?.checkId || checkId;
    await refreshAssetCheckGroup(true);
    renderAssetCheckSession();
    flashAssetCheckRow(assetId);
    showNotification('success', `${assetId} marked Untagged and sighted`);
  } catch (error) {
    showNotification('error', `Failed to mark ${assetId} Untagged: ${error.message}`);
  }
}

async function checkAsset() {
  const input = document.getElementById('assetCheckScanInput');
  const identifier = input ? input.value.trim() : '';

  if (!assetCheckState.group) {
    showNotification('warning', 'Start an Asset Check first');
    loadAssetCheck();
    return;
  }

  if (!identifier) {
    showNotification('warning', 'Scan or enter an Asset ID');
    input?.focus();
    return;
  }

  const identifierLower = identifier.toLowerCase();
  const asset = assetCheckState.assets.find(item =>
    String(item.id || '').toLowerCase() === identifierLower ||
    String(item.internalId || '').toLowerCase() === identifierLower ||
    (item.serial && String(item.serial).toLowerCase() === identifierLower)
  );

  if (!asset) {
    showNotification('warning', `${identifier} is not part of this model/description group`);
    input.value = '';
    input.focus();
    return;
  }

  if (!asset.checkEligible) {
    showNotification('warning', `${asset.id || identifier} is excluded: ${asset.exclusionReason || 'Not checkable'}`);
    input.value = '';
    renderAssetCheckSession();
    flashAssetCheckRow(asset.id || asset.internalId || identifier);
    return;
  }

  if (assetCheckState.checked.has(asset.id)) {
    showNotification('info', `${asset.id} is already sighted`);
    input.value = '';
    renderAssetCheckSession();
    flashAssetCheckRow(asset.id);
    return;
  }

  try {
    await setAssetCheckChecked(asset.id, true);
  } catch (error) {
    showNotification('error', `Failed to sight ${asset.id}: ${error.message}`);
    input.focus();
    return;
  }

  showNotification('success', `${asset.id} sighted`);
  input.value = '';
  renderAssetCheckSession();
  flashAssetCheckRow(asset.id);
}

function flashAssetCheckRow(assetId) {
  const encodedAssetId = encodeURIComponent(assetId || '');
  setTimeout(() => {
    const row = document.getElementById(`asset-check-row-${encodedAssetId}`);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('asset-check-row-flash');
    setTimeout(() => row.classList.remove('asset-check-row-flash'), 1200);
  }, 50);
}

async function refreshAssetCheckGroup(keepChecked = true) {
  if (!assetCheckState.seedIdentifier) return;

  const existingChecked = new Set(assetCheckState.checked);
  const response = await apiCall('/api/asset-check/group', 'POST', {
    identifier: assetCheckState.seedIdentifier
  });

  const data = response.data || {};
  assetCheckState.group = data.group || assetCheckState.group;
  assetCheckState.assets = Array.isArray(data.assets) ? data.assets : [];
  assetCheckState.checked = keepChecked ? existingChecked : new Set();
  if (!keepChecked) assetCheckState.checkIds = {};
}

async function markUncheckedAssetCheckMissing() {
  if (!assetCheckState.group) {
    showNotification('warning', 'Start an Asset Check first');
    return;
  }

  const uncheckedAssets = assetCheckState.assets.filter(asset =>
    asset.checkEligible && asset.id && !assetCheckState.checked.has(asset.id)
  );

  if (uncheckedAssets.length === 0) {
    showNotification('success', 'There are no in-store assets left unsighted to mark as missing');
    return;
  }

  const preview = uncheckedAssets.slice(0, 12).map(asset => asset.id).join(', ');
  const extra = uncheckedAssets.length > 12 ? ` and ${uncheckedAssets.length - 12} more` : '';
  const confirmed = await showAppConfirm({
    title: 'Mark Missing',
    message:
      `Mark ${uncheckedAssets.length} in-store asset(s) that were not sighted as Missing?\n\n` +
      `${preview}${extra}\n\n` +
      `Assets that are out on show or away from Store are excluded and will not be marked missing.`,
    confirmText: 'Mark Missing',
    cancelText: 'Cancel',
    variant: 'warning',
  });

  if (!confirmed) return;

  try {
    const response = await apiCall('/api/asset-check/mark-missing', 'POST', {
      assetIds: uncheckedAssets.map(asset => asset.id),
      groupKey: assetCheckState.group.key,
      confirm: true
    });

    const marked = response.data?.marked || [];
    const skipped = response.data?.skipped || [];

    await refreshAssetCheckGroup(true);
    renderAssetCheckSession();

    if (skipped.length > 0) {
      showNotification('warning', `Marked ${marked.length} as Missing. Skipped ${skipped.length} item(s) that were no longer eligible.`);
      console.warn('Asset Check skipped items:', skipped);
    } else {
      showNotification('success', `Marked ${marked.length} unsighted asset(s) as Missing`);
    }
  } catch (error) {
    showNotification('error', `Failed to mark unsighted assets as missing: ${error.message}`);
  }
}
