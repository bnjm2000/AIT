// Packing list workspace and PDF generation.

function packingListQuantity(value) {
  const quantity = Number(value || 0);
  return Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
}

function packingListAssetQuantity(asset) {
  return Math.max(1, packingListQuantity(asset?.quantity || 1));
}

function packingListExtraPreparedQuantity(group) {
  if (!group) return 0;
  if (typeof group.extraPreparedEverQuantity !== 'undefined') {
    return packingListQuantity(group.extraPreparedEverQuantity);
  }
  const required = packingListQuantity(group.requiredQuantity);
  const preparedEver = packingListQuantity(
    typeof group.preparedEverQuantity !== 'undefined'
      ? group.preparedEverQuantity
      : group.assignedQuantity
  );
  const countablePreparedEver = packingListQuantity(
    group.countablePreparedEverQuantity
  );
  const credited = required > 0
    ? Math.min(required, countablePreparedEver)
    : 0;
  return Math.max(
    packingListQuantity(group.extraPreparedQuantity),
    preparedEver - credited,
    0
  );
}

function packingListExtraPreparedTotal(event, modelGroups, extras, useEventTotal = false) {
  if (useEventTotal && typeof event?.totalExtraPrepared !== 'undefined') {
    return packingListQuantity(event.totalExtraPrepared);
  }
  const groups = modelGroups || [];
  const groupedExtraIds = new Set(groups.flatMap(group => (
    (group.assignedAssets || [])
      .filter(asset => asset?.isExtra && asset?.id)
      .map(asset => String(asset.id))
  )));
  const groupedTotal = groups.reduce(
    (sum, group) => sum + packingListExtraPreparedQuantity(group),
    0
  );
  const standaloneTotal = (extras || []).reduce((sum, asset) => (
    groupedExtraIds.has(String(asset?.id || ''))
      ? sum
      : sum + packingListAssetQuantity(asset)
  ), 0);
  return groupedTotal + standaloneTotal;
}

function packingListDateRange(event) {
  if (!event?.startDate) return '-';
  return event.startDate === event.endDate
    ? formatDate(event.startDate)
    : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;
}

function packingListAssetStatus(asset, event) {
  const id = String(asset?.id || '');
  if (asset?.status === 'returned' || (event?.returnedItems || []).includes(id)) return 'returned';
  if (asset?.status === 'prepared' || (event?.actuallyPrepared || []).includes(id)) return 'packed';
  if (
    asset?.status === 'collected' ||
    asset?.isCollected ||
    (event?.customCollected || []).includes(id)
  ) return 'collected';
  return 'pending';
}

function packingListAssetRecord(asset, event, department = 'UN') {
  const custom = parseCustomAsset(asset?.id, asset);
  const quantity = custom
    ? Math.max(1, Number(custom.quantity || 1))
    : packingListAssetQuantity(asset);
  const status = packingListAssetStatus(asset, event);

  return {
    id: String(asset?.id || ''),
    label: custom
      ? customAssetDisplayName(custom, false)
      : String(asset?.displayId || asset?.bulkId || asset?.id || asset?.name || 'Asset'),
    company: custom ? customAssetDetailText(custom) : '',
    quantity,
    status,
    department: normalizeDepartmentCode(custom?.department || department || 'UN'),
    isBulk: !!asset?.isBulk,
    isExtra: !!asset?.isExtra
  };
}

function packingListAssetsById(event) {
  const assetsById = new Map();
  Object.entries(event?.assetsByDepartment || {}).forEach(([department, assets]) => {
    (assets || []).forEach(asset => {
      const record = packingListAssetRecord(asset, event, department);
      if (record.id) assetsById.set(record.id, record);
    });
  });
  return assetsById;
}

function packingListRowState(row) {
  if (row.required > 0 && row.packed >= row.required) return 'packed';
  if (row.packed > 0) return 'partial';
  if (row.required > 0 && row.returned >= row.required) return 'returned';
  if (row.assets.some(asset => asset.status === 'collected')) return 'collected';
  return 'pending';
}

function buildPackingListSnapshot(event) {
  const rows = [];
  const extras = new Map();
  const assetsById = packingListAssetsById(event);

  Object.entries(event?.assetsByDepartment || {}).forEach(([department, departmentAssets]) => {
    (departmentAssets || []).forEach(asset => {
      const record = packingListAssetRecord(asset, event, department);
      if (record.isExtra && record.id) extras.set(record.id, record);
    });
  });

  const allModelGroups = Object.values(event?.modelGroups || {});
  const modelGroups = allModelGroups
    .filter(group => packingListQuantity(group.requiredQuantity) > 0)
    .sort((a, b) => {
      const deptCompare = inventoryDepartmentLabel(a.department).localeCompare(
        inventoryDepartmentLabel(b.department),
        undefined,
        { numeric: true, sensitivity: 'base' }
      );
      return deptCompare || modelGroupSortName(a).localeCompare(
        modelGroupSortName(b),
        undefined,
        { numeric: true, sensitivity: 'base' }
      );
    });

  modelGroups.forEach(group => {
    const required = packingListQuantity(group.requiredQuantity);
    const assignedAssets = (group.assignedAssets || [])
      .map(asset => packingListAssetRecord(asset, event, group.department))
      .filter(asset => {
        if (asset.isExtra) {
          if (asset.id) extras.set(asset.id, asset);
          return false;
        }
        return true;
      });
    const packed = Math.min(
      required,
      typeof group.countablePreparedQuantity !== 'undefined'
        ? packingListQuantity(group.countablePreparedQuantity)
        : assignedAssets
            .filter(asset => asset.status === 'packed')
            .reduce((sum, asset) => sum + asset.quantity, 0)
    );
    const returned = Math.min(
      required,
      typeof group.countableReturnedQuantity !== 'undefined'
        ? packingListQuantity(group.countableReturnedQuantity)
        : assignedAssets
            .filter(asset => asset.status === 'returned')
            .reduce((sum, asset) => sum + asset.quantity, 0)
    );
    const row = {
      department: normalizeDepartmentCode(group.department || 'UN'),
      description: [group.brand, group.model].filter(Boolean).join(' ') || 'Unspecified item',
      detail: String(group.description || ''),
      required,
      packed,
      returned,
      extraPrepared: packingListExtraPreparedQuantity(group),
      pending: Math.max(0, required - packed - returned),
      assets: assignedAssets
    };
    row.state = packingListRowState(row);
    rows.push(row);
  });

  const customRows = new Map();
  (event?.preparedItems || []).forEach(marker => {
    const custom = parseCustomAsset(marker);
    if (!custom) return;

    const asset = assetsById.get(marker) || packingListAssetRecord({
      id: marker,
      isCustom: true,
      customType: custom.type,
      model: custom.name,
      quantity: custom.quantity,
      department: custom.department,
      company: custom.company,
      customDescription: custom.description,
      status: (event?.returnedItems || []).includes(marker)
        ? 'returned'
        : ((event?.actuallyPrepared || []).includes(marker) ? 'prepared' : 'assigned'),
      isCollected: (event?.customCollected || []).includes(marker),
      isExtra: (event?.extraAssets || []).includes(marker)
    }, event, custom.department);

    if (asset.isExtra) {
      if (asset.id) extras.set(asset.id, asset);
      return;
    }

    const key = JSON.stringify([
      asset.department,
      custom.type,
      custom.name,
      custom.company,
      custom.description
    ]);
    if (!customRows.has(key)) {
      customRows.set(key, {
        department: asset.department,
        description: custom.name || (custom.type === 'LOAN' ? 'Loan/Rental Item' : 'Misc Item'),
        detail: [
          custom.type === 'LOAN' ? 'Loan/Rental' : 'Miscellaneous',
          customAssetDetailText(custom)
        ].filter(Boolean).join(' - '),
        required: 0,
        packed: 0,
        returned: 0,
        pending: 0,
        assets: []
      });
    }

    const row = customRows.get(key);
    row.required += asset.quantity;
    if (asset.status === 'packed') row.packed += asset.quantity;
    else if (asset.status === 'returned') row.returned += asset.quantity;
    row.assets.push(asset);
  });

  customRows.forEach(row => {
    row.pending = Math.max(0, row.required - row.packed - row.returned);
    row.state = packingListRowState(row);
    rows.push(row);
  });

  // Legacy/direct events have no model requirements. Group their specifically
  // assigned physical assets by model so the checklist remains compact.
  if (modelGroups.length === 0) {
    const directRows = new Map();
    Object.entries(event?.assetsByDepartment || {}).forEach(([department, departmentAssets]) => {
      (departmentAssets || []).forEach(asset => {
        if (parseCustomAsset(asset?.id, asset)) return;
        const record = packingListAssetRecord(asset, event, department);
        if (record.isExtra) {
          if (record.id) extras.set(record.id, record);
          return;
        }

        const key = JSON.stringify([
          record.department,
          asset?.brand || '',
          asset?.model || '',
          asset?.description || asset?.name || ''
        ]);
        if (!directRows.has(key)) {
          directRows.set(key, {
            department: record.department,
            description: [asset?.brand, asset?.model].filter(Boolean).join(' ') || record.label,
            detail: String(asset?.description || ''),
            required: 0,
            packed: 0,
            returned: 0,
            pending: 0,
            assets: []
          });
        }

        const row = directRows.get(key);
        row.required += record.quantity;
        if (record.status === 'packed') row.packed += record.quantity;
        else if (record.status === 'returned') row.returned += record.quantity;
        row.assets.push(record);
      });
    });

    directRows.forEach(row => {
      row.pending = Math.max(0, row.required - row.packed - row.returned);
      row.state = packingListRowState(row);
      rows.push(row);
    });
  }

  // Some extras only appear inside model groups (including orphan 0-required
  // groups), so collect those after the required rows have been built.
  Object.values(event?.modelGroups || {}).forEach(group => {
    (group.assignedAssets || []).forEach(asset => {
      if (!asset?.isExtra) return;
      const record = packingListAssetRecord(asset, event, group.department);
      if (record.id) extras.set(record.id, record);
    });
  });

  rows.sort((a, b) => {
    const deptCompare = inventoryDepartmentLabel(a.department).localeCompare(
      inventoryDepartmentLabel(b.department),
      undefined,
      { numeric: true, sensitivity: 'base' }
    );
    return deptCompare || a.description.localeCompare(
      b.description,
      undefined,
      { numeric: true, sensitivity: 'base' }
    );
  });

  const required = packingListQuantity(event?.totalAssets);
  const prepared = packingListQuantity(event?.totalPrepared);
  const returned = packingListQuantity(event?.totalReturned);
  const packed = rows.reduce((sum, row) => sum + packingListQuantity(row.packed), 0);
  const extraRecords = Array.from(extras.values()).sort((a, b) => {
    const deptCompare = inventoryDepartmentLabel(a.department).localeCompare(
      inventoryDepartmentLabel(b.department),
      undefined,
      { numeric: true, sensitivity: 'base' }
    );
    return deptCompare || a.label.localeCompare(b.label, undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  });

  return {
    rows,
    extras: extraRecords,
    totals: {
      required,
      prepared,
      packed,
      pending: Math.max(0, required - prepared),
      returned,
      extras: packingListExtraPreparedTotal(
        event,
        allModelGroups,
        extraRecords,
        true
      )
    }
  };
}

function packingListSubprojectAssetRecord(reference, item, event, assetsById) {
  const id = String(reference || '');
  const existing = assetsById.get(id);
  if (existing) return { ...existing };
  return packingListAssetRecord({
    id,
    brand: item?.brand || '',
    model: item?.model || '',
    description: item?.description || '',
    department: item?.departmentCode || item?.department || 'UN',
    quantity: 1,
    status: (event?.returnedItems || []).includes(id)
      ? 'returned'
      : ((event?.actuallyPrepared || []).includes(id) ? 'prepared' : 'assigned'),
    isCollected: (event?.customCollected || []).includes(id),
    isExtra: (event?.extraAssets || []).includes(id)
  }, event, item?.departmentCode || item?.department || 'UN');
}

function buildPackingListSubprojectSnapshot(event, subproject, extraReferences = null) {
  const rows = [];
  const assetsById = packingListAssetsById(event);
  const scopedModelGroups = eventSubprojectModelGroups(event, {
    activeSubprojectId: String(subproject?.id || '')
  });
  const extraPreparedByGroup = new Map(scopedModelGroups.map(group => [
    eventSubprojectGroupKey(group),
    packingListExtraPreparedQuantity(group)
  ]));
  const items = (subproject?.items || []).filter(item => (
    item && packingListQuantity(item.quantity) > 0
  ));

  items.forEach(item => {
    const department = normalizeDepartmentCode(
      item.departmentCode || item.department || 'UN'
    );
    const references = [...new Set((item.assetRefs || []).map(String).filter(Boolean))];
    const assignedAssets = references.map(reference => (
      packingListSubprojectAssetRecord(reference, item, event, assetsById)
    )).filter(asset => !asset.isExtra);
    const custom = references.map(reference => parseCustomAsset(reference)).find(Boolean);
    const required = packingListQuantity(item.quantity);
    const groupKey = eventSubprojectGroupKey(item);
    const extraPrepared = custom
      ? 0
      : packingListQuantity(extraPreparedByGroup.get(groupKey));
    extraPreparedByGroup.set(groupKey, 0);
    const packed = Math.min(required, assignedAssets
      .filter(asset => asset.status === 'packed')
      .reduce((sum, asset) => sum + asset.quantity, 0));
    const returned = Math.min(required, assignedAssets
      .filter(asset => asset.status === 'returned')
      .reduce((sum, asset) => sum + asset.quantity, 0));
    const row = {
      department,
      description: custom?.name
        || [item.brand, item.model].filter(Boolean).join(' ')
        || String(item.description || 'Unspecified item'),
      detail: custom
        ? [
            custom.type === 'LOAN' ? 'Loan/Rental' : 'Miscellaneous',
            customAssetDetailText(custom)
          ].filter(Boolean).join(' - ')
        : String(item.description || ''),
      required,
      packed,
      returned,
      extraPrepared,
      pending: Math.max(0, required - packed - returned),
      assets: assignedAssets
    };
    row.state = packingListRowState(row);
    rows.push(row);
  });

  rows.sort((a, b) => {
    const deptCompare = inventoryDepartmentLabel(a.department).localeCompare(
      inventoryDepartmentLabel(b.department), undefined,
      { numeric: true, sensitivity: 'base' }
    );
    return deptCompare || a.description.localeCompare(
      b.description, undefined, { numeric: true, sensitivity: 'base' }
    );
  });

  const extraRefs = extraReferences === null
    ? (subproject?.extraRefs || [])
    : extraReferences;
  const extras = [...new Set((extraRefs || []).map(String).filter(Boolean))]
    .map(reference => packingListSubprojectAssetRecord(
      reference, null, event, assetsById
    ))
    .sort((a, b) => {
      const deptCompare = inventoryDepartmentLabel(a.department).localeCompare(
        inventoryDepartmentLabel(b.department), undefined,
        { numeric: true, sensitivity: 'base' }
      );
      return deptCompare || a.label.localeCompare(
        b.label, undefined, { numeric: true, sensitivity: 'base' }
      );
    });
  const totals = rows.reduce((result, row) => ({
    required: result.required + row.required,
    prepared: result.prepared + row.packed + row.returned,
    packed: result.packed + row.packed,
    pending: result.pending + row.pending,
    returned: result.returned + row.returned,
    extras: result.extras
  }), { required: 0, prepared: 0, packed: 0, pending: 0, returned: 0, extras: 0 });
  totals.extras = packingListExtraPreparedTotal(
    event,
    scopedModelGroups,
    extras
  );

  return { rows, extras, totals };
}

function buildPackingListPdfSections(event) {
  const subprojects = (event?.subprojects || []).filter(row => (
    row && String(row.id || '').trim()
  ));
  if (subprojects.length <= 1) {
    return [{
      id: subprojects[0]?.id || '',
      name: '',
      snapshot: buildPackingListSnapshot(event)
    }];
  }

  const listedExtraRefs = new Set(subprojects.flatMap(
    subproject => (subproject.extraRefs || []).map(String)
  ));
  const unallocatedExtras = (event?.extraAssets || [])
    .map(String)
    .filter(reference => reference && !listedExtraRefs.has(reference));

  return subprojects.map((subproject, index) => ({
    id: String(subproject.id || ''),
    name: String(subproject.name || `Sub-project ${index + 1}`),
    snapshot: buildPackingListSubprojectSnapshot(
      event,
      subproject,
      index === 0
        ? [...(subproject.extraRefs || []), ...unallocatedExtras]
        : (subproject.extraRefs || [])
    )
  }));
}

function packingListStatusBadge(status) {
  const palette = {
    packed: ['PACKED', '#dcfce7', '#14532d'],
    partial: ['PARTIAL', '#fef3c7', '#78350f'],
    pending: ['PENDING', '#fee2e2', '#7f1d1d'],
    returned: ['RETURNED', '#e5e7eb', '#374151'],
    collected: ['COLLECTED', '#dbeafe', '#1e3a8a']
  };
  const [label, background, colour] = palette[status] || palette.pending;
  return pdfInlineBadgeHtml(label, background, colour, {
    style: 'margin:0;white-space:nowrap;'
  });
}

function packingListAssetHtml(asset) {
  const quantity = asset.quantity > 1 ? ` x${asset.quantity}` : '';
  const company = asset.company ? ` / ${asset.company}` : '';
  return `
    <div class="asset-line">
      ${packingListStatusBadge(asset.status)}
      <span><strong>${escapeHtml(asset.label || 'Asset')}${escapeHtml(quantity)}</strong>${escapeHtml(company)}</span>
    </div>
  `;
}

function packingListTableHead() {
  return `
    <colgroup>
      <col style="width:23%;">
      <col style="width:31%;">
      <col style="width:7%;">
      <col style="width:7%;">
      <col style="width:7%;">
      <col style="width:7%;">
      <col style="width:7%;">
      <col style="width:11%;">
    </colgroup>
    <thead>
      <tr>
        <th>Item</th>
        <th>Assigned / Packed Assets</th>
        <th class="number-cell">Req.</th>
        <th class="number-cell">Packed</th>
        <th class="number-cell">Pending</th>
        <th class="number-cell">Returned</th>
        <th class="number-cell">Extra</th>
        <th>Status</th>
      </tr>
    </thead>
  `;
}

function packingListModelRowHtml(row, assetHtml, continued = false) {
  const pendingNote = row.pending > 0
    ? `<div class="pending-note">${escapeHtml(String(row.pending))} unit${row.pending === 1 ? '' : 's'} still to pack</div>`
    : '';
  const itemCell = continued
    ? `
      <strong>${escapeHtml(row.description)}</strong>
      <div class="continued-label">Continued</div>
    `
    : `
      <strong>${escapeHtml(row.description)}</strong>
      ${row.detail ? `<div class="muted">${escapeHtml(row.detail)}</div>` : ''}
    `;
  const assetCell = assetHtml || pendingNote || '<span class="muted">No asset assigned</span>';

  if (continued) {
    return `
      <tr class="continuation-row">
        <td>${itemCell}</td>
        <td>${assetCell}</td>
        <td class="number-cell">-</td>
        <td class="number-cell">-</td>
        <td class="number-cell">-</td>
        <td class="number-cell">-</td>
        <td class="number-cell">-</td>
        <td><span class="continued-label">CONTINUED</span></td>
      </tr>
    `;
  }

  return `
    <tr>
      <td>${itemCell}</td>
      <td>${assetCell}</td>
      <td class="number-cell">${row.required}</td>
      <td class="number-cell packed-number">${row.packed}</td>
      <td class="number-cell ${row.pending > 0 ? 'pending-number' : ''}">${row.pending}</td>
      <td class="number-cell">${row.returned}</td>
      <td class="number-cell">${packingListQuantity(row.extraPrepared)}</td>
      <td>${packingListStatusBadge(row.state)}</td>
    </tr>
  `;
}

function packingListExtrasRowHtml(snapshot, assetHtml, continued = false) {
  const status = snapshot.extras.some(asset => asset.status === 'packed')
    ? 'packed'
    : snapshot.extras[0]?.status;
  return `
    <tr class="${continued ? 'continuation-row' : ''}">
      <td>
        <strong>Additional assets</strong>
        ${continued ? '<div class="continued-label">Continued</div>' : ''}
      </td>
      <td colspan="6">${assetHtml}</td>
      <td>${continued ? '<span class="continued-label">CONTINUED</span>' : packingListStatusBadge(status)}</td>
    </tr>
  `;
}

function packingListRowRecords(snapshot) {
  const records = [];
  let currentDepartment = null;

  snapshot.rows.forEach(row => {
    if (row.department !== currentDepartment) {
      currentDepartment = row.department;
      records.push({
        html: `<tr class="department-row"><td colspan="8">${inventoryDepartmentLabel(currentDepartment)}</td></tr>`,
        keepWithNext: true,
        height: 0
      });
    }

    const assetParts = row.assets.map(packingListAssetHtml);
    records.push({
      html: packingListModelRowHtml(row, assetParts.join('')),
      parts: assetParts,
      renderChunk: (parts, continued) => packingListModelRowHtml(row, parts.join(''), continued),
      height: 0
    });
  });

  if (snapshot.extras.length > 0) {
    records.push({
      html: `
        <tr class="extras-row">
          <td colspan="8">EXTRAS - Not included in required or prepared totals</td>
        </tr>
      `,
      keepWithNext: true,
      height: 0
    });

    const extraParts = snapshot.extras.map(packingListAssetHtml);
    records.push({
      html: packingListExtrasRowHtml(snapshot, extraParts.join('')),
      parts: extraParts,
      renderChunk: (parts, continued) => packingListExtrasRowHtml(snapshot, parts.join(''), continued),
      height: 0
    });
  }

  if (records.length === 0) {
    records.push({
      html: '<tr><td colspan="8" class="empty-row">No items are assigned to this event.</td></tr>',
      height: 0
    });
  }

  return records;
}

function buildPackingListPdfSectionPages(event, snapshot, context) {
  const safe = value => escapeHtml(String(value ?? ''));
  const logoRowHtml = renderPdfLogoRowHtml();
  const footerHtml = renderPdfFooterHtml();
  const headerHtml = `
    ${logoRowHtml}
    <div class="header">
      <div class="header-left">
        EVENT:<br>
        <span class="event-name">#${safe(event.id)} ${safe(event.name)}</span><br>
        ${safe(packingListDateRange(event))}<br>
        Event state: ${safe(event.state || '-')}
        ${context.subprojectName ? `<br>Sub-project: <span class="subproject-name">${safe(context.subprojectName)}</span>` : ''}
      </div>
      <div class="header-right">
        <div class="report-title">PACKING LIST</div>
        Generated by: ${safe(context.generatedBy || '-')}<br>
        Generated on: ${safe(context.generatedAt)}
      </div>
    </div>
  `;
  const totals = snapshot.totals;
  const completion = totals.required > 0
    ? Math.min(100, Math.round((totals.prepared / totals.required) * 100))
    : 100;
  const summaryHtml = `
    <div class="summary-grid">
      <div class="summary-card"><span>Required</span><strong>${totals.required}</strong></div>
      <div class="summary-card packed"><span>Prepared</span><strong>${totals.prepared}</strong></div>
      <div class="summary-card pending"><span>Pending</span><strong>${totals.pending}</strong></div>
      <div class="summary-card returned"><span>Returned</span><strong>${totals.returned}</strong></div>
      <div class="summary-card extras"><span>Extras prepared</span><strong>${totals.extras}</strong></div>
      <div class="summary-card completion"><span>Prepared</span><strong>${completion}%</strong></div>
    </div>
    <div class="snapshot-note">
      Prepared includes items that have since been returned. Packed and returned remain separate in the table.
      Extras prepared are historical and do not count toward the requirement.
    </div>
  `;
  const rowRecords = packingListRowRecords(snapshot);
  const measureBox = document.createElement('div');
  measureBox.id = '__packingListMeasureBox';
  measureBox.style.cssText = `
    position:absolute;left:-10000px;top:0;visibility:hidden;width:196mm;
    font-family:${PDF_EXPORT_FONT_FAMILY};font-size:8pt;line-height:1.25;
    background:white;z-index:-1;
  `;
  measureBox.innerHTML = `
    <style>
      #__packingListMeasureBox * { box-sizing:border-box; }
      #__packingListMeasureBox .logo-row { display:flex;justify-content:flex-end;margin-bottom:7px;height:39px; }
      #__packingListMeasureBox .logo-row img { height:39px;width:auto;object-fit:contain; }
      #__packingListMeasureBox .header { display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:12px; }
      #__packingListMeasureBox .header-left,#__packingListMeasureBox .header-right { font-size:8pt;font-weight:bold;line-height:1.35; }
      #__packingListMeasureBox .header-left { flex:1; }
      #__packingListMeasureBox .header-right { min-width:190px;text-align:right; }
      #__packingListMeasureBox .event-name { font-size:10pt; }
      #__packingListMeasureBox .report-title { font-size:14pt;margin-bottom:4px; }
      #__packingListMeasureBox .summary-grid { display:grid;grid-template-columns:repeat(6,1fr);gap:5px;margin-bottom:6px; }
      #__packingListMeasureBox .summary-card { border:1px solid #cbd5e1;padding:6px;text-align:center; }
      #__packingListMeasureBox .summary-card span { display:block;font-size:6.5pt;text-transform:uppercase; }
      #__packingListMeasureBox .summary-card strong { display:block;font-size:12pt; }
      #__packingListMeasureBox .snapshot-note { padding:5px 7px;background:#f8fafc;border:1px solid #cbd5e1;font-size:7pt;margin-bottom:8px; }
      #__packingListMeasureBox .packing-table { width:100%;border-collapse:collapse;border:2px solid #111;table-layout:fixed; }
      #__packingListMeasureBox .packing-table th { padding:5px;background:#333;color:#fff;border:1px solid #333;font-size:7pt;text-align:left; }
      #__packingListMeasureBox .packing-table td { padding:5px;border:1px solid #333;font-size:7.5pt;vertical-align:top;word-break:break-word;overflow-wrap:anywhere; }
      #__packingListMeasureBox .number-cell { text-align:center; }
      #__packingListMeasureBox .asset-line { display:flex;align-items:flex-start;gap:4px;margin-bottom:3px; }
      #__packingListMeasureBox .asset-line:last-child { margin-bottom:0; }
      #__packingListMeasureBox .muted { color:#64748b;font-size:6.8pt; }
      #__packingListMeasureBox .continued-label { color:#64748b;font-size:6.5pt;font-weight:bold;text-transform:uppercase;letter-spacing:.03em; }
      #__packingListMeasureBox .continuation-row td { background:#f8fafc; }
      #__packingListMeasureBox .pending-note { color:#991b1b;font-weight:bold; }
      #__packingListMeasureBox .department-row td,#__packingListMeasureBox .extras-row td { padding:5px 7px;font-weight:bold;background:#e2e8f0; }
      #__packingListMeasureBox .footer-measure { width:100%;text-align:center;font-size:7pt;font-weight:bold;line-height:1.2;overflow-wrap:anywhere; }
    </style>
    <div id="__packingFirstBase">${headerHtml}${summaryHtml}<table class="packing-table">${packingListTableHead()}</table></div>
    <div id="__packingNextBase">${headerHtml}<table class="packing-table">${packingListTableHead()}</table></div>
    <table class="packing-table">${packingListTableHead()}<tbody id="__packingMeasureBody"></tbody></table>
    <div id="__packingFooterMeasure" class="footer-measure">${footerHtml}</div>
  `;

  const normaliseMeasuredHeight = mountPdfMeasureBox(measureBox, 196);
  const measureBody = measureBox.querySelector('#__packingMeasureBody');
  const firstBaseHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__packingFirstBase').getBoundingClientRect().height
  );
  const nextBaseHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__packingNextBase').getBoundingClientRect().height
  );
  const footerHeight = normaliseMeasuredHeight(
    measureBox.querySelector('#__packingFooterMeasure')?.getBoundingClientRect().height || 0
  );
  const footerReserveMm = pdfFooterReserveMm({ pageFlowHeightMm: 276 }, footerHeight);
  const firstBudget = Math.max(40, pdfMmToPx(276 - footerReserveMm) - firstBaseHeight);
  const nextBudget = Math.max(40, pdfMmToPx(276 - footerReserveMm) - nextBaseHeight);

  const measureRecordHtml = html => {
    measureBody.innerHTML = html;
    const row = measureBody.querySelector('tr');
    return row
      ? normaliseMeasuredHeight(row.getBoundingClientRect().height)
      : 0;
  };

  rowRecords.forEach(record => {
    record.height = measureRecordHtml(record.html);
  });

  // A model can contain dozens of individual asset IDs. A browser cannot split
  // one table row around a fixed footer, so divide only oversized asset lists
  // into measured continuation rows before assigning rows to pages.
  const keepWithNextReserve = rowRecords.reduce(
    (largest, record) => record.keepWithNext ? Math.max(largest, record.height) : largest,
    0
  );
  const splitBudget = Math.max(
    40,
    Math.min(firstBudget, nextBudget) - keepWithNextReserve
  );
  const fittedRecords = [];

  rowRecords.forEach(record => {
    if (!record.renderChunk || record.parts.length < 2 || record.height <= splitBudget) {
      fittedRecords.push(record);
      return;
    }

    let offset = 0;
    let continued = false;
    while (offset < record.parts.length) {
      let low = 1;
      let high = record.parts.length - offset;
      let fittingCount = 0;
      let fittingHtml = '';
      let fittingHeight = 0;

      while (low <= high) {
        const count = Math.floor((low + high) / 2);
        const html = record.renderChunk(
          record.parts.slice(offset, offset + count),
          continued
        );
        const height = measureRecordHtml(html);
        if (height <= splitBudget) {
          fittingCount = count;
          fittingHtml = html;
          fittingHeight = height;
          low = count + 1;
        } else {
          high = count - 1;
        }
      }

      // One unusually long asset label may itself be taller than the normal
      // budget. Keep it visible as a single row rather than dropping it.
      if (fittingCount === 0) {
        fittingCount = 1;
        fittingHtml = record.renderChunk(
          record.parts.slice(offset, offset + 1),
          continued
        );
        fittingHeight = measureRecordHtml(fittingHtml);
      }

      fittedRecords.push({
        html: fittingHtml,
        height: fittingHeight
      });
      offset += fittingCount;
      continued = true;
    }
  });
  measureBox.remove();

  const pages = [];
  let index = 0;
  while (index < fittedRecords.length) {
    const budget = pages.length === 0 ? firstBudget : nextBudget;
    const pageRows = [];
    let height = 0;

    while (index < fittedRecords.length) {
      const record = fittedRecords[index];
      const nextHeight = record.keepWithNext ? (fittedRecords[index + 1]?.height || 0) : 0;
      if (pageRows.length > 0 && height + record.height + nextHeight > budget) break;

      pageRows.push(record);
      height += record.height;
      index += 1;

      if (pageRows.length === 1 && record.height > budget) break;
    }
    pages.push(pageRows);
  }

  return pages.map((pageRows, pageIndex) => ({
    headerHtml,
    summaryHtml: pageIndex === 0 ? summaryHtml : '',
    rowsHtml: pageRows.map(record => record.html).join(''),
    footerHtml
  }));
}

function buildPackingListPdfPages(event, sections, context) {
  const normalisedSections = Array.isArray(sections)
    ? sections
    : [{ id: '', name: '', snapshot: sections }];
  const pages = normalisedSections.flatMap(section => (
    buildPackingListPdfSectionPages(event, section.snapshot, {
      ...context,
      subprojectName: section.name || ''
    })
  ));
  const totalPages = pages.length;
  return pages.map((page, pageIndex) => `
    <div class="page">
      ${page.headerHtml}
      ${page.summaryHtml}
      <table class="packing-table">
        ${packingListTableHead()}
        <tbody>${page.rowsHtml}</tbody>
      </table>
      <div class="footer">${page.footerHtml}</div>
      <div class="page-number">Page ${pageIndex + 1} of ${totalPages}</div>
    </div>
  `).join('');
}

function openPackingListPage(eventId) {
  const id = Number(eventId || 0);
  if (!id) {
    showNotification('error', 'No event selected');
    return;
  }
  const opened = window.open(`/packing-list/${id}`, '_blank');
  if (opened) opened.opener = null;
  else showNotification('error', 'Pop-up blocked. Please allow pop-ups to open the packing list.');
}

async function generatePackingList(eventId, options = {}) {
  if (!eventId) {
    showNotification('error', 'No event selected');
    return;
  }

  const packingWindow = options.targetWindow || window.open('', '_blank', 'width=950,height=1000');
  if (!packingWindow) {
    showNotification('error', 'Pop-up blocked. Please allow pop-ups to export the packing list PDF.');
    return;
  }

  if (!options.targetWindow) {
    packingWindow.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Preparing Packing List</title></head><body style="font-family:${PDF_EXPORT_FONT_FAMILY};padding:24px;">Preparing the latest packing list...</body></html>`);
    packingWindow.document.close();
  }

  try {
    const [response] = await Promise.all([
      apiCall(`/api/events/${eventId}`),
      loadPdfSettings(true)
    ]);
    await ensurePdfExportFontReady(document);
    const event = response.data;
    const sections = buildPackingListPdfSections(event);
    const now = new Date();
    const context = {
      generatedAt: now.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }),
      generatedBy: currentUserPdfDisplayName()
    };
    const pagesHtml = buildPackingListPdfPages(event, sections, context);
    const title = `Packing List - ${escapeHtml(String(event.name || `Event ${event.id}`))}`;
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title><style>
      ${PDF_EXPORT_FONT_FACE_CSS}
      @page { size:A4; margin:0; }
      * { box-sizing:border-box; }
      body { margin:0;font-family:${PDF_EXPORT_FONT_FAMILY};color:#111;background:#f0f0f0;font-size:8pt;line-height:1.25; }
      .page { width:210mm;height:297mm;min-height:297mm;margin:0 auto 12px;padding:7mm 7mm 14mm;background:#fff;position:relative;overflow:hidden;page-break-after:always;break-after:page; }
      .page:last-child { page-break-after:auto;break-after:auto; }
      .print-btn { position:fixed;top:20px;right:20px;background:#16a34a;color:#fff;border:0;padding:10px 18px;border-radius:6px;cursor:pointer;z-index:999;font-size:12px; }
      .logo-row { display:flex;justify-content:flex-end;margin-bottom:7px;height:39px; }
      .logo-row img { height:39px;width:auto;object-fit:contain; }
      .header { display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:12px; }
      .header-left,.header-right { font-size:8pt;font-weight:bold;line-height:1.35; }
      .header-left { flex:1; }
      .header-right { min-width:190px;text-align:right; }
      .event-name { font-size:10pt; }
      .subproject-name { color:#0f766e;font-size:9pt; }
      .report-title { font-size:14pt;margin-bottom:4px; }
      .summary-grid { display:grid;grid-template-columns:repeat(6,1fr);gap:5px;margin-bottom:6px; }
      .summary-card { border:1px solid #cbd5e1;padding:6px;text-align:center;background:#f8fafc; }
      .summary-card span { display:block;font-size:6.5pt;text-transform:uppercase;color:#475569; }
      .summary-card strong { display:block;font-size:12pt; }
      .summary-card.packed { background:#dcfce7; }
      .summary-card.pending { background:#fee2e2; }
      .summary-card.returned { background:#e5e7eb; }
      .summary-card.extras { background:#fef3c7; }
      .summary-card.completion { background:#dbeafe; }
      .snapshot-note { padding:5px 7px;background:#f8fafc;border:1px solid #cbd5e1;font-size:7pt;margin-bottom:8px; }
      .packing-table { width:100%;border-collapse:collapse;border:2px solid #111;table-layout:fixed; }
      .packing-table thead { display:table-header-group; }
      .packing-table tr { break-inside:avoid;page-break-inside:avoid; }
      .packing-table th { padding:5px;background:#333;color:#fff;border:1px solid #333;font-size:7pt;text-align:left; }
      .packing-table td { padding:5px;border:1px solid #333;font-size:7.5pt;vertical-align:top;word-break:break-word;overflow-wrap:anywhere; }
      .number-cell { text-align:center!important;white-space:nowrap; }
      .packed-number { color:#166534;font-weight:bold; }
      .pending-number { color:#991b1b;font-weight:bold;background:#fff7f7; }
      .asset-line { display:flex;align-items:flex-start;gap:4px;margin-bottom:3px; }
      .asset-line:last-child { margin-bottom:0; }
      .muted { color:#64748b;font-size:6.8pt; }
      .continued-label { color:#64748b;font-size:6.5pt;font-weight:bold;text-transform:uppercase;letter-spacing:.03em; }
      .continuation-row td { background:#f8fafc; }
      .pending-note { color:#991b1b;font-weight:bold; }
      .department-row td { padding:5px 7px;font-weight:bold;background:#e2e8f0;letter-spacing:.03em; }
      .extras-row td { padding:5px 7px;font-weight:bold;background:#fef3c7;color:#78350f; }
      .empty-row { text-align:center;color:#64748b;padding:18px!important; }
      .footer { position:absolute;bottom:7mm;left:7mm;right:7mm;text-align:center;font-size:7pt;font-weight:bold;line-height:1.2;overflow-wrap:anywhere; }
      .page-number { position:absolute;bottom:3mm;right:7mm;font-size:7pt; }
      @media print {
        body,body * { -webkit-print-color-adjust:exact;print-color-adjust:exact; }
        body { background:#fff; }
        .page { margin:0;page-break-after:always;break-after:page; }
        .page:last-child { page-break-after:auto;break-after:auto; }
        .print-btn { display:none; }
      }
    </style></head><body>
      <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
      ${pagesHtml}
    </body></html>`;

    packingWindow.document.open();
    packingWindow.document.write(html);
    packingWindow.document.close();
    await ensurePdfExportFontReady(packingWindow.document);
    packingWindow.focus();
    if (!options.targetWindow) {
      showNotification('success', 'Packing list PDF generated from the latest event state');
    }
  } catch (error) {
    console.error('Packing list PDF generation failed:', error);
    if (!packingWindow.closed) {
      packingWindow.document.open();
      packingWindow.document.write(`<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:24px;">Failed to generate packing list: ${escapeHtml(error.message)}</body></html>`);
      packingWindow.document.close();
    }
    showNotification('error', `Failed to generate packing list: ${error.message}`);
  }
}
