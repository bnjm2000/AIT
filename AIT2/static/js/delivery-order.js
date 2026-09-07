// Delivery Order workspace, editing, persistence, and PDF generation.

let currentDeliveryOrderEvent = null;
const deliveryOrderEditorState = {
  activeSubprojectId: '',
  dragSubprojectId: '',
  catalog: [],
  catalogMatches: [],
  selectedCatalogItem: null,
  pendingRevealKey: '',
  collapsedCategories: {}
};
let deliveryOrderSubprojectWorkspace = null;

function deliveryOrderSubprojects(event = currentDeliveryOrderEvent) {
  const source = eventSubprojects(event);
  const rows = source.length
    ? source.map(room => ({ id: String(room.id || 'main'), name: room.name || 'Main Room' }))
    : [{ id: 'main', name: 'Main Room' }];
  const eventId = event?.id || event?.event_id || '0';
  const order = getDoEdits(eventId).subprojectOrder || [];
  const positions = new Map(order.map((id, index) => [String(id), index]));
  return [...rows].sort((left, right) => {
    const leftIndex = positions.has(left.id) ? positions.get(left.id) : Number.MAX_SAFE_INTEGER;
    const rightIndex = positions.has(right.id) ? positions.get(right.id) : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

function deliveryOrderActiveSubprojectId(event = currentDeliveryOrderEvent) {
  const rows = deliveryOrderSubprojects(event);
  if (!rows.some(row => row.id === deliveryOrderEditorState.activeSubprojectId)) {
    deliveryOrderEditorState.activeSubprojectId = rows[0]?.id || 'main';
  }
  return deliveryOrderEditorState.activeSubprojectId;
}

function ensureDeliveryOrderSubprojectWorkspace() {
  if (deliveryOrderSubprojectWorkspace) return deliveryOrderSubprojectWorkspace;
  deliveryOrderSubprojectWorkspace = showbaseLineWorkspace.createSubprojectController({
    state: deliveryOrderEditorState,
    getRows: () => deliveryOrderSubprojects(),
    mimeType: 'application/x-showbase-delivery-order-room',
    commit: reordered => {
      if (!reordered || !currentDeliveryOrderEvent) return false;
      const eventId = currentDeliveryOrderEvent.id || currentDeliveryOrderEvent.event_id || '0';
      const workspace = getDoEdits(eventId);
      workspace.subprojectOrder = reordered.map(row => row.id);
      saveDoEdits(eventId, workspace, { immediate: true });
      populateDeliveryItemsPreview(currentDeliveryOrderEvent);
      return true;
    }
  });
  return deliveryOrderSubprojectWorkspace;
}

function deliveryOrderSubprojectTabsMarkup(event) {
  return showbaseLineWorkspace.subprojectTabsMarkup({
    rows: deliveryOrderSubprojects(event),
    activeId: deliveryOrderActiveSubprojectId(event),
    handlerPrefix: 'deliveryOrder',
    allowManage: false,
    ariaLabel: 'Delivery Order sub-projects',
    className: 'do-subproject-tabs'
  });
}

function deliveryOrderSelectSubproject(subprojectId) {
  if (!deliveryOrderSubprojects().some(row => row.id === subprojectId)) return;
  deliveryOrderEditorState.activeSubprojectId = subprojectId;
  populateDeliveryItemsPreview(currentDeliveryOrderEvent);
}

function deliveryOrderSubprojectDragStart(event, subprojectId) {
  ensureDeliveryOrderSubprojectWorkspace().dragStart(event, subprojectId);
}
function deliveryOrderSubprojectDragOver(event, targetId) {
  ensureDeliveryOrderSubprojectWorkspace().dragOver(event, targetId);
}
function deliveryOrderSubprojectDragLeave(event) {
  ensureDeliveryOrderSubprojectWorkspace().dragLeave(event);
}
function deliveryOrderSubprojectEndDragOver(event) {
  ensureDeliveryOrderSubprojectWorkspace().endDragOver(event);
}
function deliveryOrderSubprojectEndDragLeave(event) {
  ensureDeliveryOrderSubprojectWorkspace().endDragLeave(event);
}
function deliveryOrderSubprojectSlotDragOver(event, targetIndex) {
  ensureDeliveryOrderSubprojectWorkspace().slotDragOver(event, targetIndex);
}
function deliveryOrderSubprojectSlotDragLeave(event) {
  ensureDeliveryOrderSubprojectWorkspace().slotDragLeave(event);
}
function deliveryOrderSubprojectDropAtIndex(event, targetIndex) {
  ensureDeliveryOrderSubprojectWorkspace().dropAtIndex(event, targetIndex);
}
function deliveryOrderSubprojectDrop(event, targetId) {
  ensureDeliveryOrderSubprojectWorkspace().drop(event, targetId);
}
function deliveryOrderSubprojectDropAtEnd(event) {
  ensureDeliveryOrderSubprojectWorkspace().dropAtEnd(event);
}
function deliveryOrderSubprojectDragEnd() {
  ensureDeliveryOrderSubprojectWorkspace().dragEnd();
}
function deliveryOrderSubprojectDragKeydown(event, subprojectId) {
  ensureDeliveryOrderSubprojectWorkspace().dragKeydown(event, subprojectId);
}

async function openDeliveryOrderTab(eventId, options = {}) {
    // Use stored event data if available, otherwise fetch it
    if (window.currentEventData && window.currentEventData.id === eventId) {
        currentDeliveryOrderEvent = window.currentEventData;
        await populateDeliveryOrderForm(window.currentEventData);
        showSection('delivery-order', { updateHistory: false, loadDetail: false });
        if (options.updateHistory !== false) {
          updateAppDetailHistory(`/delivery-order/${Number(eventId)}`, options.replaceHistory === true);
        }
    } else {
        // Fallback: fetch event data
        try {
            const response = await apiCall(`/api/events/${eventId}`);
            currentDeliveryOrderEvent = response.data;
            await populateDeliveryOrderForm(response.data);
            showSection('delivery-order', { updateHistory: false, loadDetail: false });
            if (options.updateHistory !== false) {
              updateAppDetailHistory(`/delivery-order/${Number(eventId)}`, options.replaceHistory === true);
            }
        } catch (error) {
            console.error('Error fetching event data:', error);
            showNotification('error', 'Failed to load event data');
        }
    }
}

const DELIVERY_ORDER_DOCUMENT_FIELDS = [
  'doNumber', 'doDate', 'clientName', 'clientCompany', 'deliveryAddress1',
  'deliveryAddress2', 'deliveryAddress3', 'clientPhone', 'jobTitle',
  'jobLocation', 'additionalComments'
];

function deliveryOrderCaptureDocument(eventId) {
  const workspace = getDoEdits(eventId);
  const documentData = {};
  DELIVERY_ORDER_DOCUMENT_FIELDS.forEach(field => {
    documentData[field] = document.getElementById(field)?.value || '';
  });
  documentData.showAssetIds = !!document.getElementById('showAssetIds')?.checked;
  workspace.document = documentData;
  saveDoEdits(eventId, workspace);
}

function deliveryOrderBindDocumentAutosave(eventId) {
  [...DELIVERY_ORDER_DOCUMENT_FIELDS, 'showAssetIds'].forEach(field => {
    const input = document.getElementById(field);
    if (!input || input.dataset.doAutosaveBound === 'true') return;
    input.dataset.doAutosaveBound = 'true';
    input.addEventListener(field === 'showAssetIds' ? 'change' : 'input', () => {
      deliveryOrderCaptureDocument(eventId);
    });
    if (field !== 'showAssetIds') {
      input.addEventListener('change', () => {
        flushDoEdits(eventId).catch(() => {});
      });
    }
  });
}

async function populateDeliveryOrderForm(event) {
    // Auto-populate form with event data and defaults
    const doNumberEl = document.getElementById('doNumber');
    const doDateEl = document.getElementById('doDate');
    const clientNameEl = document.getElementById('clientName');
    const clientCompanyEl = document.getElementById('clientCompany');
    const deliveryAddress1El = document.getElementById('deliveryAddress1');
    const deliveryAddress2El = document.getElementById('deliveryAddress2');
    const deliveryAddress3El = document.getElementById('deliveryAddress3');
    const clientPhoneEl = document.getElementById('clientPhone');
    const jobTitleEl = document.getElementById('jobTitle');
    const jobLocationEl = document.getElementById('jobLocation');
    const additionalCommentsEl = document.getElementById('additionalComments');
    const eventContextEl = document.getElementById('doEventContext');
    const eventId = event && (event.event_id ?? event.id);
    const workspace = await loadDoEdits(eventId || '0');
    const savedDocument = workspace.document || {};
    const savedValue = (field, fallback) => (
      Object.prototype.hasOwnProperty.call(savedDocument, field)
        ? savedDocument[field]
        : fallback
    );

    if (eventContextEl) {
      eventContextEl.textContent = [eventId ? `Event #${eventId}` : '', event?.name || ''].filter(Boolean).join(' / ');
    }

    if (doNumberEl) {
      const year = new Date().getFullYear();
      const eid = (event && (event.event_id ?? event.id)) ? String(event.event_id ?? event.id).padStart(4, '0') : '0000';
      doNumberEl.value = savedValue('doNumber', `DO-${year}${eid}`);
    }

    if (doDateEl) doDateEl.value = savedValue('doDate', new Date().toISOString().split('T')[0]);
    if (clientNameEl) clientNameEl.value = savedValue('clientName', event.client_name || event.name || '');
    if (clientCompanyEl) clientCompanyEl.value = savedValue('clientCompany', event.client_company || '');
    if (deliveryAddress1El) deliveryAddress1El.value = savedValue('deliveryAddress1', event.location || event.venue || '');
    if (deliveryAddress2El) deliveryAddress2El.value = savedValue('deliveryAddress2', event.venue_address || '');
    if (deliveryAddress3El) deliveryAddress3El.value = savedValue('deliveryAddress3', event.venue_city || '');
    if (clientPhoneEl) clientPhoneEl.value = savedValue('clientPhone', event.client_phone || '');
    if (jobTitleEl) jobTitleEl.value = savedValue('jobTitle', event.name || '');
    if (jobLocationEl) jobLocationEl.value = savedValue('jobLocation', event.location || event.venue || '');
    if (additionalCommentsEl) additionalCommentsEl.value = savedValue('additionalComments', '');

    if (document.getElementById('showAssetIds')) {
      document.getElementById('showAssetIds').checked = !!savedValue('showAssetIds', false);
    }
    deliveryOrderBindDocumentAutosave(eventId || '0');

    // Populate items preview (now async)
    await populateDeliveryItemsPreview(event);
    await setupClientAutocomplete();    // NEW
    ensureKnownClientsButton();
}

async function generateDeliveryOrder() {
    if (!currentDeliveryOrderEvent) {
        showNotification('error', 'No event selected');
        return;
    }

    // Get form data
    const deliveryOrderData = {
        doNumber: document.getElementById('doNumber').value,
        doDate: document.getElementById('doDate').value,
        clientName: document.getElementById('clientName').value,
        clientCompany: document.getElementById('clientCompany').value,
        deliveryAddress1: document.getElementById('deliveryAddress1').value,
        deliveryAddress2: document.getElementById('deliveryAddress2').value,
        deliveryAddress3: document.getElementById('deliveryAddress3').value,
        clientPhone: document.getElementById('clientPhone').value,
        jobTitle: document.getElementById('jobTitle').value,
        jobLocation: document.getElementById('jobLocation').value,
        additionalComments: document.getElementById('additionalComments').value,
        showAssetIds: document.getElementById('showAssetIds').checked,
        event: currentDeliveryOrderEvent
    };

    // Validate required fields
    if (!deliveryOrderData.doNumber || !deliveryOrderData.doDate || !deliveryOrderData.clientName) {
        showNotification('error', 'Please fill in DO Number, Date, and Client Name');
        return;
    }

    const doWindow = window.open('', '_blank');
    if (!doWindow) {
        showNotification('error', 'Allow pop-ups to preview and print the Delivery Order');
        return;
    }

    // Field input handlers already autosave real edits. Exporting an unchanged
    // Delivery Order must stay read-only and must not create a new server version.
    try {
        await flushDoEdits(currentDeliveryOrderEvent.id || currentDeliveryOrderEvent.event_id || '0');
        await loadPdfSettings(true);
        await ensurePdfExportFontReady(document);

        generatePdfDO(deliveryOrderData, doWindow);
    } catch (error) {
        doWindow.close();
        showNotification('error', error.message || 'Failed to generate Delivery Order preview');
    }
}

function generatePdfDO(data, doWindow) {
    // Format the date for display
    const formattedDate = new Date(data.doDate).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
    const themeColor = deliveryOrderPdfThemeColor();

    // Create a new window for the delivery order
    // Generate pages content
    const pagesContent = generatePagesContent(data, formattedDate);

    // Get the HTML template with populated data
    const template = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Delivery Order - ${escapeHtml(data.jobTitle)}</title>
    <style>
        ${PDF_EXPORT_FONT_FACE_CSS}
        @page {
            size: A4;
            margin: 20mm;
            @top-left { content: ""; }
            @top-center { content: ""; }
            @top-right { content: ""; }
            @bottom-left { content: ""; }
            @bottom-center { content: ""; }
            @bottom-right { content: ""; }
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: ${PDF_EXPORT_FONT_FAMILY};
            font-size: 9pt;
            line-height: 1.2;
            color: black;
            background: white;
        }

        /* Delivery Order measured pagination and client-facing theme */
        body {
            margin: 0;
            padding: 0;
            background: white;
            color: #172033;
        }

        .page {
            width: 210mm;
            height: 297mm;
            min-height: 297mm;
            position: relative;
            padding: 10mm 13mm 18mm;
            overflow: hidden;
            page-break-after: always;
            break-after: page;
            background: white;
        }

        .page:last-child {
            page-break-after: auto;
            break-after: auto;
        }

        .page-break {
            display: none !important;
        }

        .page-break + .page {
            padding-top: 10mm;
        }

        .do-letterhead {
            min-height: 15mm;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 12mm;
            margin-bottom: 8mm;
        }

        .do-letterhead-brand {
            flex: 0 0 auto;
            min-width: 40mm;
        }

        .do-letterhead-brand img {
            display: block;
            width: auto;
            max-width: 42mm;
            height: auto;
            max-height: 14mm;
            object-fit: contain;
        }

        .do-wordmark {
            max-width: 75mm;
            color: #172033;
            font-size: 15pt;
            line-height: 1.05;
            font-weight: 700;
        }

        .do-letterhead-details {
            max-width: 88mm;
            color: #64748b;
            font-size: 6.5pt;
            line-height: 1.35;
            text-align: right;
        }

        .do-letterhead-details strong {
            display: block;
            margin-bottom: 1mm;
            color: #172033;
            font-size: 8.5pt;
            line-height: 1.2;
        }

        .do-title-row {
            display: flex;
            align-items: flex-end;
            justify-content: space-between;
            gap: 10mm;
            padding-bottom: 3mm;
            border-bottom: 0.6pt solid #cbd5e1;
        }

        .delivery-order-title {
            margin: 0;
            color: #172033;
            font-size: 20pt;
            line-height: 1;
            text-align: left;
        }

        .do-number {
            margin: 0;
            color: ${themeColor};
            font-size: 12pt;
            font-weight: 700;
            line-height: 1.1;
            text-align: right;
        }

        .do-recipient-panel {
            display: grid;
            grid-template-columns: minmax(0, 1.4fr) minmax(52mm, .75fr);
            margin-top: 5mm;
            border: 0.5pt solid #cbd5e1;
        }

        .do-recipient,
        .do-document-meta {
            min-height: 0;
            padding: 3.5mm 5mm;
        }

        .do-document-meta {
            border-left: 0.5pt solid #cbd5e1;
        }

        .do-label {
            display: block;
            margin-bottom: 1.2mm;
            color: #64748b;
            font-size: 7pt;
            font-weight: 700;
            text-transform: uppercase;
        }

        .do-recipient strong {
            display: block;
            margin-bottom: 0.5mm;
            color: #172033;
            font-size: 9pt;
        }

        .do-recipient-copy {
            color: #334155;
            font-size: 8pt;
            line-height: 1.4;
        }

        .do-meta-row {
            display: grid;
            grid-template-columns: 30mm minmax(0, 1fr);
            gap: 3mm;
            margin-bottom: 1mm;
            font-size: 8pt;
        }

        .do-meta-row:last-child {
            margin-bottom: 0;
        }

        .do-meta-row span {
            color: #64748b;
            font-weight: 700;
        }

        .do-meta-row strong {
            color: #172033;
            font-weight: 400;
        }

        .do-job-band {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            gap: 8mm;
            margin: 4mm 0 5mm;
            padding: 3.5mm 5mm;
            border: 0.5pt solid #cbd5e1;
            background: #f1f5f9;
            color: #334155;
            font-size: 8pt;
        }

        .do-job-band strong {
            color: #172033;
        }

        .items-table {
            width: 100%;
            table-layout: fixed;
            margin: 0;
            border: 0.5pt solid #cbd5e1;
            border-collapse: collapse;
        }

        .items-table th {
            padding: 2mm 2.7mm;
            border: 0;
            background: ${themeColor};
            color: white;
            font-size: 7pt;
            letter-spacing: 0;
        }

        .items-table th:last-child {
            border-left: 0.5pt solid rgba(255, 255, 255, 0.45);
            text-align: right;
        }

        .items-table td {
            padding: 0.9mm 2.7mm;
            border: 0;
            border-bottom: 0.35pt solid #e2e8f0;
            color: #172033;
            font-size: 8pt;
            line-height: 1.15;
        }

        .items-table td:first-child,
        .items-table td:last-child {
            border-right: 0;
            border-left: 0;
        }

        .items-table tr:last-child td {
            border-bottom: 0;
        }

        .items-table tr {
            page-break-inside: avoid;
            break-inside: avoid;
        }

        .items-table .do-pdf-group-row td {
            padding-top: 1.7mm;
            padding-bottom: 0.5mm;
            border-top: 0.55pt solid #9dc9b0;
            border-bottom: 0;
            background: #fff;
            color: #172033;
            font-size: 8pt;
            font-weight: 700;
            text-align: left;
        }

        .items-table .do-pdf-group-row .quantity-col {
            font-weight: 400;
            text-align: right;
        }

        .items-table .do-pdf-group-child-row td {
            padding-top: 0.45mm;
            padding-bottom: 0.45mm;
            border-bottom: 0;
            text-align: left;
        }

        .items-table .do-pdf-group-child-row.is-before-custom-text td {
            padding-bottom: 0;
        }

        .items-table .do-pdf-group-child-row.is-custom-text td {
            padding-top: 0;
        }

        .items-table .do-pdf-group-child-row.is-group-end td {
            padding-bottom: 1.4mm;
            border-bottom: 0.35pt solid #e2e8f0;
        }

        .do-pdf-group-child-description {
            padding-left: 2.7mm;
            text-align: left;
            white-space: normal;
        }

        .do-pdf-group-child-description.is-custom-text {
            white-space: pre-line;
        }

        .do-pdf-group-child-quantity {
            font-weight: 400;
        }

        .do-pdf-category {
            padding-top: 3mm;
        }

        .do-pdf-category.is-first {
            padding-top: 0;
        }

        .do-pdf-category-heading {
            min-height: 7mm;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 1.5mm 2.7mm;
            border: 0.5pt solid #cbd5e1;
            border-bottom: 0;
            background: #f1f5f9;
            color: #172033;
            font-size: 7.2pt;
            font-weight: 700;
            text-transform: uppercase;
        }

        .do-pdf-category-heading small {
            color: #64748b;
            font-size: 6pt;
            font-weight: 600;
        }

        .do-pdf-empty {
            padding: 8mm;
            border: 0.5pt solid #cbd5e1;
            color: #64748b;
            font-size: 8pt;
            text-align: center;
        }

        .quantity-col {
            width: 22mm;
            border-left: 0.5pt solid #cbd5e1 !important;
            text-align: right;
        }

        .quantity-column {
            width: 22mm;
        }

        .asset-id-line {
            display: block;
            margin-top: 0.5mm;
            color: #64748b;
            font-size: 6.5pt;
            font-style: normal;
        }

        .comments-section {
            position: absolute;
            left: 13mm;
            right: 13mm;
            bottom: 43mm;
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto;
            justify-content: space-between;
            align-items: start;
            gap: 10mm;
            padding-top: 3mm;
            border-top: 0.5pt solid #cbd5e1;
            margin: 0;
        }

        .other-comments,
        .received-text {
            color: #475569;
            font-size: 7.5pt;
            line-height: 1.35;
        }

        .other-comments {
            font-weight: 400;
        }

        .received-text {
            font-weight: 700;
        }

        .signature-holder {
            position: absolute;
            right: 13mm;
            bottom: 21mm;
            width: 62mm;
        }

        .signature-space {
            height: 12mm;
            border-bottom: 0.7pt solid #172033;
        }

        .signature-label {
            margin-top: 1.5mm;
            color: #475569;
            font-size: 7.5pt;
            line-height: 1.2;
            text-align: center;
        }

        .footer {
            position: absolute;
            bottom: 8mm;
            left: 13mm;
            right: 13mm;
            padding-top: 2mm;
            border-top: 0.5pt solid #cbd5e1;
            color: #64748b;
            font-family: ${PDF_EXPORT_FONT_FAMILY};
            font-size: 6.2pt;
            line-height: 1.25;
            text-align: left;
            z-index: 100;
            overflow-wrap: anywhere;
        }

        .page-number {
            position: absolute;
            bottom: 8mm;
            right: 13mm;
            margin-right: 0;
            font-family: ${PDF_EXPORT_FONT_FAMILY};
            font-size: 6.2pt;
            color: #64748b;
            z-index: 101;
        }

        body,
        body * {
            font-family: ${PDF_EXPORT_FONT_FAMILY};
        }

        @media print {
            @page {
                size: A4;
                margin: 0;
            }

            html,
            body {
                margin: 0 !important;
                padding: 0 !important;
                width: 210mm;
                background: white;
            }

            .page {
                width: 210mm;
                height: 297mm;
                min-height: 297mm;
                padding: 10mm 13mm 18mm;
                page-break-after: always;
                break-after: page;
                page-break-inside: avoid;
                break-inside: avoid;
            }

            .page:last-child {
                page-break-after: auto;
                break-after: auto;
            }

            .do-pdf-category {
                page-break-inside: auto;
                break-inside: auto;
            }
        }
    </style>
</head>
<body>
    ${pagesContent}

    <script>
        // Calculate total pages and update page numbers
        function updatePageNumbers() {
            const pages = document.querySelectorAll('.page');
            const totalPages = pages.length;

            pages.forEach((page, index) => {
                const pageNum = index + 1;
                let pageNumberDiv = page.querySelector('.page-number');
                if (!pageNumberDiv) {
                    pageNumberDiv = document.createElement('div');
                    pageNumberDiv.className = 'page-number';
                    page.appendChild(pageNumberDiv);
                }
                pageNumberDiv.textContent = 'Page ' + pageNum + ' of ' + totalPages;
            });
        }

        // Wait for content to load before updating page numbers
        setTimeout(() => {
            updatePageNumbers();
        }, 100);
    </script>
</body>
</html>`;

    doWindow.document.write(template);
    doWindow.document.close();

    // Add print functionality
    setTimeout(async () => {
        await ensurePdfExportFontReady(doWindow.document);
        doWindow.focus();
        doWindow.print();
    }, 1000);

    showNotification('success', 'PDF delivery order generated successfully');
}

function deliveryOrderPdfThemeColor() {
    const value = String(pdfSettings?.themeColor || '').trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : '#0f766e';
}

function renderDeliveryOrderLetterheadHtml() {
    const safe = value => escapeHtml(String(value ?? ''));
    const logoUrl = getPdfLogoUrl();
    const letterheadEnabled = pdfSettings?.letterheadEnabled !== false;
    if (!letterheadEnabled) {
        return logoUrl ? `
            <div class="do-letterhead" ${pdfTypographyStyleAttr('letterhead')}>
                <div class="do-letterhead-brand"><img src="${escapeHtmlAttr(logoUrl)}" alt="Company logo"></div>
            </div>
        ` : '';
    }
    const companyName = String(pdfSettings?.companyName || '').trim();
    const richLetterhead = String(pdfSettings?.letterheadHtml || '').trim();
    const customLines = String(pdfSettings?.letterheadText || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    const fallbackLines = [
        pdfSettings?.registrationNumber ? `UEN / Reg No: ${pdfSettings.registrationNumber}` : '',
        pdfSettings?.billingAddress || '',
        [pdfSettings?.phone, pdfSettings?.email, pdfSettings?.website].filter(Boolean).join(' | ')
    ].filter(Boolean);
    const detailLines = (customLines.length ? customLines : fallbackLines)
        .filter(line => !companyName || line.toLocaleLowerCase() !== companyName.toLocaleLowerCase())
        .slice(0, 4);
    const brandHtml = logoUrl
        ? `<img src="${escapeHtmlAttr(logoUrl)}" alt="Company logo">`
        : `<div class="do-wordmark" ${pdfTypographyStyleAttr('letterhead')}>${safe(companyName || 'Delivery Order')}</div>`;

    return `
        <div class="do-letterhead" ${pdfTypographyStyleAttr('letterhead')}>
            <div class="do-letterhead-brand">${brandHtml}</div>
            <div class="do-letterhead-details" ${pdfTypographyStyleAttr('letterhead')}>
                ${richLetterhead
                    ? renderPdfRichHtml(richLetterhead)
                    : `${logoUrl && companyName ? `<strong ${pdfTypographyStyleAttr('letterhead')}>${safe(companyName)}</strong>` : ''}
                       ${detailLines.map(line => `<div ${pdfTypographyStyleAttr('letterhead')}>${safe(line)}</div>`).join('')}`}
            </div>
        </div>
    `;
}

function renderDeliveryOrderDocumentHeaderHtml(data, formattedDate, options = {}) {
    const safe = value => escapeHtml(String(value ?? ''));
    const continuation = options.continuation === true;
    const addressLines = [
        data.clientCompany,
        data.deliveryAddress1,
        data.deliveryAddress2,
        data.deliveryAddress3
    ].filter(value => String(value || '').trim());

    return `
        ${renderDeliveryOrderLetterheadHtml()}
        <div class="do-title-row">
            <div class="delivery-order-title">DELIVERY ORDER</div>
            <div class="do-number">${safe(data.doNumber)}</div>
        </div>
        ${continuation ? '' : `<div class="do-recipient-panel">
            <div class="do-recipient">
                <span class="do-label">Deliver to</span>
                <strong>${safe(data.clientName)}</strong>
                <div class="do-recipient-copy">${addressLines.map(line => safe(line)).join('<br>') || '-'}</div>
            </div>
            <div class="do-document-meta">
                <div class="do-meta-row"><span>Date of delivery/collection</span><strong>${safe(formattedDate)}</strong></div>
                <div class="do-meta-row"><span>Phone no.</span><strong>${safe(data.clientPhone || 'N/A')}</strong></div>
            </div>
        </div>
        <div class="do-job-band">
            <div><strong>Job:</strong> ${safe(data.jobTitle || '-')}</div>
            <div><strong>Location:</strong> ${safe(data.jobLocation || '-')}</div>
        </div>`}
    `;
}

function deliveryOrderDepartmentHeaderLabel(department) {
    const value = String(department || '').trim();
    const standardNames = {
        audio: 'Audio Department',
        lighting: 'Lighting Department',
        video: 'Video Department',
        misc: 'Miscellaneous'
    };
    return standardNames[value.toLocaleLowerCase()] || value || 'Miscellaneous';
}

function generatePagesContent(data, formattedDate) {
    const departments = groupItemsByDepartment(data.event);
    const firstPageHeaderHtml = renderDeliveryOrderDocumentHeaderHtml(data, formattedDate);
    const continuationHeaderHtml = renderDeliveryOrderDocumentHeaderHtml(
        data,
        formattedDate,
        { continuation: true }
    );
    const footerHtml = renderPdfFooterHtml();
    const themeColor = deliveryOrderPdfThemeColor();
    const tableColumnsHtml = '<colgroup><col><col class="quantity-column"></colgroup>';
    const tableHeaderHtml = `
        <thead>
            <tr>
                <th class="description-header">DESCRIPTION</th>
                <th class="quantity-header">QUANTITY</th>
            </tr>
        </thead>
    `;

    // A4 is 210mm x 297mm.
    // Page padding is 10mm top, 13mm left/right and 18mm bottom.
    // Normal pages reserve the measured footer height.
    // Last page reserves its measured comments + signature + footer space.
    const PAGE_BODY_HEIGHT_MM = 269;
    const COMMENTS_BOTTOM_MM = 43;
    const COMMENTS_FLOW_GAP_MM = 3;

    const FOOTER_HTML = `
        <div class="footer">
            ${footerHtml}
        </div>
    `;

    const safe = (value) => escapeHtml(String(value ?? ''));

    const renderAssetIdsLine = (assetIds) => {
        if (!assetIds || assetIds.length === 0) return '';

        return `
            <br>
            <span class="asset-id-line">
                Asset IDs: ${assetIds.map(id => safe(id)).join(', ')}
            </span>
        `;
    };

    const renderItemRow = (record) => {
        if (record.item.isGroupHeader) {
            return `
                <tr class="do-pdf-group-row${record.item.isContinuation ? ' is-continuation' : ''}">
                    <td>${safe(record.item.description)}${record.item.isContinuation ? ' (continued)' : ''}</td>
                    <td class="quantity-col">${safe(record.item.quantity)}</td>
                </tr>
            `;
        }
        if (record.item.isGroupChild) {
            const description = safe(record.item.description);
            const quantity = record.item.groupCustomText
                ? ''
                : `<span class="do-pdf-group-child-quantity">${safe(record.item.quantity)}x</span> `;
            return `
                <tr class="do-pdf-group-child-row${record.item.groupCustomText ? ' is-custom-text' : ''}${record.item.isBeforeCustomText ? ' is-before-custom-text' : ''}${record.item.isGroupEnd ? ' is-group-end' : ''}">
                    <td>
                        <div class="do-pdf-group-child-description${record.item.groupCustomText ? ' is-custom-text' : ''}">${quantity}${description}${renderAssetIdsLine(record.item.assetIds)}</div>
                    </td>
                    <td class="quantity-col do-pdf-group-child-quantity-cell" aria-hidden="true"></td>
                </tr>
            `;
        }
        return `
            <tr>
                <td>
                    ${safe(record.item.description)}
                    ${renderAssetIdsLine(record.item.assetIds)}
                </td>
                <td class="quantity-col">${safe(record.item.quantity)}</td>
            </tr>
        `;
    };

    const renderCategoryHeading = (dept, continued = false) => {
        return `
            <div class="do-pdf-category-heading">
                <span>${safe(deliveryOrderDepartmentHeaderLabel(dept))}</span>
                ${continued ? '<small>Continued</small>' : ''}
            </div>
        `;
    };

    const groupDisplayEntries = (items, groupId) => {
        const buckets = new Map();
        (items || []).filter(item => String(item.groupId || '') === String(groupId || ''))
            .forEach(item => {
                const customText = !!item.groupCustomText;
                const description = customText
                    ? String(item.description || 'Item').trim()
                    : financeGroupedLineDisplay(item);
                const key = `${customText ? 'custom' : 'asset'}::${description.trim().toLocaleLowerCase()}`;
                if (!buckets.has(key)) {
                    buckets.set(key, {
                        description,
                        quantity: 0,
                        groupCustomText: customText,
                        members: []
                    });
                }
                const bucket = buckets.get(key);
                bucket.quantity += Math.max(0, Number(item.quantity) || 0);
                bucket.members.push(item);
            });
        return [
            ...[...buckets.values()].filter(entry => !entry.groupCustomText),
            ...[...buckets.values()].filter(entry => entry.groupCustomText)
        ];
    };

    const renderCategorySection = (dept, records, options = {}) => `
        <section class="do-pdf-category${options.first ? ' is-first' : ''}">
            ${renderCategoryHeading(dept, options.continued)}
            <table class="items-table">
                ${tableColumnsHtml}
                ${tableHeaderHtml}
                <tbody>${records.map(renderItemRow).join('')}</tbody>
            </table>
        </section>
    `;

    // Hidden measuring box: lets the browser calculate real row heights
    // instead of guessing based on row count.
    const measureBox = document.createElement('div');
    measureBox.id = '__doMeasureBox';
    measureBox.style.cssText = `
        position:absolute;
        left:-10000px;
        top:0;
        visibility:hidden;
        width:184mm;
        font-family:${PDF_EXPORT_FONT_FAMILY};
        font-size:9pt;
        line-height:1.2;
        background:white;
        z-index:-1;
    `;

    measureBox.innerHTML = `
        <style>
            #__doMeasureBox * {
                box-sizing: border-box;
            }

            #__doMeasureBox .do-letterhead { min-height:15mm;display:flex;justify-content:space-between;align-items:flex-start;gap:12mm;margin-bottom:8mm; }
            #__doMeasureBox .do-letterhead-brand { flex:0 0 auto;min-width:40mm; }
            #__doMeasureBox .do-letterhead-brand img { display:block;width:auto;max-width:42mm;height:auto;max-height:14mm;object-fit:contain; }
            #__doMeasureBox .do-wordmark { max-width:75mm;color:#172033;font-size:15pt;line-height:1.05;font-weight:700; }
            #__doMeasureBox .do-letterhead-details { max-width:88mm;color:#64748b;font-size:6.5pt;line-height:1.35;text-align:right; }
            #__doMeasureBox .do-letterhead-details strong { display:block;margin-bottom:1mm;color:#172033;font-size:8.5pt;line-height:1.2; }
            #__doMeasureBox .do-title-row { display:flex;align-items:flex-end;justify-content:space-between;gap:10mm;padding-bottom:3mm;border-bottom:.6pt solid #cbd5e1; }
            #__doMeasureBox .delivery-order-title { margin:0;color:#172033;font-size:20pt;line-height:1;text-align:left; }
            #__doMeasureBox .do-number { margin:0;color:${themeColor};font-size:12pt;font-weight:700;line-height:1.1;text-align:right; }
            #__doMeasureBox .do-recipient-panel { display:grid;grid-template-columns:minmax(0,1.4fr) minmax(52mm,.75fr);margin-top:5mm;border:.5pt solid #cbd5e1; }
            #__doMeasureBox .do-recipient,#__doMeasureBox .do-document-meta { min-height:0;padding:3.5mm 5mm; }
            #__doMeasureBox .do-document-meta { border-left:.5pt solid #cbd5e1; }
            #__doMeasureBox .do-label { display:block;margin-bottom:1.2mm;color:#64748b;font-size:7pt;font-weight:700;text-transform:uppercase; }
            #__doMeasureBox .do-recipient strong { display:block;margin-bottom:.5mm;color:#172033;font-size:9pt; }
            #__doMeasureBox .do-recipient-copy { color:#334155;font-size:8pt;line-height:1.4; }
            #__doMeasureBox .do-meta-row { display:grid;grid-template-columns:30mm minmax(0,1fr);gap:3mm;margin-bottom:1mm;font-size:8pt; }
            #__doMeasureBox .do-meta-row:last-child { margin-bottom:0; }
            #__doMeasureBox .do-meta-row span { color:#64748b;font-weight:700; }
            #__doMeasureBox .do-meta-row strong { color:#172033;font-weight:400; }
            #__doMeasureBox .do-job-band { display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8mm;margin:4mm 0 5mm;padding:3.5mm 5mm;border:.5pt solid #cbd5e1;background:#f1f5f9;color:#334155;font-size:8pt; }
            #__doMeasureBox .do-job-band strong { color:#172033; }
            #__doMeasureBox .items-table,#__doMeasureBox .do-measure-table { width:100%;table-layout:fixed;border-collapse:collapse;border:.5pt solid #cbd5e1;margin:0; }
            #__doMeasureBox .items-table th { padding:2mm 2.7mm;border:0;background:${themeColor};color:#fff;font-size:7pt; }
            #__doMeasureBox .items-table th:last-child { border-left:.5pt solid rgba(255,255,255,.45);text-align:right; }
            #__doMeasureBox .items-table td,#__doMeasureBox .do-measure-table td { padding:.9mm 2.7mm;border:0;border-bottom:.35pt solid #e2e8f0;color:#172033;font-size:8pt;line-height:1.15;vertical-align:top;word-break:break-word;overflow-wrap:anywhere; }
            #__doMeasureBox .items-table .do-pdf-group-row td,#__doMeasureBox .do-measure-table .do-pdf-group-row td { padding-top:1.7mm;padding-bottom:.5mm;border-top:.55pt solid #9dc9b0;border-bottom:0;background:#fff;color:#172033;font-size:8pt;font-weight:700;text-align:left; }
            #__doMeasureBox .items-table .do-pdf-group-row .quantity-col,#__doMeasureBox .do-measure-table .do-pdf-group-row .quantity-col { font-weight:400;text-align:right; }
            #__doMeasureBox .do-pdf-group-child-row td { padding-top:.45mm;padding-bottom:.45mm;border-bottom:0;text-align:left; }
            #__doMeasureBox .do-pdf-group-child-row.is-before-custom-text td { padding-bottom:0; }
            #__doMeasureBox .do-pdf-group-child-row.is-custom-text td { padding-top:0; }
            #__doMeasureBox .do-pdf-group-child-row.is-group-end td { padding-bottom:1.4mm;border-bottom:.35pt solid #e2e8f0; }
            #__doMeasureBox .do-pdf-group-child-description { padding-left:2.7mm;text-align:left;white-space:normal; }
            #__doMeasureBox .do-pdf-group-child-description.is-custom-text { white-space:pre-line; }
            #__doMeasureBox .do-pdf-group-child-quantity { font-weight:400; }
            #__doMeasureBox .quantity-col { width:22mm;border-left:.5pt solid #cbd5e1!important;text-align:right; }
            #__doMeasureBox .quantity-column { width:22mm; }
            #__doMeasureBox .asset-id-line { display:block;margin-top:.5mm;color:#64748b;font-size:6.5pt;font-style:normal; }
            #__doMeasureBox .do-pdf-category { padding-top:3mm; }
            #__doMeasureBox .do-pdf-category.is-first { padding-top:0; }
            #__doMeasureBox .do-pdf-category-heading { display:flex;align-items:center;justify-content:space-between;min-height:7mm;padding:1.5mm 2.7mm;border:.5pt solid #cbd5e1;border-bottom:0;background:#f1f5f9;color:#172033;font-size:7.2pt;font-weight:700;text-transform:uppercase; }
            #__doMeasureBox .do-pdf-category-heading small { color:#64748b;font-size:6pt;font-weight:600; }
            #__doMeasureBox .do-final-measure { width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:10mm;padding-top:3mm;border-top:.5pt solid #cbd5e1;color:#475569;font-size:7.5pt;line-height:1.35; }
            #__doMeasureBox .do-final-measure .received-text { font-weight:700; }
            #__doMeasureBox .footer-measure { width:100%;color:#64748b;font-size:6.2pt;line-height:1.25;text-align:left;overflow-wrap:anywhere; }
            #__doMeasureBox, #__doMeasureBox * { font-family:${PDF_EXPORT_FONT_FAMILY}; }
        </style>

        <div id="__doFirstBaseMeasure">
            ${firstPageHeaderHtml}
        </div>

        <div id="__doContinuationBaseMeasure">
            ${continuationHeaderHtml}
        </div>

        <div id="__doCategoryMeasure"></div>

        <table class="do-measure-table">
            ${tableColumnsHtml}
            <tbody id="__doMeasureBody"></tbody>
        </table>

        <div id="__doFinalMeasure" class="do-final-measure">
            <div><strong>Other comments:</strong> ${safe(data.additionalComments || '-')}</div>
            <div class="received-text">Received in good order &amp; condition</div>
        </div>

        <div id="__doFooterMeasure" class="footer-measure">${footerHtml}</div>
    `;

    const normaliseMeasuredHeight = mountPdfMeasureBox(measureBox, 184);

    const measureBody = measureBox.querySelector('#__doMeasureBody');
    const measureCategory = measureBox.querySelector('#__doCategoryMeasure');
    const firstBaseHeight = normaliseMeasuredHeight(
        measureBox.querySelector('#__doFirstBaseMeasure').getBoundingClientRect().height
    );
    const continuationBaseHeight = normaliseMeasuredHeight(
        measureBox.querySelector('#__doContinuationBaseMeasure').getBoundingClientRect().height
    );
    const footerHeight = normaliseMeasuredHeight(
        measureBox.querySelector('#__doFooterMeasure')?.getBoundingClientRect().height || 0
    );
    const finalSectionHeight = normaliseMeasuredHeight(
        measureBox.querySelector('#__doFinalMeasure')?.getBoundingClientRect().height || 0
    );
    const normalReservedMm = pdfFooterReserveMm({
        pageFlowHeightMm: PAGE_BODY_HEIGHT_MM,
        topPaddingMm: 10,
        footerBottomMm: 8
    }, footerHeight);

    const firstPageRowBudget = Math.max(
        50,
        pdfMmToPx(PAGE_BODY_HEIGHT_MM - normalReservedMm) - firstBaseHeight
    );
    const continuationPageRowBudget = Math.max(
        50,
        pdfMmToPx(PAGE_BODY_HEIGHT_MM - normalReservedMm) - continuationBaseHeight
    );

    const lastReservedMm = Math.max(
        normalReservedMm,
        COMMENTS_BOTTOM_MM + (finalSectionHeight * 25.4 / 96) + COMMENTS_FLOW_GAP_MM
    );
    const firstPageFinalRowBudget = Math.max(
        50,
        pdfMmToPx(PAGE_BODY_HEIGHT_MM - lastReservedMm) - firstBaseHeight
    );
    const continuationFinalRowBudget = Math.max(
        50,
        pdfMmToPx(PAGE_BODY_HEIGHT_MM - lastReservedMm) - continuationBaseHeight
    );

    function measureRow(rowHtml) {
        measureBody.innerHTML = rowHtml;
        const row = measureBody.querySelector('tr');
        return row ? normaliseMeasuredHeight(row.getBoundingClientRect().height) : 0;
    }

    function measureCategoryBase(dept, first) {
        measureCategory.innerHTML = renderCategorySection(dept, [], { first });
        const section = measureCategory.querySelector('.do-pdf-category');
        return section ? normaliseMeasuredHeight(section.getBoundingClientRect().height) : 0;
    }

    const categoryHeights = {};
    const records = [];
    const allocatedAssetIds = new Set();
    const allocateAssetIds = (item, dept) => {
        const ids = getAssetIdsByItem(data.event, item, dept, {
            excludedIds: allocatedAssetIds
        });
        ids.forEach(id => allocatedAssetIds.add(String(id)));
        return ids;
    };

    Object.keys(departments).forEach(dept => {
        const deptItems = departments[dept] || [];
        if (deptItems.length === 0) return;

        categoryHeights[dept] = {
            first: measureCategoryBase(dept, true),
            following: measureCategoryBase(dept, false)
        };

        const renderedGroups = new Set();
        deptItems.forEach(item => {
            const groupId = String(item.groupId || '');
            if (groupId && renderedGroups.has(groupId)) return;
            if (groupId) {
                renderedGroups.add(groupId);
                const groupQuantity = Math.max(1, Number(item.groupHeaderQuantity) || 1);
                const groupRecord = {
                    dept,
                    item: {
                        description: item.groupTitle || 'Group',
                        quantity: groupQuantity,
                        isGroupHeader: true
                    },
                    groupId,
                    keepWithNext: true,
                    height: 0
                };
                groupRecord.height = measureRow(renderItemRow(groupRecord));
                records.push(groupRecord);
                const entries = groupDisplayEntries(deptItems, groupId);
                entries.forEach((entry, entryIndex) => {
                    const assetLookupItem = {
                        ...(entry.members[0] || {}),
                        quantity: entry.quantity * groupQuantity,
                        assetRefs: entry.members.flatMap(member => member.assetRefs || []),
                        sourceAssetIds: entry.members.flatMap(member => member.sourceAssetIds || [])
                    };
                    const assetIds = data.showAssetIds && !entry.groupCustomText
                        ? allocateAssetIds(assetLookupItem, dept)
                        : [];
                    const childRecord = {
                        dept,
                        item: {
                            description: entry.description,
                            quantity: entry.quantity,
                            groupCustomText: entry.groupCustomText,
                            isGroupChild: true,
                            isBeforeCustomText: !entry.groupCustomText
                                && !!entries[entryIndex + 1]?.groupCustomText,
                            isGroupEnd: entryIndex === entries.length - 1,
                            assetIds: [...new Set(assetIds)].slice(
                                0,
                                Math.max(0, Number(entry.quantity) || 0) * groupQuantity
                            )
                        },
                        groupId,
                        height: 0
                    };
                    childRecord.height = measureRow(renderItemRow(childRecord));
                    records.push(childRecord);
                });
                return;
            }
            const assetIds = data.showAssetIds
                ? allocateAssetIds(item, dept)
                : [];

            const record = {
                dept,
                item: {
                    ...item,
                    description: item.description,
                    assetIds
                },
                groupId,
                height: 0
            };

            record.height = measureRow(renderItemRow(record));
            records.push(record);
        });
    });

    const continuationGroupHeights = new Map();
    records.filter(record => record.item?.isGroupHeader).forEach(record => {
        const continuation = {
            ...record,
            item: { ...record.item, isContinuation: true }
        };
        continuationGroupHeights.set(
            `${record.dept}::${record.groupId}`,
            measureRow(renderItemRow(continuation))
        );
    });

    measureBox.remove();

    function continuationGroupRecord(startIndex) {
        const child = records[startIndex];
        const previous = records[startIndex - 1];
        if (
            !child?.item?.isGroupChild
            || !child.groupId
            || previous?.groupId !== child.groupId
        ) return null;
        let headerIndex = startIndex - 1;
        while (
            headerIndex >= 0
            && records[headerIndex].groupId === child.groupId
            && !records[headerIndex].item?.isGroupHeader
        ) headerIndex -= 1;
        const original = records[headerIndex];
        if (!original?.item?.isGroupHeader) return null;
        const continuation = {
            ...original,
            item: {
                ...original.item,
                isContinuation: true
            },
            keepWithNext: true,
            generatedContinuation: true,
            height: continuationGroupHeights.get(`${original.dept}::${original.groupId}`)
                || original.height
        };
        return continuation;
    }

    function costToAdd(page, record) {
        const needsDeptHeader = page.lastDept !== record.dept;
        const categoryHeight = page.records.length
            ? categoryHeights[record.dept]?.following
            : categoryHeights[record.dept]?.first;
        return (needsDeptHeader ? categoryHeight || 0 : 0) + record.height;
    }

    function canFitRemaining(startIndex, budget, endIndex = records.length) {
        const testPage = {
            records: [],
            height: 0,
            lastDept: null
        };

        const continuation = continuationGroupRecord(startIndex);
        if (continuation) {
            testPage.height += costToAdd(testPage, continuation);
            testPage.records.push(continuation);
            testPage.lastDept = continuation.dept;
        }

        for (let i = startIndex; i < endIndex; i++) {
            const record = records[i];
            const cost = costToAdd(testPage, record);

            if (testPage.height + cost > budget) {
                return false;
            }

            testPage.records.push(record);
            testPage.height += cost;
            testPage.lastDept = record.dept;
        }

        return true;
    }

    function fillPage(startIndex, budget, endIndex = records.length) {
        const page = {
            records: [],
            height: 0,
            lastDept: null
        };

        const continuation = continuationGroupRecord(startIndex);
        if (continuation) {
            page.height += costToAdd(page, continuation);
            page.records.push(continuation);
            page.lastDept = continuation.dept;
        }

        let i = startIndex;

        while (i < endIndex) {
            const record = records[i];
            const cost = costToAdd(page, record);
            const nextRecord = i + 1 < endIndex ? records[i + 1] : null;
            const keepWithNextCost = record.keepWithNext && nextRecord?.dept === record.dept
                ? nextRecord.height
                : 0;

            const hasContentRecord = page.records.some(row => !row.generatedContinuation);
            if (hasContentRecord && page.height + cost + keepWithNextCost > budget) {
                break;
            }

            // If one single row is taller than the available area,
            // keep it on the page instead of creating an infinite loop.
            if (!hasContentRecord && page.height + cost > budget) {
                page.records.push(record);
                page.height += cost;
                page.lastDept = record.dept;
                i++;
                break;
            }

            page.records.push(record);
            page.height += cost;
            page.lastDept = record.dept;
            i++;
        }

        return {
            page,
            nextIndex: i
        };
    }

    const pages = [];

    if (records.length === 0) {
        pages.push({
            records: [],
            height: 0,
            lastDept: null
        });
    } else {
        let index = 0;
        let pageIndex = 0;
        while (index < records.length) {
            const finalBudget = pageIndex === 0
                ? firstPageFinalRowBudget
                : continuationFinalRowBudget;
            if (canFitRemaining(index, finalBudget)) {
                pages.push(fillPage(index, finalBudget).page);
                break;
            }

            const normalBudget = pageIndex === 0
                ? firstPageRowBudget
                : continuationPageRowBudget;
            let result = fillPage(index, normalBudget);

            // The normal page has more usable height than the sign-off page.
            // If it consumed every remaining row, move the smallest intact tail
            // to a final page instead of leaving the sign-off with no page.
            if (result.nextIndex >= records.length) {
                let finalStart = records.length - 1;
                while (
                    finalStart > index
                    && records[finalStart - 1].keepWithNext
                    && records[finalStart - 1].dept === records[finalStart].dept
                ) {
                    finalStart--;
                }
                if (finalStart <= index) {
                    pages.push(fillPage(index, finalBudget).page);
                    break;
                }
                result = fillPage(index, normalBudget, finalStart);
            }

            pages.push(result.page);
            index = result.nextIndex;
            pageIndex++;
        }
    }

    let pagesHtml = '';
    const totalPages = pages.length;

    pages.forEach((page, pageIndex) => {
        const isLastPage = pageIndex === totalPages - 1;
        const pageNumber = pageIndex + 1;

        pagesHtml += `
            <div class="page">
                ${pageIndex === 0 ? firstPageHeaderHtml : continuationHeaderHtml}
        `;

        if (!page.records.length) {
            pagesHtml += '<div class="do-pdf-empty">No items have been added to this delivery order.</div>';
        } else {
            const categoryGroups = [];
            page.records.forEach(record => {
                const current = categoryGroups.at(-1);
                if (!current || current.dept !== record.dept) {
                    categoryGroups.push({ dept: record.dept, records: [record] });
                } else {
                    current.records.push(record);
                }
            });
            const priorDepartments = new Set(
                pages.slice(0, pageIndex).flatMap(priorPage => priorPage.records.map(record => record.dept))
            );
            pagesHtml += categoryGroups.map((group, groupIndex) => renderCategorySection(
                group.dept,
                group.records,
                { first: groupIndex === 0, continued: priorDepartments.has(group.dept) }
            )).join('');
        }

        if (isLastPage) {
            pagesHtml += `
                <div class="comments-section">
                    <div class="other-comments"><strong>Other comments:</strong> ${safe(data.additionalComments || '-')}</div>
                    <div class="received-text">Received in good order & condition</div>
                </div>

                <div class="signature-holder">
                    <div class="signature-space" aria-hidden="true"></div>
                    <div class="signature-label">Company's Stamp &amp; Signature</div>
                </div>
            `;
        }

        pagesHtml += `
                ${FOOTER_HTML}
                <div class="page-number">Page ${pageNumber} of ${totalPages}</div>
            </div>
        `;
    });

    return pagesHtml;
}

// Delivery order generation helpers
async function ensureAssetsLoaded() {
    if (!assets || assets.length === 0) {
        try {
            const response = await apiCall('/api/assets');
            if (response.success) {
                assets = response.data;
            } else {
                console.error('Failed to load assets:', response);
            }
        } catch (error) {
            console.error('Error loading assets:', error);
        }
    }
}

// Delivery order item ordering
function normaliseDoOrdering(items, storedOrdering = []) {
  const itemKeys = items.map(item => item.key).filter(Boolean);
  const validKeys = new Set(itemKeys);
  const seen = new Set();
  const ordering = [];
  (Array.isArray(storedOrdering) ? storedOrdering : []).forEach(key => {
    if (!validKeys.has(key) || seen.has(key)) return;
    seen.add(key);
    ordering.push(key);
  });
  itemKeys.forEach(key => {
    if (seen.has(key)) return;
    seen.add(key);
    ordering.push(key);
  });
  return ordering;
}

function deliveryOrderItemIsMiscellaneous(item) {
  const source = String(item?.source || '').toLowerCase();
  if (source === 'event-custom' || source === 'custom-prepared') return true;
  if (source !== 'do-custom') return false;
  if (item?.isCustom) return true;
  return !item?.catalogKey
    && !(item?.sourceAssetIds || []).length
    && !String(item?.brand || '').trim()
    && !String(item?.model || '').trim();
}

function deliveryOrderAssetsBeforeMiscellaneous(items) {
  const rows = [...(items || [])];
  const renderedGroups = new Set();
  const units = [];
  rows.forEach(item => {
    const groupId = String(item?.groupId || '');
    if (!groupId) {
      units.push({ rows: [item], miscellaneous: deliveryOrderItemIsMiscellaneous(item) });
      return;
    }
    if (renderedGroups.has(groupId)) return;
    renderedGroups.add(groupId);
    const members = rows.filter(candidate => String(candidate?.groupId || '') === groupId);
    units.push({
      rows: [
        ...members.filter(member => !member.groupCustomText),
        ...members.filter(member => member.groupCustomText)
      ],
      miscellaneous: members.every(deliveryOrderItemIsMiscellaneous)
    });
  });
  return [
    ...units.filter(unit => !unit.miscellaneous),
    ...units.filter(unit => unit.miscellaneous)
  ].flatMap(unit => unit.rows);
}

function deliveryOrderAlphabeticalItems(items) {
  const rows = [...(items || [])];
  const renderedGroups = new Set();
  const units = [];
  rows.forEach(item => {
    const groupId = String(item?.groupId || '');
    if (!groupId) {
      units.push([item]);
      return;
    }
    if (renderedGroups.has(groupId)) return;
    renderedGroups.add(groupId);
    const members = rows.filter(candidate => String(candidate?.groupId || '') === groupId);
    units.push([
      ...members.filter(member => !member.groupCustomText),
      ...members.filter(member => member.groupCustomText)
    ]);
  });
  units.sort((leftUnit, rightUnit) => {
    const left = leftUnit[0] || {};
    const right = rightUnit[0] || {};
    const leftLabel = [left.groupTitle, left.description, left.brand, left.model]
      .filter(Boolean).join(' ');
    const rightLabel = [right.groupTitle, right.description, right.brand, right.model]
      .filter(Boolean).join(' ');
    return leftLabel.localeCompare(rightLabel, undefined, {
      numeric: true,
      sensitivity: 'base'
    }) || String(left.key || '').localeCompare(String(right.key || ''), undefined, { numeric: true });
  });
  return deliveryOrderAssetsBeforeMiscellaneous(units.flat());
}

function reorderDoItems(eventId, dept, fromIndex, toIndex, position = 'before', subprojectId = '') {
  const state = getDoEdits(eventId);

  const event = currentDeliveryOrderEvent
    || events.find(e => e.id === eventId || e.event_id === eventId);
  if (!event) return false;

  const depts = groupItemsByDepartment(event, subprojectId || deliveryOrderActiveSubprojectId(event));
  const items = depts[dept] || [];

  if (fromIndex < 0 || toIndex < 0 ||
      fromIndex >= items.length || toIndex >= items.length) {
    return false;
  }

  const orderingKey = deliveryOrderOrderingKey(subprojectId, dept);
  const ordering = normaliseDoOrdering(items, state.ordering[orderingKey]);
  const [movedKey] = ordering.splice(fromIndex, 1);
  let insertionIndex = toIndex + (position === 'after' ? 1 : 0);
  if (fromIndex < insertionIndex) insertionIndex -= 1;
  ordering.splice(Math.max(0, Math.min(insertionIndex, ordering.length)), 0, movedKey);
  if (ordering.every((key, index) => key === items[index]?.key)) return false;

  state.ordering[orderingKey] = ordering;
  saveDoEdits(eventId, state, { immediate: true });
  return true;
}

function applyDoOrdering(items, dept, eventId, subprojectId = '') {
  const state = getDoEdits(eventId);
  const storedOrdering = state.ordering?.[deliveryOrderOrderingKey(subprojectId, dept)];
  const hasStoredOrdering = Array.isArray(storedOrdering) && storedOrdering.length > 0;
  const sourceItems = hasStoredOrdering
    ? items
    : deliveryOrderAlphabeticalItems(items);
  const ordering = normaliseDoOrdering(
    sourceItems,
    storedOrdering
  );
  if (!ordering) return sourceItems;
  const orderedItems = [];
  const itemsMap = new Map(sourceItems.map(item => [item.key, item]));
  ordering.forEach(key => {
    const item = itemsMap.get(key);
    if (item) {
      orderedItems.push(item);
      itemsMap.delete(key);
    }
  });
  itemsMap.forEach(item => orderedItems.push(item));
  // Asset-first and alphabetical ordering are defaults only. Once the user
  // drags a line, the stored order is authoritative and must not be sorted
  // again while rendering.
  return hasStoredOrdering
    ? orderedItems
    : deliveryOrderAssetsBeforeMiscellaneous(orderedItems);
}

function setupDoItemDragHandlers(previewContainer, eventId) {
  let draggedIndex = null;
  let draggedDept = null;
  let draggedSubprojectId = '';

  previewContainer.querySelectorAll('.do-item-row').forEach(row => {
    const handle = row.querySelector('.do-drag-handle[draggable="true"]');
    if (!handle) return;

    handle.addEventListener('dragstart', (e) => {
      draggedIndex = Number(row.dataset.index);
      draggedDept = row.dataset.dept;
      draggedSubprojectId = row.dataset.subprojectId || '';
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-showbase-delivery-order-line', String(draggedIndex));
    });

    handle.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      draggedIndex = null;
      draggedDept = null;
      draggedSubprojectId = '';
      previewContainer.querySelectorAll('.do-item-row').forEach(target => {
        target.classList.remove('drag-over-before', 'drag-over-after');
        delete target.dataset.dropPosition;
      });
    });

    row.addEventListener('dragover', (e) => {
      if (row.dataset.dept !== draggedDept || row.dataset.subprojectId !== draggedSubprojectId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const position = showbaseLineWorkspace.dropPosition(e);
      row.dataset.dropPosition = position;
      row.classList.toggle('drag-over-before', position === 'before');
      row.classList.toggle('drag-over-after', position === 'after');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over-before', 'drag-over-after');
      delete row.dataset.dropPosition;
    });

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetIndex = Number(row.dataset.index);
      const position = row.dataset.dropPosition || showbaseLineWorkspace.dropPosition(e);
      row.classList.remove('drag-over-before', 'drag-over-after');
      if (row.dataset.dept !== draggedDept || row.dataset.subprojectId !== draggedSubprojectId) return;
      if (!reorderDoItems(eventId, draggedDept, draggedIndex, targetIndex, position, draggedSubprojectId)) return;
      populateDeliveryItemsPreview(currentDeliveryOrderEvent);
    });
  });
}

function getDeliveryOrderAssetCatalog() {
  const grouped = new Map();
  (assets || []).forEach(asset => {
    if (!asset || isCustomAssetId(asset.id)) return;
    const department = departmentCodeToDoName(asset.department || 'UN');
    const brand = String(asset.brand || '').trim();
    const model = String(asset.model || asset.name || '').trim();
    const description = String(asset.description || '').trim();
    const label = [brand, model].filter(Boolean).join(' ') || description || String(asset.id || 'Asset');
    const detail = description && description.toLowerCase() !== label.toLowerCase() ? description : '';
    const key = [department, brand, model, description].map(value => value.toLowerCase()).join('|');
    if (!grouped.has(key)) grouped.set(key, {
      department,
      brand,
      model,
      description,
      label,
      detail,
      tags: [],
      catalogKey: `inventory|${key}`,
      sourceAssetIds: []
    });
    const catalogItem = grouped.get(key);
    catalogItem.tags = normalizeAssetTags([
      ...catalogItem.tags,
      ...normalizeAssetTags(asset.tags),
    ]);
    if (asset.id && !catalogItem.sourceAssetIds.includes(String(asset.id))) {
      catalogItem.sourceAssetIds.push(String(asset.id));
    }
  });
  return Array.from(grouped.values()).sort((a, b) =>
    a.department.localeCompare(b.department) || a.label.localeCompare(b.label, undefined, { numeric: true })
  );
}

function deliveryOrderCatalogDisplayName(item) {
  if (!item) return '';
  const product = [item.brand, item.model].filter(Boolean).join(' ').trim();
  const detail = String(item.description || item.detail || '').trim();
  return [product || item.label, detail && detail.toLocaleLowerCase() !== product.toLocaleLowerCase() ? detail : '']
    .filter(Boolean)
    .join(' - ');
}

function deliveryOrderDepartmentControlMarkup({ value, groupId = '', label = 'Category' } = {}) {
  const encodedGroupId = groupId ? encodeURIComponent(groupId) : '';
  return `
    <div class="finance-inline-combobox do-line-category-combobox">
      <input type="text" class="finance-line-input do-dept" value="${escapeHtmlAttr(value || '')}"
        aria-label="${escapeHtmlAttr(label)}" autocomplete="off" data-do-group-id="${escapeHtmlAttr(encodedGroupId)}"
        onfocus="deliveryOrderRenderLineDepartmentSuggestions(this)"
        oninput="deliveryOrderRenderLineDepartmentSuggestions(this)"
        onkeydown="showbaseLineWorkspace.suggestionKeydown(event,this.closest('.do-line-category-combobox')?.querySelector('.do-line-category-suggestions'))"
        onchange="deliveryOrderCommitLineDepartment(this)"
        onblur="setTimeout(()=>deliveryOrderHideLineDepartmentSuggestions(this),120)">
      <div class="finance-inline-suggestions do-line-category-suggestions"></div>
    </div>
  `;
}

function deliveryOrderGroupWorkingLines() {
  const event = currentDeliveryOrderEvent;
  if (!event) return [];
  const eventId = event.id || event.event_id || window.currentEventId || '0';
  const subprojectId = deliveryOrderActiveSubprojectId(event);
  const state = getDoEdits(eventId);
  return Object.entries(state.custom || {}).flatMap(([category, lines]) => (
    (lines || [])
      .filter(line => (
        line.groupId
        && String(line.subprojectId || 'main') === String(subprojectId || 'main')
      ))
      .map(line => ({
        ...line,
        id: line.id || makeDoCustomItemId(),
        customId: line.id || '',
        key: `DOCUSTOM|${line.id || ''}`,
        category,
        department: category,
        quantity: Math.max(0, Number(line.quantity) || 0),
        source: 'do-custom'
      }))
  ));
}

function deliveryOrderNewGroupedLine(selected, category, subprojectId) {
  const id = makeDoCustomItemId();
  const description = String(
    selected?.isCustom
      ? selected.description
      : deliveryOrderCatalogDisplayName(selected)
  ).trim() || String(selected?.description || selected?.label || 'Item').trim();
  return {
    id,
    customId: id,
    key: `DOCUSTOM|${id}`,
    description,
    quantity: Math.max(0, Number(selected?.quantityOverride ?? selected?.quantity ?? 1) || 0),
    category,
    department: category,
    brand: String(selected?.brand || '').trim(),
    model: String(selected?.model || '').trim(),
    catalogKey: selected?.catalogKey || '',
    sourceAssetIds: [...new Set((selected?.sourceAssetIds || []).map(String))],
    source: 'do-custom',
    subprojectId: String(subprojectId || 'main'),
    isCustom: !!selected?.isCustom
  };
}

function deliveryOrderCommitLineGroup(groupId, subprojectId, groupedLines) {
  const event = currentDeliveryOrderEvent;
  if (!event) return false;
  const eventId = event.id || event.event_id || window.currentEventId || '0';
  const state = getDoEdits(eventId);
  const targetSubprojectId = String(subprojectId || 'main');
  const groupHeaderQuantity = Math.max(
    1,
    Number((groupedLines || []).find(line => line.groupHeaderQuantity != null)?.groupHeaderQuantity) || 1
  );
  Object.keys(state.custom || {}).forEach(category => {
    state.custom[category] = (state.custom[category] || []).filter(line => !(
      String(line.groupId || '') === String(groupId || '')
      && String(line.subprojectId || 'main') === targetSubprojectId
    ));
  });

  let firstKey = '';
  (groupedLines || []).forEach(line => {
    const category = String(line.category || line.department || 'MISC').trim() || 'MISC';
    const id = String(line.customId || line.id || makeDoCustomItemId());
    state.custom[category] ||= [];
    state.custom[category].push({
      id,
      description: String(line.description || 'Item'),
      quantity: Math.max(0, Number(line.quantity) || 0),
      brand: String(line.brand || ''),
      model: String(line.model || ''),
      catalogKey: line.catalogKey || '',
      sourceAssetIds: [...new Set((line.sourceAssetIds || []).map(String))],
      subprojectId: targetSubprojectId,
      groupId: String(groupId || ''),
      groupTitle: String(line.groupTitle || 'Group'),
      groupDisplayFields: Array.isArray(line.groupDisplayFields)
        ? [...line.groupDisplayFields]
        : ['brand', 'model', 'description'],
      groupCustomText: !!line.groupCustomText,
      groupHeaderQuantity,
      isCustom: !!line.isCustom
    });
    deliveryOrderEditorState.collapsedCategories[`${eventId}::${targetSubprojectId}::${category}`] = false;
    if (!firstKey) firstKey = `DOCUSTOM|${id}`;
  });

  deliveryOrderEditorState.pendingRevealKey = firstKey;
  saveDoEdits(eventId, state, { immediate: true });
  Promise.resolve(populateDeliveryItemsPreview(event)).then(() => {
    deliveryOrderEditorState.pendingRevealKey = '';
  });
  return true;
}

function deliveryOrderGroupQuantityChange(encodedGroupId, value) {
  const event = currentDeliveryOrderEvent;
  const groupId = decodeURIComponent(encodedGroupId || '');
  if (!event || !groupId) return false;
  const eventId = event.id || event.event_id || window.currentEventId || '0';
  const subprojectId = String(deliveryOrderActiveSubprojectId(event) || 'main');
  const quantity = Math.max(1, Number(value) || 1);
  const state = getDoEdits(eventId);
  let changed = false;
  Object.values(state.custom || {}).forEach(lines => {
    (lines || []).forEach(line => {
      if (
        String(line.groupId || '') !== groupId
        || String(line.subprojectId || 'main') !== subprojectId
      ) return;
      line.groupHeaderQuantity = quantity;
      changed = true;
    });
  });
  if (!changed) return false;
  saveDoEdits(eventId, state, { immediate: true });
  return true;
}

function deliveryOrderMoveLineGroup(encodedGroupId, control) {
  const groupId = decodeURIComponent(encodedGroupId || '');
  const category = String(control?.value || '').trim();
  if (!category) {
    showNotification('warning', 'Choose a category for the group');
    populateDeliveryItemsPreview(currentDeliveryOrderEvent);
    return false;
  }
  const subprojectId = deliveryOrderActiveSubprojectId();
  const lines = deliveryOrderGroupWorkingLines()
    .filter(line => String(line.groupId || '') === groupId)
    .map(line => ({ ...line, category, department: category }));
  if (!lines.length) return false;
  return deliveryOrderCommitLineGroup(groupId, subprojectId, lines);
}

async function deliveryOrderDeleteLineGroup(encodedGroupId) {
  const groupId = decodeURIComponent(encodedGroupId || '');
  const event = currentDeliveryOrderEvent;
  if (!event || !groupId) return false;
  if (!await showAppConfirm({
    title: 'Remove Group',
    message: 'Remove this group and all of its items from the Delivery Order?',
    confirmText: 'Remove',
    cancelText: 'Cancel',
    variant: 'warning'
  })) return false;
  const eventId = event.id || event.event_id || window.currentEventId || '0';
  const subprojectId = deliveryOrderActiveSubprojectId(event);
  const state = getDoEdits(eventId);
  Object.keys(state.custom || {}).forEach(category => {
    state.custom[category] = (state.custom[category] || []).filter(line => !(
      String(line.groupId || '') === groupId
      && String(line.subprojectId || 'main') === String(subprojectId || 'main')
    ));
  });
  await saveDoEdits(eventId, state, { immediate: true });
  showNotification('success', 'Group removed from the Delivery Order');
  await populateDeliveryItemsPreview(event);
  return false;
}

function removeDeliveryOrderItem(eventId, { key, kind, customId }) {
  const state = getDoEdits(eventId);
  if (kind === 'do-custom') {
    const stableId = customId || String(key || '').replace(/^DOCUSTOM\|/, '');
    let removed = false;
    Object.keys(state.custom || {}).forEach(department => {
      const before = state.custom[department].length;
      state.custom[department] = state.custom[department].filter(item => item.id !== stableId);
      if (state.custom[department].length !== before) removed = true;
    });
    if (!removed) return false;
  } else if (key) {
    state.deleted[key] = true;
  } else {
    return false;
  }
  saveDoEdits(eventId, state, { immediate: true });
  return true;
}

function removeDeliveryOrderRow(button) {
  const row = button?.closest('.do-item-row');
  const event = currentDeliveryOrderEvent;
  if (!row || !event) {
    showNotification('error', 'Could not identify that delivery order line.');
    return false;
  }
  const eventId = event.id || event.event_id || window.currentEventId || '0';
  const removed = removeDeliveryOrderItem(eventId, {
    key: row.getAttribute('data-key'),
    kind: row.getAttribute('data-kind'),
    customId: row.getAttribute('data-custom-id')
  });
  if (!removed) {
    showNotification('error', 'Could not find that delivery order line. Please reopen the editor and try again.');
    return false;
  }
  showNotification('success', 'Item removed from the delivery order');
  populateDeliveryItemsPreview(event);
  return false;
}

// Delivery order preview and inline editing
function deliveryOrderRenderCatalogResults() {
  const search = document.getElementById('doCatalogSearch');
  const results = document.getElementById('doCatalogResults');
  if (!search || !results) return;
  const query = search.value.trim().toLowerCase();
  deliveryOrderEditorState.selectedCatalogItem = null;
  if (!query) {
    deliveryOrderEditorState.catalogMatches = [];
    results.innerHTML = '';
    results.classList.remove('open');
    return;
  }
  deliveryOrderEditorState.catalogMatches = deliveryOrderEditorState.catalog.filter(item =>
    [item.label, item.detail, item.brand, item.model, item.department, ...(item.tags || [])]
      .join(' ').toLowerCase().includes(query)
  ).slice(0, 12);
  results.innerHTML = deliveryOrderEditorState.catalogMatches.map((item, index) => `
    <button type="button" class="finance-catalog-option do-catalog-result" onclick="deliveryOrderSelectCatalogItem(${index})">
      <span><strong>${escapeHtml(item.label)}</strong><br><small>${escapeHtml([item.detail, item.department].filter(Boolean).join(' / '))}</small></span>
      <small>${item.sourceAssetIds.length} in inventory</small>
    </button>
  `).join('') || '<div class="finance-suggestion-empty">No inventory match. Press Add to create this as a custom item.</div>';
  results.classList.add('open');
}

function deliveryOrderSelectCatalogItem(index) {
  const item = deliveryOrderEditorState.catalogMatches[Number(index)];
  if (!item) return;
  deliveryOrderEditorState.selectedCatalogItem = item;
  const search = document.getElementById('doCatalogSearch');
  const category = document.getElementById('doCatalogDepartment');
  const results = document.getElementById('doCatalogResults');
  if (search) search.value = deliveryOrderCatalogDisplayName(item);
  if (category) category.value = item.department;
  if (results) {
    results.innerHTML = '';
    results.classList.remove('open');
  }
}

function deliveryOrderAddItemKeydown(event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  showbaseLineWorkspace.selectFirstSuggestion('doCatalogResults');
  deliveryOrderAddCatalogItem();
}

function deliveryOrderRenderDepartmentSuggestions() {
  const input = document.getElementById('doCatalogDepartment');
  const results = document.getElementById('doCatalogDepartmentResults');
  if (!input || !results || !currentDeliveryOrderEvent) return;
  const eventId = currentDeliveryOrderEvent.id || currentDeliveryOrderEvent.event_id || '0';
  const grouped = groupItemsByDepartment(
    currentDeliveryOrderEvent,
    deliveryOrderActiveSubprojectId(currentDeliveryOrderEvent)
  );
  const query = input.value.trim().toLowerCase();
  const names = getDoDepartmentList(grouped, getDoEdits(eventId))
    .filter(name => !query || name.toLowerCase().includes(query));
  results.innerHTML = names.map(name => `
    <button type="button" onclick="deliveryOrderSelectDepartment('${escapeHtmlAttr(name)}')">${escapeHtml(name)}</button>
  `).join('') || '<div class="finance-suggestion-empty">Enter a new category name</div>';
  results.classList.add('open');
}

function deliveryOrderSelectDepartment(name) {
  const input = document.getElementById('doCatalogDepartment');
  const results = document.getElementById('doCatalogDepartmentResults');
  if (input) input.value = name;
  if (results) {
    results.innerHTML = '';
    results.classList.remove('open');
  }
}

async function deliveryOrderAddCatalogItem() {
  const event = currentDeliveryOrderEvent;
  if (!event) return;
  const addButton = document.querySelector('.do-catalog-composer .btn-primary');
  if (addButton?.disabled) return;
  if (addButton) addButton.disabled = true;
  try {
    const eventId = event.id || event.event_id || '0';
    const search = document.getElementById('doCatalogSearch');
    const category = document.getElementById('doCatalogDepartment');
    const quantityInput = document.getElementById('doCatalogQuantity');
    const selected = deliveryOrderEditorState.selectedCatalogItem;
    const description = String(selected
      ? deliveryOrderCatalogDisplayName(selected)
      : search?.value || '').trim();
    if (!description) {
      showNotification('warning', 'Enter or select an asset first');
      search?.focus();
      return;
    }

    const department = String(category?.value || selected?.department || '').trim();
    if (!department) {
      showNotification('warning', 'Choose a category before adding the item');
      category?.focus();
      return;
    }
    const subprojectId = deliveryOrderActiveSubprojectId(event);
    const customId = makeDoCustomItemId();
    const rowKey = `DOCUSTOM|${customId}`;
    const state = getDoEdits(eventId);
    state.custom[department] ||= [];
    state.custom[department].push({
      id: customId,
      description,
      quantity: Math.max(1, Number(quantityInput?.value) || 1),
      brand: selected?.brand || '',
      model: selected?.model || '',
      catalogKey: selected?.catalogKey || '',
      sourceAssetIds: [...(selected?.sourceAssetIds || [])],
      subprojectId
    });

    deliveryOrderEditorState.selectedCatalogItem = null;
    deliveryOrderEditorState.pendingRevealKey = rowKey;
    deliveryOrderEditorState.collapsedCategories[`${eventId}::${subprojectId}::${department}`] = false;
    await saveDoEdits(eventId, state, { immediate: true });
    await populateDeliveryItemsPreview(event);

    const visibleRow = document.querySelector(`.do-item-row[data-key="${CSS.escape(rowKey)}"]`);
    if (!visibleRow) {
      throw new Error(`The new line was saved but could not be displayed in ${department}.`);
    }
    visibleRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    visibleRow.classList.add('is-new');
    setTimeout(() => visibleRow.classList.remove('is-new'), 1800);
    deliveryOrderEditorState.pendingRevealKey = '';
    showNotification('success', `${description} added to ${department}`);
  } catch (error) {
    deliveryOrderEditorState.pendingRevealKey = '';
    console.error('Could not add Delivery Order line:', error);
    showNotification('error', error.message || 'Could not add the item to the Delivery Order');
  } finally {
    if (addButton?.isConnected) addButton.disabled = false;
  }
}

function deliveryOrderRenderLineDepartmentSuggestions(control) {
  const results = control?.closest('.do-line-category-combobox')
    ?.querySelector('.do-line-category-suggestions');
  if (!control || !results || !currentDeliveryOrderEvent) return;
  const eventId = currentDeliveryOrderEvent.id || currentDeliveryOrderEvent.event_id || '0';
  const grouped = groupItemsByDepartment(
    currentDeliveryOrderEvent,
    deliveryOrderActiveSubprojectId(currentDeliveryOrderEvent)
  );
  const query = control.value.trim().toLowerCase();
  const names = getDoDepartmentList(grouped, getDoEdits(eventId))
    .filter(name => !query || name.toLowerCase().includes(query));
  results.innerHTML = names.map(name => `
    <button type="button" data-do-department="${escapeHtmlAttr(name)}"
      onmousedown="event.preventDefault()" onclick="deliveryOrderSelectLineDepartment(this)">${escapeHtml(name)}</button>
  `).join('') || '<div class="finance-suggestion-empty">Enter a new category name</div>';
  results.classList.add('open');
}

function deliveryOrderHideLineDepartmentSuggestions(control) {
  const results = control?.closest('.do-line-category-combobox')
    ?.querySelector('.do-line-category-suggestions');
  if (!results) return;
  results.innerHTML = '';
  results.classList.remove('open');
}

function deliveryOrderSelectLineDepartment(button) {
  const wrapper = button?.closest('.do-line-category-combobox');
  const control = wrapper?.querySelector('.do-dept');
  if (!control) return false;
  control.value = String(button.dataset.doDepartment || '').trim();
  deliveryOrderHideLineDepartmentSuggestions(control);
  return deliveryOrderCommitLineDepartment(control);
}

function deliveryOrderCommitLineDepartment(control) {
  const encodedGroupId = control?.dataset.doGroupId || '';
  if (encodedGroupId) return deliveryOrderMoveLineGroup(encodedGroupId, control);
  return deliveryOrderAutosaveLine(control);
}

function deliveryOrderSaveLine(row) {
  const event = currentDeliveryOrderEvent;
  if (!row || !event) return false;
  const eventId = event.id || event.event_id || window.currentEventId || '0';
  const key = row.dataset.key || '';
  const kind = row.dataset.kind || '';
  const customId = row.dataset.customId || '';
  const sourceDepartment = row.dataset.dept || 'MISC';
  const targetDepartment = row.querySelector('.do-dept')?.value.trim() || sourceDepartment;
  const descriptionControl = row.querySelector('.do-desc');
  const description = descriptionControl
    ? descriptionControl.value.trim()
    : String(row.dataset.description || '').trim();
  const quantity = Math.max(1, Number(row.querySelector('.do-qty')?.value) || 1);
  if (!description) {
    showNotification('warning', 'Item is required');
    populateDeliveryItemsPreview(event);
    return false;
  }

  const state = getDoEdits(eventId);
  if (kind === 'do-custom') {
    let sourceItem = null;
    let sourceIndex = -1;
    let sourceBucket = '';
    Object.keys(state.custom || {}).some(department => {
      const index = state.custom[department].findIndex(item => String(item.id) === String(customId));
      if (index < 0) return false;
      sourceItem = state.custom[department][index];
      sourceIndex = index;
      sourceBucket = department;
      return true;
    });
    if (!sourceItem) return false;
    const updated = { ...sourceItem, description, quantity };
    if (sourceBucket === targetDepartment) {
      state.custom[sourceBucket][sourceIndex] = updated;
    } else {
      state.custom[sourceBucket].splice(sourceIndex, 1);
      state.custom[targetDepartment] ||= [];
      state.custom[targetDepartment].push(updated);
    }
  } else if (key) {
    state.overrides[key] = { description, quantity, department: targetDepartment };
  } else {
    return false;
  }

  saveDoEdits(eventId, state, { immediate: true });
  populateDeliveryItemsPreview(event);
  return true;
}

function deliveryOrderAutosaveLine(control) {
  return deliveryOrderSaveLine(control?.closest('.do-item-row'));
}

function deliveryOrderToggleCategory(encodedCategory) {
  const category = decodeURIComponent(encodedCategory);
  const subprojectId = deliveryOrderActiveSubprojectId();
  const eventId = currentDeliveryOrderEvent?.id || currentDeliveryOrderEvent?.event_id || '0';
  const key = `${eventId}::${subprojectId}::${category}`;
  const collapsed = !deliveryOrderEditorState.collapsedCategories[key];
  deliveryOrderEditorState.collapsedCategories[key] = collapsed;
  const section = document.querySelector(`[data-do-category="${CSS.escape(encodedCategory)}"]`);
  showbaseLineWorkspace.setCategoryCollapsed(section, collapsed);
}

async function populateDeliveryItemsPreview(event) {
  const previewContainer = document.getElementById('deliveryItemsPreview');
  if (!previewContainer) return;

  try {
    await ensureAssetsLoaded();
  } catch {}

  currentDeliveryOrderEvent = event;
  const eventId = event.id || event.event_id || window.currentEventId || '0';
  const subprojectId = deliveryOrderActiveSubprojectId(event);
  const edits = getDoEdits(eventId);
  const depts = groupItemsByDepartment(event, subprojectId);
  const populatedDepartments = Object.values(depts).filter(items => items.length);
  const lineCount = populatedDepartments.reduce((total, items) => total + items.length, 0);
  const unitCount = populatedDepartments.reduce((total, items) => (
    total + items.reduce((subtotal, item) => subtotal + (Number(item.quantity) || 0), 0)
  ), 0);
  const escA = value => (typeof escapeHtmlAttr === 'function' ? escapeHtmlAttr(value) : escapeHtml(value));

  const addRow = showbaseLineWorkspace.addRowMarkup({
    mode: 'delivery-order',
    className: 'do-catalog-composer',
    search: {
      id: 'doCatalogSearch',
      resultsId: 'doCatalogResults',
      placeholder: 'Search inventory or enter an item',
      oninput: 'deliveryOrderRenderCatalogResults()',
      onkeydown: 'deliveryOrderAddItemKeydown(event)'
    },
    category: {
      id: 'doCatalogDepartment',
      resultsId: 'doCatalogDepartmentResults',
      value: '',
      placeholder: 'Category',
      oninput: 'deliveryOrderRenderDepartmentSuggestions()',
      onfocus: 'deliveryOrderRenderDepartmentSuggestions()',
      onblur: "setTimeout(()=>deliveryOrderSelectDepartment(document.getElementById('doCatalogDepartment')?.value||''),120)",
      onkeydown: "showbaseLineWorkspace.suggestionKeydown(event,'doCatalogDepartmentResults')"
    },
    extraMarkup: '<input id="doCatalogQuantity" class="finance-input do-catalog-quantity" type="number" min="1" max="999" value="1" aria-label="Quantity">',
    addAction: 'deliveryOrderAddCatalogItem()',
    groupAction: "financeOpenLineGroupEditor('delivery-order')"
  });

  const sectionMarkup = (department, items) => {
    const encodedDepartment = encodeURIComponent(department);
    const collapseKey = `${eventId}::${subprojectId}::${department}`;
    const collapsed = !!deliveryOrderEditorState.collapsedCategories[collapseKey];
    const lineMarkup = (item, index, groupChild = false, groupEnd = false) => `
      <tr class="finance-line-row do-item-row${groupChild ? ' finance-group-child-row' : ''}${groupEnd ? ' is-group-end' : ''}${item.groupCustomText ? ' do-group-custom-text-row' : ''}${deliveryOrderEditorState.pendingRevealKey === item.key ? ' is-new' : ''}"
          data-key="${escA(item.key)}"
          data-custom-id="${escA(item.customId || '')}"
          data-kind="${escA(item.source || '')}"
          data-dept="${escA(department)}"
          data-description="${escA(item.description)}"
          data-subproject-id="${escA(subprojectId)}"
          data-index="${index}">
        <td class="do-item-cell">
          <div class="do-edit-item">
            <span class="do-drag-handle" draggable="true" title="Drag to reorder" aria-label="Drag to reorder"><i></i><i></i><i></i><i></i><i></i><i></i></span>
            ${groupChild
              ? `<div class="finance-group-item-display"><span class="${item.groupCustomText ? 'showbase-group-custom-text' : ''}">${escapeHtml(item.groupCustomText ? item.description : financeGroupedLineDisplay(item))}</span>${item.groupCustomText ? '<small>Custom text</small>' : ''}</div>`
              : `<input type="text" class="finance-line-input do-desc" value="${escA(item.description)}" placeholder="Item" aria-label="Description" onchange="deliveryOrderAutosaveLine(this)">`}
          </div>
        </td>
        <td class="do-category-cell">${groupChild ? '' : deliveryOrderDepartmentControlMarkup({ value: department })}</td>
        <td class="do-quantity-cell"><input type="number" class="finance-line-input do-qty" value="${escA(item.quantity)}" min="1" max="999" aria-label="Quantity" onchange="deliveryOrderAutosaveLine(this)"></td>
        <td class="do-action-cell">
          <button type="button" class="finance-delete-line do-del" title="Remove line" aria-label="Remove line" onclick="return removeDeliveryOrderRow(this)">&times;</button>
        </td>
      </tr>
    `;
    const renderedGroups = new Set();
    const rows = items.map((item, index) => {
      const groupId = String(item.groupId || '');
      if (!groupId) return lineMarkup(item, index);
      if (renderedGroups.has(groupId)) return '';
      renderedGroups.add(groupId);
      const members = items
        .map((candidate, candidateIndex) => ({ item: candidate, index: candidateIndex }))
        .filter(row => String(row.item.groupId || '') === groupId);
      const encodedGroupId = encodeURIComponent(groupId);
      const header = `
        <tr class="finance-line-row finance-line-group-header finance-group-commercial-row do-line-group-header">
          <td><div class="finance-group-title"><button type="button" class="finance-group-title-button" title="Edit group" onclick="financeOpenLineGroupEditor('delivery-order','${escA(groupId)}')">${escapeHtml(item.groupTitle || 'Group')}</button><button type="button" title="Edit group contents" aria-label="Edit group contents" onclick="financeOpenLineGroupEditor('delivery-order','${escA(groupId)}')">&#9998;</button></div></td>
          <td class="do-category-cell">${deliveryOrderDepartmentControlMarkup({ value: department, groupId, label: 'Group category' })}</td>
          <td class="do-quantity-cell"><input type="number" class="finance-line-input do-group-qty" value="${escA(Math.max(1, Number(item.groupHeaderQuantity) || 1))}" min="1" max="999" step="1" aria-label="Group quantity" onchange="deliveryOrderGroupQuantityChange('${escA(encodedGroupId)}',this.value)"></td>
          <td class="do-action-cell"><button type="button" class="finance-delete-line do-del" title="Delete group" aria-label="Delete group" onclick="return deliveryOrderDeleteLineGroup('${escA(encodedGroupId)}')">&times;</button></td>
        </tr>`;
      return header + members.map((row, memberIndex) => lineMarkup(
        row.item,
        row.index,
        true,
        memberIndex === members.length - 1
      )).join('');
    }).join('');

    const categoryHeader = showbaseLineWorkspace.categoryHeaderRowMarkup({
      colspan: 4,
      className: 'do-category-row',
      content: `<div class="do-category-heading-main">${showbaseLineWorkspace.categoryToggleMarkup({
        label: `${department} category`,
        collapsed,
        action: `deliveryOrderToggleCategory(${JSON.stringify(encodedDepartment)})`
      })}<span>${escapeHtml(department)} Department</span></div><span class="do-dept-count">${items.length}</span>`
    });
    return `
      <section class="${showbaseLineWorkspace.categorySectionClass({ className: 'do-department-section', collapsed })}" data-do-category="${escA(encodedDepartment)}">
        <table class="finance-lines-table do-line-table showbase-category-table">
          <colgroup><col><col class="do-category-column"><col class="do-quantity-column"><col class="do-action-column"></colgroup>
          <thead>
            ${categoryHeader}
            <tr class="do-column-row showbase-category-column-header">
              <th>Item</th>
              <th>Category</th>
              <th>Quantity</th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>
    `;
  };

  let body = getDoDepartmentList(depts, edits)
    .filter(department => (depts[department] || []).length)
    .map(department => sectionMarkup(department, depts[department]))
    .join('');
  if (!body) body = '<div class="no-items-message">No event items are assigned to this room.</div>';

  previewContainer.innerHTML = `
    <div class="do-items-container">
      <div class="do-toolbar">
        <div class="do-items-title">
          <h3>Items</h3>
          <span>${lineCount} line${lineCount === 1 ? '' : 's'} / ${unitCount} unit${unitCount === 1 ? '' : 's'}</span>
        </div>
        <div class="do-items-actions">
          <button type="button" class="btn do-reset-button" id="doResetEdits">Reset</button>
        </div>
      </div>
      ${deliveryOrderSubprojectTabsMarkup(event)}
      <div class="do-category-list showbase-category-stack">${body}</div>
      <div class="do-composer-toolbar">${addRow}</div>
    </div>
  `;

  document.getElementById('doResetEdits')?.addEventListener('click', async () => {
    if (!await showAppConfirm({
      title: 'Reset Delivery Order',
      message: 'Reset all Delivery Order item and document changes for this event?',
      confirmText: 'Reset',
      cancelText: 'Cancel',
      variant: 'warning'
    })) return;
    clearDoEdits(eventId);
    deliveryOrderEditorState.activeSubprojectId = '';
    deliveryOrderEditorState.collapsedCategories = {};
    showNotification('success', 'Delivery Order changes reset');
    await populateDeliveryOrderForm(event);
  });

  deliveryOrderEditorState.catalog = getDeliveryOrderAssetCatalog();
  setupDoItemDragHandlers(previewContainer, eventId);
}

function groupItemsByDepartment(event, subprojectId = null) {
  const departments = {};
  const ensureDept = (dept) => {
    const name = departmentCodeToDoName(dept);
    if (!departments[name]) departments[name] = [];
    return name;
  };

  getDefaultDoDepartments().forEach(ensureDept);

  const rooms = eventSubprojects(event);
  const selectedRooms = rooms.length
    ? (subprojectId == null
        ? rooms
        : rooms.filter(room => String(room.id || 'main') === String(subprojectId || 'main')))
    : [];

  const modelIdentity = value => [
    normalizeDepartmentCode(value?.departmentCode || value?.department || 'UN'),
    String(value?.brand || '').trim().toLocaleLowerCase(),
    String(value?.model || '').trim().toLocaleLowerCase(),
    String(value?.description || '').trim().toLocaleLowerCase()
  ].join('|');

  const roomSpareQuantity = (room, line) => {
    if (line?.isCustom) return 0;
    const extraRefs = new Set((room?.extraRefs || []).map(String));
    if (!extraRefs.size) return 0;
    const targetIdentity = modelIdentity(line);
    const countedRefs = new Set();
    let quantity = 0;
    Object.values(event?.modelGroups || {}).forEach(group => {
      if (modelIdentity(group) !== targetIdentity) return;
      (group.assignedAssets || []).forEach(asset => {
        const assetId = String(asset?.id || '');
        if (!extraRefs.has(assetId) || countedRefs.has(assetId)) return;
        countedRefs.add(assetId);
        quantity += Math.max(1, Number(asset?.quantity || 1));
      });
    });
    return quantity;
  };

  if (selectedRooms.length) {
    selectedRooms.forEach(room => {
      const roomId = String(room.id || 'main');
      (room.items || []).forEach((line, index) => {
        const dname = ensureDept(line.departmentCode || line.department || 'UN');
        const description = line.isCustom
          ? String(line.description || line.name || 'Custom item').trim()
          : [line.brand, line.model, line.description].filter(Boolean).join(' ').trim();
        departments[dname].push({
          key: `ROOM|${roomId}|${line.lineId || `${dname}|${line.brand || ''}|${line.model || ''}|${index}`}`,
          description,
          quantity: String(
            Math.max(0, Number(line.quantity || 0)) + roomSpareQuantity(room, line)
          ),
          brand: String(line.brand || '').trim(),
          model: String(line.model || '').trim(),
          assetRefs: [...new Set((line.assetRefs || []).map(String))],
          source: line.isCustom ? 'event-custom' : 'model',
          subprojectId: roomId
        });
      });
    });
  } else if (event.modelGroups && Object.keys(event.modelGroups).length) {
    Object.values(event.modelGroups).forEach(mg => {
      const dname = ensureDept(mg.department);
      const baseDesc = `${mg.brand || ''} ${mg.model || ''}${mg.description ? ' - ' + mg.description : ''}`.trim();
      departments[dname].push({
        key: makeModelKey(mg),
        description: baseDesc,
        quantity: String(
          Math.max(0, Number(mg.requiredQuantity || 0))
          + Math.max(0, Number(mg.extraPreparedQuantity || 0))
        ),
        brand: String(mg.brand || '').trim(),
        model: String(mg.model || '').trim(),
        assetRefs: [...new Set((mg.assignedAssets || []).map(asset => String(asset?.id || '')).filter(Boolean))],
        source: 'model'
      });
    });
  }

  // Legacy events without room requirements may only expose prepared custom markers.
  const groupedCustom = {};
  const addCustomToDo = (custom) => {
    if (!custom) return;
    const dname = ensureDept(custom.department || 'UN');
    const desc = custom.name || (custom.type === 'LOAN' ? 'Loan/Rental Item' : 'Misc Item');
    const key = `CUSTOM|${dname}|${custom.type}|${desc}`;
    if (!groupedCustom[key]) {
      groupedCustom[key] = {
        dept: dname,
        item: {
          key,
          description: desc,
          quantity: 0,
          source: 'custom-prepared'
        }
      };
    }
    groupedCustom[key].item.quantity += Number(custom.quantity || 1);
  };

  const preparedList = event.preparedItems || event.prepared_items || [];
  if (!rooms.length) preparedList.forEach(id => addCustomToDo(parseCustomAsset(id)));

  if (!rooms.length && event.assetsByDepartment) {
    Object.values(event.assetsByDepartment).forEach(list => {
      (list || []).forEach(asset => {
        const custom = parseCustomAsset(asset.id, asset);
        if (custom && !preparedList.includes(asset.id)) addCustomToDo(custom);
      });
    });
  }

  Object.values(groupedCustom).forEach(({ dept, item }) => {
    if (!departments[dept]) departments[dept] = [];
    departments[dept].push({ ...item, quantity: String(item.quantity) });
  });

  // These overlays belong only to the DO document; event requirements stay untouched.
  const eventId = event.id || event.event_id || event.eventId || window.currentEventId || '0';
  const edits = getDoEdits(eventId, Object.keys(departments));

  const regrouped = {};
  Object.keys(departments).forEach(d => {
    departments[d].forEach(item => {
      if (edits.deleted[item.key]) return;
      const ov = edits.overrides[item.key];
      const targetDepartment = ov?.department || d;
      regrouped[targetDepartment] ||= [];
      regrouped[targetDepartment].push({
        ...item,
        description: ov?.description || item.description,
        quantity: String(ov?.quantity ?? item.quantity)
      });
    });
  });
  Object.keys(departments).forEach(department => { departments[department] = []; });
  Object.entries(regrouped).forEach(([department, items]) => { departments[department] = items; });

  if (edits && edits.custom) {
    Object.keys(edits.custom).forEach(d => {
      if (!departments[d]) departments[d] = [];
      (edits.custom[d] || []).forEach(ci => {
        const itemSubprojectId = String(ci.subprojectId || 'main');
        if (subprojectId != null && itemSubprojectId !== String(subprojectId || 'main')) return;
        departments[d].push({
          key: `DOCUSTOM|${ci.id}`,
          customId: ci.id,
          description: ci.description,
          quantity: String(ci.quantity || 1),
          brand: ci.brand || '',
          model: ci.model || '',
          catalogKey: ci.catalogKey || '',
          sourceAssetIds: [...(ci.sourceAssetIds || [])],
          source: 'do-custom',
          subprojectId: itemSubprojectId,
          groupId: ci.groupId || '',
          groupTitle: ci.groupTitle || '',
          groupDisplayFields: Array.isArray(ci.groupDisplayFields) ? [...ci.groupDisplayFields] : [],
          groupCustomText: !!ci.groupCustomText,
          groupHeaderQuantity: Math.max(1, Number(ci.groupHeaderQuantity) || 1),
          isCustom: !!ci.isCustom
        });
      });
    });
  }

  getDoDepartmentList(departments, edits).forEach(d => {
    departments[d] ||= [];
    if (subprojectId == null && selectedRooms.length) {
      const ordered = [];
      const included = new Set();
      deliveryOrderSubprojects(event).forEach(room => {
        const roomId = String(room.id || 'main');
        const roomItems = departments[d].filter(item => (
          String(item.subprojectId || 'main') === roomId
        ));
        applyDoOrdering(roomItems, d, eventId, roomId).forEach(item => {
          if (included.has(item.key)) return;
          included.add(item.key);
          ordered.push(item);
        });
      });
      departments[d].forEach(item => {
        if (included.has(item.key)) return;
        included.add(item.key);
        ordered.push(item);
      });
      departments[d] = ordered;
    } else {
      departments[d] = applyDoOrdering(departments[d], d, eventId, subprojectId || 'all');
    }
  });

  return departments;
}

function getAssetIdsByItem(event, item, department, options = {}) {
    if (!item) return [];

    const assetRecords = Object.values(event?.assetsByDepartment || {})
        .flatMap(rows => Array.isArray(rows) ? rows : []);
    const recordsById = new Map(assetRecords
        .filter(asset => asset?.id)
        .map(asset => [String(asset.id), asset]));
    const isIndividualAssetId = value => {
        const id = String(value || '').trim();
        if (!id || id.startsWith('[BULK]') || id.startsWith('[MODEL]') || isCustomAssetId(id)) return false;
        const record = recordsById.get(id);
        return !record?.isBulk && record?.status !== 'returned';
    };
    const sortedUniqueIds = values => [...new Set((values || []).map(String).filter(isIndividualAssetId))]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const excludedSource = options.excludedIds;
    const excludedIds = excludedSource && typeof excludedSource.has === 'function'
        ? excludedSource
        : new Set((excludedSource || []).map(String));
    const deliveryOrderQuantity = Math.max(0, Number(item.quantity) || 0);
    const withinDeliveryOrderQuantity = values => sortedUniqueIds(values)
        .filter(id => !excludedIds.has(String(id)))
        .slice(0, deliveryOrderQuantity);

    // Room requirements carry the exact stable references assigned during planning.
    // Prefer those references so identical models in different rooms are not mixed.
    const linkedIds = withinDeliveryOrderQuantity(item.assetRefs);
    if (linkedIds.length || (item.assetRefs || []).length) return linkedIds;

    // Grouped inventory rows retain the inventory IDs represented by their
    // catalog selection. Only keep IDs that are actually prepared for this
    // event, and never print more IDs than the quantity on the DO line.
    const preparedSourceIds = withinDeliveryOrderQuantity(
        (item.sourceAssetIds || []).filter(id => recordsById.has(String(id)))
    );
    if (preparedSourceIds.length) return preparedSourceIds;

    // If stable catalog references are unavailable (older saved groups), match
    // prepared records by product identity as a backwards-compatible fallback.
    if (item.source === 'do-custom' && (item.brand || item.model)) {
        const inventoryById = new Map((assets || [])
            .filter(asset => asset?.id)
            .map(asset => [String(asset.id), asset]));
        const targetBrand = String(item.brand || '').trim().toLocaleLowerCase();
        const targetModel = String(item.model || '').trim().toLocaleLowerCase();
        const targetDescription = String(financeGroupedLineDescription(item) || '')
            .trim().toLocaleLowerCase();
        const matchingPreparedIds = assetRecords.filter(record => {
            const inventoryRecord = inventoryById.get(String(record?.id || '')) || {};
            const brand = String(record?.brand || inventoryRecord.brand || '').trim().toLocaleLowerCase();
            const model = String(record?.model || inventoryRecord.model || '').trim().toLocaleLowerCase();
            const description = String(record?.description || inventoryRecord.description || '').trim().toLocaleLowerCase();
            return (!targetBrand || brand === targetBrand)
                && (!targetModel || model === targetModel)
                && (!targetDescription || !description || description === targetDescription);
        }).map(record => record.id);
        const matchedIds = withinDeliveryOrderQuantity(matchingPreparedIds);
        if (matchedIds.length) return matchedIds;
    }

    if (!event?.assetsByDepartment || item.source !== 'model') return [];

    // Legacy events may not have room-level assetRefs. Match their prepared model
    // records using the retained model identity as a backwards-compatible fallback.
    const keyParts = String(item.key || '').split('|');
    const deptCode = normalizeDepartmentCode(
        keyParts[0] === 'MG'
            ? keyParts[1]
            : getDepartmentCodeForDoName(department)
    );
    const brand = String(item.brand || (keyParts[0] === 'MG' ? keyParts[2] : '')).trim();
    const model = String(item.model || (keyParts[0] === 'MG' ? keyParts[3] : '')).trim();
    if (!brand && !model) return [];

    return withinDeliveryOrderQuantity((event.assetsByDepartment[deptCode] || [])
        .filter(asset => (
            String(asset?.brand || '').trim() === brand
            && String(asset?.model || '').trim() === model
        ))
        .map(asset => asset.id));
}
