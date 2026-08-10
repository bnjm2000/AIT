// Inventory filtering and client-side PDF export.

// Inventory sorting and export helpers
function getInventorySortValue(asset, sortBy) {
  if (!asset) return '';
  if (sortBy === 'id') return asset.isBulk ? (asset.internalId || asset.bulkId || `${asset.brand || ''} ${asset.model || ''} ${asset.description || ''}`) : (asset.id || asset.internalId || '');
  if (sortBy === 'serial') return asset.isBulk ? '' : (asset.serial || '');
  if (sortBy === 'department') return asset.department || '';
  if (sortBy === 'status') return asset.status || '';
  if (sortBy === 'location') return asset.location || '';
  if (sortBy === 'dateOfPurchase' || sortBy === 'purchaseDate') return normalizeAssetPurchaseDateValue(asset.dateOfPurchase || asset.purchaseDate || '');
  if (sortBy === 'dateAdded') return normalizeAssetAuditDateTime(asset.dateAdded || '');
  if (sortBy === 'dateModified') return normalizeAssetAuditDateTime(asset.dateModified || '');
  return asset[sortBy] || '';
}

function inventorySearchTerms(searchTerm) {
  return String(searchTerm || '')
    .toLowerCase()
    .split('+')
    .map(term => term.trim())
    .filter(Boolean);
}

function inventorySearchTextMatches(searchableText, searchTerms) {
  return !searchTerms.length || searchTerms.some(term => searchableText.includes(term));
}

function getInventoryFilterState() {
  const searchTerm = document.getElementById('asset-search')?.value || '';
  const departmentSelection = getInventoryCheckboxFilterValues('department-filter');
  const statusSelection = getInventoryCheckboxFilterValues('status-filter');

  return {
    searchTerm: searchTerm.toLowerCase(),
    searchTerms: inventorySearchTerms(searchTerm),
    searchLabel: searchTerm.trim(),
    deptFilters: departmentSelection.values,
    departmentFilterTotal: departmentSelection.total,
    statusFilters: statusSelection.values,
    statusFilterTotal: statusSelection.total,
    sortBy: document.getElementById('sort-select')?.value || 'id',
    sortDesc: document.getElementById('sort-descending')?.checked || false
  };
}

function getFilteredInventoryData() {
  const filters = getInventoryFilterState();
  const sourceAssets = Array.isArray(assets) ? assets : [];

  let filteredAssets = sourceAssets.filter((asset) => {
    const deptMeta = getDepartmentMeta(asset.department);
    const searchableText = `${asset.id || ''} ${asset.internalId || ''} ${asset.bulkId || ''} ${asset.brand || ''} ${asset.model || ''} ${asset.version || ''} ${asset.serial || ''} ${asset.serial2 || ''} ${asset.description || ''} ${assetTagSearchText(asset)} ${asset.dateOfPurchase || asset.purchaseDate || ''} ${asset.dateAdded || ''} ${asset.dateModified || ''} ${asset.department || ''} ${deptMeta.name || ''}`.toLowerCase();
    const matchesSearch = inventorySearchTextMatches(searchableText, filters.searchTerms);
    const matchesDept = filters.departmentFilterTotal === 0 || filters.deptFilters.includes(asset.department);
    const condition = getAssetConditionStatus(asset);
    const matchesStatus = filters.statusFilterTotal === 0 || filters.statusFilters.some(status => {
      if (status === 'available') return condition === 'available' && asset.status !== 'deployed';
      if (status === 'deployed') return asset.status === 'deployed';
      if (status === condition) return true;
      if (!asset.isBulk) return false;
      if (status === 'ooc') return Number(asset.bulkOOCQuantity || 0) > 0;
      if (status === 'missing') return Number(asset.bulkMissingQuantity || 0) > 0;
      if (status === 'degraded') return Number(asset.bulkDegradedQuantity || 0) > 0;
      return false;
    });
    return matchesSearch && matchesDept && matchesStatus;
  });

  filteredAssets.sort((a, b) => {
    let aVal = String(getInventorySortValue(a, filters.sortBy) ?? '').toLowerCase();
    let bVal = String(getInventorySortValue(b, filters.sortBy) ?? '').toLowerCase();
    const primary = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' });
    if (primary !== 0) return filters.sortDesc ? -primary : primary;
    const fallbackA = `${a.brand || ''} ${a.model || ''} ${a.description || ''} ${a.internalId || a.id || ''}`.toLowerCase();
    const fallbackB = `${b.brand || ''} ${b.model || ''} ${b.description || ''} ${b.internalId || b.id || ''}`.toLowerCase();
    const secondary = fallbackA.localeCompare(fallbackB, undefined, { numeric: true, sensitivity: 'base' });
    return filters.sortDesc ? -secondary : secondary;
  });

  return {
    filters,
    filteredAssets,
    totalAssets: sourceAssets.length
  };
}

function displayFilteredInventory() {
  const { filteredAssets, totalAssets } = getFilteredInventoryData();
  renderInventorySummary();
  const countElement = document.getElementById('asset-count');
  if (countElement) {
    const groups = groupInventoryByModel(filteredAssets).length;
    countElement.textContent = `${groups} model${groups === 1 ? '' : 's'} · ${filteredAssets.length} of ${totalAssets} records`;
  }
  displayInventoryTable(filteredAssets);
}

function inventoryPlainText(value, fallback = '-') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function inventoryStatusText(status) {
  const cleanStatus = inventoryPlainText(status, 'available').toLowerCase();
  if (cleanStatus === 'disposed') return 'Decommissioned';
  if (cleanStatus === 'ooc') return 'OOC';
  return cleanStatus
    .replace(/-/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function inventoryStatusPdfMeta(status) {
  const cleanStatus = inventoryPlainText(status, 'available').toLowerCase();
  const palette = {
    available: { background: '#dcfce7', color: '#14532d' },
    deployed: { background: ASSET_DEPLOYED_COLOR, color: '#ffffff' },
    degraded: { background: '#fef3c7', color: '#78350f' },
    missing: { background: '#fee2e2', color: '#7f1d1d' },
    ooc: { background: '#fee2e2', color: '#7f1d1d' },
    decommissioned: { background: '#e5e7eb', color: '#374151' },
    disposed: { background: '#e5e7eb', color: '#374151' }
  };
  return {
    label: inventoryStatusText(cleanStatus),
    ...(palette[cleanStatus] || palette.available)
  };
}

function inventoryStatusPdfBadgeHtml(status, label = null) {
  const meta = inventoryStatusPdfMeta(status);
  return pdfInlineBadgeHtml(label || meta.label, meta.background, meta.color, { style: 'margin:0 3px 3px 0;' });
}

function inventoryDepartmentLabel(code) {
  const dept = getDepartmentMeta(code);
  const deptCode = normalizeDepartmentCode(dept.code || code || 'UN');
  return dept.name && dept.name !== deptCode ? `${deptCode} - ${dept.name}` : deptCode;
}

function inventoryDepartmentPdfBadgeHtml(code) {
  const dept = getDepartmentMeta(code);
  const bg = safePdfHexColour(dept.color, '#e2e3e5');
  const fg = safePdfHexColour(dept.textColor, getReadableTextColour(bg));
  return pdfInlineBadgeHtml(inventoryDepartmentLabel(dept.code || code || 'UN'), bg, fg, {
    title: dept.name || dept.code,
    style: 'margin:0 3px 3px 0;'
  });
}

function inventoryExportQuantity(asset, statusFilter = '') {
  return Object.values(inventoryExportStatusCounts(asset, statusFilter))
    .reduce((sum, quantity) => sum + quantity, 0);
}

function inventoryExportStatusCounts(asset, statusFilter = '') {
  if (!asset) return {};

  const counts = {};
  const addCount = (status, quantity) => {
    const normalizedStatus = status === 'disposed' ? 'decommissioned' : status;
    const safeQuantity = Math.max(0, Number(quantity || 0) || 0);
    if (safeQuantity > 0) {
      counts[normalizedStatus] = (counts[normalizedStatus] || 0) + safeQuantity;
    }
  };

  if (!asset.isBulk) {
    const condition = getAssetConditionStatus(asset);
    const status = condition === 'available' && asset.status === 'deployed'
      ? 'deployed'
      : condition;
    addCount(status, 1);
  } else {
    const total = Math.max(1, Number(asset.quantity || 1) || 1);
    const condition = getAssetConditionStatus(asset);

    if (condition === 'decommissioned') {
      addCount('decommissioned', total);
    } else {
      let remaining = total;
      const deployed = Math.min(
        remaining,
        Math.max(0, Number(asset.deployedQuantity || 0) || 0)
      );
      addCount('deployed', deployed);
      remaining -= deployed;

      if (asset.isMissing) {
        addCount('missing', remaining);
        remaining = 0;
      } else if (asset.isOOC) {
        addCount('ooc', remaining);
        remaining = 0;
      } else {
        const missing = Math.min(
          remaining,
          Math.max(0, Number(asset.bulkMissingQuantity || 0) || 0)
        );
        addCount('missing', missing);
        remaining -= missing;

        const ooc = Math.min(
          remaining,
          Math.max(0, Number(asset.bulkOOCQuantity || 0) || 0)
        );
        addCount('ooc', ooc);
        remaining -= ooc;

        const degraded = asset.isDegraded
          ? remaining
          : Math.min(
              remaining,
              Math.max(0, Number(asset.bulkDegradedQuantity || 0) || 0)
            );
        addCount('degraded', degraded);
        remaining -= degraded;
        addCount('available', remaining);
      }
    }

  }

  const normalizedFilter = statusFilter === 'disposed' ? 'decommissioned' : statusFilter;
  return normalizedFilter
    ? (counts[normalizedFilter] ? { [normalizedFilter]: counts[normalizedFilter] } : {})
    : counts;
}

function inventoryAssetFlagsText(asset) {
  const flags = [];
  if (asset?.isMissing) flags.push('Missing');
  if (asset?.isOOC) flags.push('OOC');
  if (asset?.isUntagged) flags.push('Untagged');
  if (asset?.isDegraded) flags.push('Degraded');
  if (asset?.isBulk) {
    const oocQty = Math.max(0, Number(asset.bulkOOCQuantity || 0) || 0);
    const missingQty = Math.max(0, Number(asset.bulkMissingQuantity || 0) || 0);
    const degradedQty = Math.max(0, Number(asset.bulkDegradedQuantity || 0) || 0);
    if (!asset?.isOOC && oocQty > 0) flags.push(`${oocQty} OOC`);
    if (!asset?.isMissing && missingQty > 0) flags.push(`${missingQty} Missing`);
    if (!asset?.isDegraded && degradedQty > 0) flags.push(`${degradedQty} Degraded`);
  }
  if (asset?.isDisposed || asset?.isDecommissioned) flags.push('Decommissioned');
  return flags.length ? flags.join(', ') : 'OK';
}

function inventoryAssetFlagsPdfHtml(asset) {
  if (asset?.isBulk) {
    const flagCounts = inventoryExportStatusCounts(asset);
    const entries = ['ooc', 'missing', 'degraded', 'decommissioned']
      .filter(status => Number(flagCounts[status] || 0) > 0);
    return entries.length
      ? entries.map(status => inventoryStatusPdfBadgeHtml(
          status,
          `${inventoryStatusText(status)}: ${flagCounts[status]}`
        )).join('')
      : inventoryStatusPdfBadgeHtml('available', 'OK');
  }
  const status = getAssetConditionStatus(asset);
  const label = status === 'available' ? 'OK' : inventoryStatusText(status);
  return inventoryStatusPdfBadgeHtml(status, label);
}

function inventoryAssetQuantityText(asset) {
  if (!asset?.isBulk) return '1';
  const total = Math.max(1, Number(asset.quantity || 1) || 1);
  const available = Math.max(0, Number(asset.availableQuantity ?? total) || 0);
  return `${available}/${total}`;
}

function inventoryFilterSummary(filters, rowCount) {
  const parts = [];
  if (filters.searchLabel) parts.push(`Search: ${filters.searchLabel}`);
  if (filters.departmentFilterTotal > 0 && filters.deptFilters.length < filters.departmentFilterTotal) {
    const departmentsText = filters.deptFilters.length
      ? filters.deptFilters.map(inventoryDepartmentLabel).join(', ')
      : 'None selected';
    parts.push(`Departments: ${departmentsText}`);
  }
  if (filters.statusFilterTotal > 0 && filters.statusFilters.length < filters.statusFilterTotal) {
    const statusesText = filters.statusFilters.length
      ? filters.statusFilters.map(inventoryStatusText).join(', ')
      : 'None selected';
    parts.push(`Statuses: ${statusesText}`);
  }
  if (parts.length === 0) parts.push('Filters: All inventory assets');

  const sortLabelMap = {
    id: 'Asset ID',
    brand: 'Brand',
    model: 'Model',
    department: 'Department',
    status: 'Status',
    location: 'Location'
  };
  parts.push(`Sort: ${sortLabelMap[filters.sortBy] || filters.sortBy}${filters.sortDesc ? ' descending' : ' ascending'}`);
  parts.push(`No. of assets: ${rowCount}`);
  return parts;
}

function groupInventoryAssetsForExport(filteredAssets, filters) {
  const groups = new Map();

  filteredAssets.forEach(asset => {
    const department = normalizeDepartmentCode(asset.department || 'UN');
    const brand = inventoryPlainText(asset.brand);
    const model = inventoryPlainText(asset.model);
    const key = JSON.stringify([department, brand, model]);
    const statusFilter = filters.statusFilters.length === 1 ? filters.statusFilters[0] : '';
    const assetStatusCounts = inventoryExportStatusCounts(asset, statusFilter);
    const quantity = Object.values(assetStatusCounts)
      .reduce((sum, statusQuantity) => sum + statusQuantity, 0);
    if (quantity <= 0) return;

    if (!groups.has(key)) {
      groups.set(key, {
        department,
        departmentLabel: inventoryDepartmentLabel(department),
        brand,
        model,
        descriptions: new Set(),
        count: 0,
        statusCounts: {}
      });
    }

    const group = groups.get(key);
    if (asset.description) group.descriptions.add(asset.description);
    group.count += quantity;
    Object.entries(assetStatusCounts).forEach(([status, statusQuantity]) => {
      group.statusCounts[status] = (group.statusCounts[status] || 0) + statusQuantity;
    });
  });

  return Array.from(groups.values()).sort((a, b) => {
    const aKey = `${a.departmentLabel} ${a.brand} ${a.model}`.toLowerCase();
    const bKey = `${b.departmentLabel} ${b.brand} ${b.model}`.toLowerCase();
    return aKey.localeCompare(bKey, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function inventoryStatusSummaryText(statusCounts) {
  return Object.entries(statusCounts || {})
    .sort(([a], [b]) => inventoryStatusText(a).localeCompare(inventoryStatusText(b)))
    .map(([status, count]) => `${inventoryStatusText(status)}: ${count}`)
    .join(', ');
}

function inventoryStatusSummaryPdfHtml(statusCounts) {
  const entries = Object.entries(statusCounts || {})
    .sort(([a], [b]) => inventoryStatusText(a).localeCompare(inventoryStatusText(b)));
  return entries.length
    ? entries.map(([status, count]) => inventoryStatusPdfBadgeHtml(status, `${inventoryStatusText(status)}: ${count}`)).join('')
    : '-';
}

function inventoryGroupedRowRecords(filteredAssets, filters) {
  const groups = groupInventoryAssetsForExport(filteredAssets, filters);
  if (groups.length === 0) {
    return [{ html: '<tr><td colspan="6" class="empty-row">No assets match the selected filters.</td></tr>', height: 0 }];
  }

  return groups.map(group => {
    const descriptionText = Array.from(group.descriptions).sort((a, b) => a.localeCompare(b)).join('; ');
    return {
      html: `
      <tr>
        <td>${inventoryDepartmentPdfBadgeHtml(group.department)}</td>
        <td>${escapeHtml(group.brand)}</td>
        <td>${escapeHtml(group.model)}</td>
        <td>${escapeHtml(descriptionText || '-')}</td>
        <td class="number-cell">${escapeHtml(String(group.count))}</td>
        <td>${inventoryStatusSummaryPdfHtml(group.statusCounts)}</td>
      </tr>
      `,
      height: 0
    };
  });
}

function inventoryGroupedRowsHtml(filteredAssets, filters) {
  return inventoryGroupedRowRecords(filteredAssets, filters).map(record => record.html).join('');
}

function inventoryIndividualRowRecords(filteredAssets) {
  if (filteredAssets.length === 0) {
    return [{ html: '<tr><td colspan="11" class="empty-row">No assets match the selected filters.</td></tr>', height: 0 }];
  }

  return filteredAssets.map(asset => {
    const assetId = asset.isBulk
      ? inventoryPlainText(asset.internalId || asset.bulkId, 'Bulk Item')
      : inventoryPlainText(asset.id || asset.internalId);
    const currentLocation = inventoryPlainText(asset.currentLocation || asset.location || asset.defaultLocation || 'Store');
    const defaultLocation = inventoryPlainText(asset.defaultLocation || 'Store');

    return {
      html: `
      <tr>
        <td><strong>${escapeHtml(assetId)}</strong></td>
        <td>${escapeHtml(inventoryPlainText(asset.brand))}</td>
        <td>${escapeHtml(inventoryPlainText(asset.model))}</td>
        <td>${escapeHtml(inventoryPlainText(asset.description))}</td>
        <td>${escapeHtml(asset.isBulk ? '-' : inventoryPlainText(asset.serial))}</td>
        <td class="number-cell">${escapeHtml(inventoryAssetQuantityText(asset))}</td>
        <td>${inventoryDepartmentPdfBadgeHtml(asset.department)}</td>
        <td>${inventoryStatusSummaryPdfHtml(inventoryExportStatusCounts(asset))}</td>
        <td>${escapeHtml(defaultLocation)}</td>
        <td>${escapeHtml(currentLocation)}</td>
        <td>${inventoryAssetFlagsPdfHtml(asset)}</td>
      </tr>
      `,
      height: 0
    };
  });
}

function inventoryIndividualRowsHtml(filteredAssets) {
  return inventoryIndividualRowRecords(filteredAssets).map(record => record.html).join('');
}

function inventoryPdfPageConfig(showIndividual) {
  return showIndividual
    ? {
        orientation: 'landscape',
        widthMm: 297,
        heightMm: 210,
        measureWidthMm: 283,
        pageFlowHeightMm: 189,
        minFooterReserveMm: 6,
        pagePaddingTopMm: 7,
        footerBottomMm: 7,
        footerGapMm: 2,
        bodyFontSize: '7.2pt',
        tableFontSize: '6.8pt',
        tablePadding: '4px'
      }
    : {
        orientation: 'portrait',
        widthMm: 210,
        heightMm: 297,
        measureWidthMm: 196,
        pageFlowHeightMm: 276,
        minFooterReserveMm: 6,
        pagePaddingTopMm: 7,
        footerBottomMm: 7,
        footerGapMm: 2,
        bodyFontSize: '8.4pt',
        tableFontSize: '8pt',
        tablePadding: '5px'
      };
}

function inventoryPdfColGroup(showIndividual) {
  if (showIndividual) {
    return `
      <col style="width:9%;">
      <col style="width:9%;">
      <col style="width:10%;">
      <col style="width:20%;">
      <col style="width:9%;">
      <col style="width:4%;">
      <col style="width:10%;">
      <col style="width:7%;">
      <col style="width:8%;">
      <col style="width:8%;">
      <col style="width:6%;">
    `;
  }

  return `
    <col style="width:16%;">
    <col style="width:17%;">
    <col style="width:17%;">
    <col style="width:26%;">
    <col style="width:7%;">
    <col style="width:17%;">
  `;
}

function inventoryPdfTableHead(showIndividual) {
  if (showIndividual) {
    return `
      ${inventoryPdfColGroup(true)}
      <thead>
        <tr>
          <th>Asset ID</th>
          <th>Brand</th>
          <th>Model</th>
          <th>Description</th>
          <th>Serial</th>
          <th>Qty</th>
          <th>Department</th>
          <th>Status</th>
          <th>Default Location</th>
          <th>Current Location</th>
          <th>Flags</th>
        </tr>
      </thead>
    `;
  }

  return `
    ${inventoryPdfColGroup(false)}
    <thead>
      <tr>
        <th>Department</th>
        <th>Brand</th>
        <th>Model</th>
        <th>Description</th>
        <th>Count</th>
        <th>Status Counts</th>
      </tr>
    </thead>
  `;
}

function inventoryPdfTableHtml(filteredAssets, filters, showIndividual) {
  if (showIndividual) {
    return `
      <table class="inventory-table detail-table">
        ${inventoryPdfTableHead(true)}
        <tbody>${inventoryIndividualRowsHtml(filteredAssets)}</tbody>
      </table>
    `;
  }

  return `
    <table class="inventory-table grouped-table">
      ${inventoryPdfTableHead(false)}
      <tbody>${inventoryGroupedRowsHtml(filteredAssets, filters)}</tbody>
    </table>
  `;
}

function buildInventoryPdfPages(filteredAssets, filters, context) {
  const safe = value => escapeHtml(String(value ?? ''));
  const logoRowHtml = renderPdfLogoRowHtml();
  const footerHtml = renderPdfFooterHtml();
  const showIndividual = !!context.showIndividual;
  const pageConfig = inventoryPdfPageConfig(showIndividual);

  const headerHtml = `
    ${logoRowHtml}
    <div class="header">
      <div class="header-left">
        FILTERS:<br>
        ${context.filterSummary.map(safe).join('<br>')}
      </div>
      <div class="header-right">
        <div class="report-title">${safe(context.reportTitle)}</div>
        Generated by: ${safe(context.generatedBy)}<br>
        Generated on: ${safe(context.generatedAt)}
      </div>
    </div>
  `;

  const rowRecords = showIndividual
    ? inventoryIndividualRowRecords(filteredAssets)
    : inventoryGroupedRowRecords(filteredAssets, filters);

  const measureBox = document.createElement('div');
  measureBox.id = '__inventoryMeasureBox';
  measureBox.style.cssText = `
    position:absolute;
    left:-10000px;
    top:0;
    visibility:hidden;
    width:${pageConfig.measureWidthMm}mm;
    font-family:'Century Gothic', Arial, sans-serif;
    font-size:${pageConfig.bodyFontSize};
    line-height:1.25;
    background:white;
    z-index:-1;
  `;

  measureBox.innerHTML = `
    <style>
      #__inventoryMeasureBox * { box-sizing:border-box; }
      #__inventoryMeasureBox .logo-row { display:flex; justify-content:flex-end; margin-bottom:7px; height:39px; }
      #__inventoryMeasureBox .logo-row img { height:39px; width:auto; object-fit:contain; }
      #__inventoryMeasureBox .header { display:flex; justify-content:space-between; align-items:flex-start; gap:20px; margin-bottom:18px; }
      #__inventoryMeasureBox .header-left { flex:1; font-size:8.5pt; font-weight:bold; line-height:1.35; }
      #__inventoryMeasureBox .header-right { text-align:right; font-size:8.5pt; font-weight:bold; line-height:1.35; min-width:180px; }
      #__inventoryMeasureBox .report-title { font-size:14pt; font-weight:bold; margin-bottom:5px; }
      #__inventoryMeasureBox .inventory-table { width:100%; border-collapse:collapse; border:2px solid black; table-layout:fixed; margin-bottom:0; }
      #__inventoryMeasureBox .inventory-table th { background:#333; color:white; padding:${pageConfig.tablePadding}; text-align:left; font-size:${pageConfig.tableFontSize}; border:1px solid #333; }
      #__inventoryMeasureBox .inventory-table td { border:1px solid #333; padding:${pageConfig.tablePadding}; font-size:${pageConfig.tableFontSize}; vertical-align:top; line-height:1.25; word-break:break-word; overflow-wrap:anywhere; }
      #__inventoryMeasureBox .inventory-table td > span { max-width:100%; white-space:normal !important; overflow-wrap:anywhere; }
      #__inventoryMeasureBox .number-cell { text-align:center; white-space:nowrap; }
      #__inventoryMeasureBox .empty-row { text-align:center; color:#666; padding:18px; }
      #__inventoryMeasureBox .footer-measure { width:100%; text-align:center; font-size:7pt; font-weight:bold; line-height:1.2; overflow-wrap:anywhere; }
    </style>
    <div id="__inventoryBase">
      ${headerHtml}
      <table class="inventory-table">${inventoryPdfTableHead(showIndividual)}</table>
    </div>
    <table class="inventory-table">
      ${inventoryPdfColGroup(showIndividual)}
      <tbody id="__inventoryMeasureBody"></tbody>
    </table>
    <div id="__inventoryFooterMeasure" class="footer-measure">${footerHtml}</div>
  `;

  const normaliseMeasuredHeight = mountPdfMeasureBox(measureBox, pageConfig.measureWidthMm);

  const measureBody = measureBox.querySelector('#__inventoryMeasureBody');
  const baseHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__inventoryBase').getBoundingClientRect().height
  );
  const footerHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__inventoryFooterMeasure')?.getBoundingClientRect().height || 0
  );
  const footerReserveMm = pdfFooterReserveMm({
    pageHeightMm: pageConfig.heightMm,
    pageFlowHeightMm: pageConfig.pageFlowHeightMm,
    topPaddingMm: pageConfig.pagePaddingTopMm,
    footerBottomMm: pageConfig.footerBottomMm,
    footerGapMm: pageConfig.footerGapMm,
    minReserveMm: pageConfig.minFooterReserveMm
  }, footerHeight);
  const rowBudget = Math.max(36, pdfMmToPx(pageConfig.pageFlowHeightMm - footerReserveMm) - baseHeight);

  function measureRow(rowHtml) {
    measureBody.innerHTML = rowHtml;
    const row = measureBody.querySelector('tr');
    return row ? normaliseMeasuredHeight(row.getBoundingClientRect().height) : 0;
  }

  rowRecords.forEach(record => {
    record.height = measureRow(record.html);
  });

  measureBox.remove();

  const pages = [];
  let index = 0;
  while (index < rowRecords.length) {
    const pageRows = [];
    let pageHeight = 0;

    while (index < rowRecords.length) {
      const record = rowRecords[index];
      if (pageRows.length > 0 && pageHeight + record.height > rowBudget) break;

      pageRows.push(record);
      pageHeight += record.height;
      index++;

      if (pageRows.length === 1 && record.height > rowBudget) break;
    }

    pages.push(pageRows);
  }

  const totalPages = pages.length;
  return pages.map((pageRows, pageIndex) => `
    <div class="page">
      ${headerHtml}
      <table class="inventory-table ${showIndividual ? 'detail-table' : 'grouped-table'}">
        ${inventoryPdfTableHead(showIndividual)}
        <tbody>${pageRows.map(row => row.html).join('')}</tbody>
      </table>
      <div class="footer">${footerHtml}</div>
      <div class="page-number">Page ${pageIndex + 1} of ${totalPages}</div>
    </div>
  `).join('');
}

async function generateInventoryPdf() {
  let win = null;

  try {
    if (!isAdminUser()) {
      showNotification('error', 'Admin privileges required');
      return;
    }

    const { filteredAssets, filters } = getFilteredInventoryData();
    if (filteredAssets.length === 0) {
      showNotification('warning', 'No assets match the selected filters');
      return;
    }

    win = window.open('', '_blank', 'width=1000,height=1000');
    if (!win) {
      showNotification('error', 'Pop-up blocked. Please allow pop-ups to export the inventory PDF.');
      return;
    }

    win.document.write(`<!DOCTYPE html><html><head><title>Preparing Inventory PDF</title></head><body style="font-family:Arial,sans-serif;padding:24px;">Preparing inventory PDF...</body></html>`);
    win.document.close();

    await loadPdfSettings(true);

    const showIndividual = document.getElementById('inventory-export-individual')?.checked || false;
    const filterSummary = inventoryFilterSummary(filters, filteredAssets.length);
    const reportTitle = showIndividual ? 'INVENTORY DETAIL REPORT' : 'INVENTORY SUMMARY REPORT';
    const pageConfig = inventoryPdfPageConfig(showIndividual);
    const pagesHtml = buildInventoryPdfPages(filteredAssets, filters, {
      showIndividual,
      generatedBy: currentUserPdfDisplayName(),
      generatedAt: reportGeneratedAt(),
      filterSummary,
      reportTitle,
    });

    const html = `<!DOCTYPE html><html><head><title>${reportTitle}</title><style>
      @page { size: A4 ${pageConfig.orientation}; margin: 0; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: 'Century Gothic', Arial, sans-serif; color: #000; background: #f0f0f0; font-size: ${pageConfig.bodyFontSize}; line-height: 1.25; }
      .page { width: ${pageConfig.widthMm}mm; height: ${pageConfig.heightMm}mm; min-height: ${pageConfig.heightMm}mm; margin: 0 auto 12px auto; padding: 7mm 7mm 14mm 7mm; background: white; position: relative; overflow: hidden; page-break-after: always; break-after: page; }
      .page:last-child { page-break-after: auto; break-after: auto; }
      .print-btn { position: fixed; top: 20px; right: 20px; background: #667eea; color: #fff; border: none; padding: 10px 18px; border-radius: 6px; cursor: pointer; z-index: 999; font-size: 12px; }
      .logo-row { display: flex; justify-content: flex-end; margin-bottom: 7px; height: 39px; }
      .logo-row img { height: 39px; width: auto; object-fit: contain; }
      .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 18px; }
      .header-left { flex: 1; font-size: 8.5pt; font-weight: bold; line-height: 1.35; }
      .header-right { text-align: right; font-size: 8.5pt; font-weight: bold; line-height: 1.35; min-width: 180px; }
      .report-title { font-size: 14pt; font-weight: bold; margin-bottom: 5px; }
      .inventory-table { width: 100%; border-collapse: collapse; border: 2px solid black; table-layout: fixed; margin-bottom: 0; }
      .inventory-table thead { display: table-header-group; }
      .inventory-table tr { break-inside: avoid; page-break-inside: avoid; }
      .inventory-table th { background: #333; color: #fff; padding: ${pageConfig.tablePadding}; text-align: left; border: 1px solid #333; font-size: ${pageConfig.tableFontSize}; }
      .inventory-table td { border: 1px solid #333; padding: ${pageConfig.tablePadding}; font-size: ${pageConfig.tableFontSize}; vertical-align: top; line-height: 1.25; word-break: break-word; overflow-wrap: anywhere; }
      .inventory-table td > span { max-width: 100%; white-space: normal !important; overflow-wrap: anywhere; }
      .number-cell { text-align: center; white-space: nowrap; }
      .empty-row { text-align: center; color: #666; padding: 18px; }
      .footer { position: absolute; bottom: 7mm; left: 7mm; right: 7mm; text-align: center; font-size: 7pt; font-weight: bold; line-height: 1.2; overflow-wrap: anywhere; }
      .page-number { position: absolute; bottom: 3mm; right: 7mm; font-size: 7pt; }
      @media print {
        body, body * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        body { background: #fff; }
        .page { margin: 0; page-break-after: always; break-after: page; }
        .page:last-child { page-break-after: auto; break-after: auto; }
        .print-btn { display: none; }
      }
    </style></head><body>
      <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
      ${pagesHtml}
    </body></html>`;

    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    showNotification('success', 'Inventory PDF generated successfully');
  } catch (error) {
    console.error('Inventory PDF export failed:', error);
    if (win && !win.closed) {
      win.document.open();
      win.document.write(`<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:24px;">Failed to generate inventory PDF: ${escapeHtml(error.message)}</body></html>`);
      win.document.close();
    }
    showNotification('error', `Failed to generate inventory PDF: ${error.message}`);
  }
}
