// Delivery Order workspace, editing, persistence, and PDF generation.

let currentDeliveryOrderEvent = null;
const deliveryOrderEditorState = {
  activeSubprojectId: '',
  dragSubprojectId: '',
  catalog: [],
  catalogMatches: [],
  selectedCatalogItem: null,
  editMode: false,
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
      saveDoEdits(eventId, workspace);
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

    deliveryOrderCaptureDocument(currentDeliveryOrderEvent.id || currentDeliveryOrderEvent.event_id || '0');
    await flushDoEdits(currentDeliveryOrderEvent.id || currentDeliveryOrderEvent.event_id || '0');
    await loadPdfSettings(true);

    generatePdfDO(deliveryOrderData);
}

function generatePdfDO(data) {
    // Format the date for display
    const formattedDate = new Date(data.doDate).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
    const themeColor = deliveryOrderPdfThemeColor();

    // Create a new window for the delivery order
    const doWindow = window.open('', '_blank', 'width=800,height=1000');

    // Generate pages content
    const pagesContent = generatePagesContent(data, formattedDate);

    // Get the HTML template with populated data
    const template = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Delivery Order - ${escapeHtml(data.jobTitle)}</title>
    <style>
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
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            line-height: 1.2;
            color: black;
            background: white;
        }

        .page {
            min-height: 240mm;
            page-break-after: avoid;
            position: relative;
            padding-bottom: 1mm;
        }

        .page-break {
            page-break-before: always;
            height: 0;
            margin: 0;
            padding: 0;
        }

        .page-break + .page {
            padding-top: 12mm;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 25px;
        }

        .header-left {
            flex: 1;
        }

        .header-right {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 5px;
            margin-right: 0;
            margin-top: -5px;
            margin-bottom: 2px;
        }

        .do-logo-row {
            display: flex;
            justify-content: flex-end;
            margin-bottom: 7px;
            height: 39px;
        }

        .do-logo-row img {
            height: 39px;
            width: auto;
            object-fit: contain;
        }

        .delivery-order-title {
            font-family: 'Century Gothic', sans-serif;
            font-size: 14pt;
            font-weight: bold;
            color: black;
            margin-bottom: 5;
            text-align: right;
            margin-top: 5;
        }

        .do-number {
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            color: black;
            text-align: left;
            margin-right: 46px;
            font-weight: bold;
            margin-bottom: 1;
        }

        .deliver-to {
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            font-weight: bold;
            color: black;
            margin-bottom: 2px;
        }

        .client-info {
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            color: black;
            font-weight: bold;
            margin-bottom: 1px;
        }

        .client-phone {
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            font-weight: bold;
            color: black;
            margin-bottom: 1px;
        }

        .items-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 30px;
            border: 2px solid black;
        }

        .items-table th {
            background-color: #333;
            color: white;
            padding: 8px;
            text-align: left;
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            font-weight: bold;
            border: 1px solid #333;
        }

        .items-table td {
            padding: 6px 8px;
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            color: black;
            vertical-align: top;
            word-break: break-word;
            overflow-wrap: anywhere;
        }

        .items-table td:first-child {
            border-right: 1px solid black;
            border-left: 1px solid black;
        }

        .items-table td:last-child {
            border-right: 1px solid black;
        }

        .job-title {
            font-weight: bold;
            background-color: #f5f5f5;
        }

        .department-header {
            font-weight: bold;
            color: black;
            background-color: #f0f0f0;
        }

        .quantity-col {
            text-align: center;
            width: 80px;
        }

        .comments-section {
            position: absolute;
            bottom: 5mm;
            left: 0;
            right: 0;
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            margin-top: 30px;
            margin-bottom: 30px;
        }

        .other-comments {
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            font-weight: bold;
            color: black;
        }

        .received-text {
            bottom: 5mm;
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            color: black;
        }

        .signature-line {
            bottom: 2mm;
            width: 210px;
            height: 60px;
            display: flex;
            flex-direction: column;
            justify-content: flex-end;
            align-items: center;
            font-family: 'Century Gothic', sans-serif;
            font-size: 9pt;
            color: black;
            margin-top: 20px;
        }

        .signature-line::before {
            content: "";
            border-bottom: 2px solid black;
            width: 100%;
            margin-bottom: 5px;
        }

        .footer {
            position: absolute;
            bottom: 10mm;
            left: 0;
            right: 0;
            text-align: center;
            font-family: 'Calibri', sans-serif;
            font-size: 7pt;
            color: black;
            line-height: 1.2;
            z-index: 100;
            overflow-wrap: anywhere;
        }

        .page-number {
            position: fixed;
            bottom: 5mm;
            right: 0;
            margin-right: 20px;
            font-family: 'Century Gothic', sans-serif;
            font-size: 7pt;
            color: black;
        }

        @media print {
            body {
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
            }

            .page {
                page-break-after: avoid;
                page-break-inside: avoid;
            }

            .page-break {
                page-break-before: always;
                display: block;
                height: 0;
            }

            @page { margin: 0; }
            html, body { margin: 0 !important; padding: 7mm !important; }
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
            table-layout: fixed;
            margin: 0;
            border: 0.5pt solid #cbd5e1;
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
            padding: 1.35mm 2.7mm;
            border: 0;
            border-bottom: 0.35pt solid #e2e8f0;
            color: #172033;
            font-size: 8pt;
            line-height: 1.2;
        }

        .items-table td:first-child,
        .items-table td:last-child {
            border-right: 0;
            border-left: 0;
        }

        .items-table tr:last-child td {
            border-bottom: 0;
        }

        .department-header {
            padding: 1.5mm 2.7mm !important;
            border-top: 0.5pt solid #cbd5e1 !important;
            border-bottom: 0.5pt solid #cbd5e1 !important;
            background: #f1f5f9;
            color: #172033;
            font-size: 7.2pt !important;
            text-transform: uppercase;
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
        }

        .signature-line {
            width: 62mm;
            height: 16mm;
            margin: 0;
            color: #475569;
            font-size: 7.5pt;
        }

        .signature-line::before {
            border-bottom: 0.7pt solid #172033;
        }

        .footer {
            position: absolute;
            bottom: 8mm;
            left: 13mm;
            right: 13mm;
            padding-top: 2mm;
            border-top: 0.5pt solid #cbd5e1;
            color: #64748b;
            font-family: 'Century Gothic', Arial, sans-serif;
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
            font-family: 'Century Gothic', sans-serif;
            font-size: 6.2pt;
            color: #64748b;
            z-index: 101;
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
    setTimeout(() => {
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
            <div class="do-letterhead">
                <div class="do-letterhead-brand"><img src="${escapeHtmlAttr(logoUrl)}" alt="Company logo"></div>
            </div>
        ` : '';
    }
    const companyName = String(pdfSettings?.companyName || '').trim();
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
        : `<div class="do-wordmark">${safe(companyName || 'Delivery Order')}</div>`;

    return `
        <div class="do-letterhead">
            <div class="do-letterhead-brand">${brandHtml}</div>
            <div class="do-letterhead-details">
                ${logoUrl && companyName ? `<strong>${safe(companyName)}</strong>` : ''}
                ${detailLines.map(line => `<div>${safe(line)}</div>`).join('')}
            </div>
        </div>
    `;
}

function renderDeliveryOrderDocumentHeaderHtml(data, formattedDate) {
    const safe = value => escapeHtml(String(value ?? ''));
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
        <div class="do-recipient-panel">
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
        </div>
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
    const documentHeaderHtml = renderDeliveryOrderDocumentHeaderHtml(data, formattedDate);
    const footerHtml = renderPdfFooterHtml();
    const themeColor = deliveryOrderPdfThemeColor();
    const tableColumnsHtml = '<colgroup><col><col class="quantity-column"></colgroup>';

    // A4 is 210mm x 297mm.
    // Page padding is 10mm top, 13mm left/right and 18mm bottom.
    // Normal pages reserve the measured footer height.
    // Last page reserves comments + signature + footer space.
    const PAGE_BODY_HEIGHT_MM = 269;
    const LAST_RESERVED_MM = 55;

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

    const renderDeptRow = (dept) => {
        return `
            <tr>
                <td class="department-header">${safe(deliveryOrderDepartmentHeaderLabel(dept))}</td>
                <td class="department-header quantity-col" aria-hidden="true"></td>
            </tr>
        `;
    };

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
        font-family:'Century Gothic', sans-serif;
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

            #__doMeasureBox .do-logo-row {
                display: flex;
                justify-content: flex-end;
                margin-bottom: 7px;
                height: 39px;
            }

            #__doMeasureBox .do-logo-row img {
                height: 39px;
                width: auto;
                object-fit: contain;
            }

            #__doMeasureBox .header {
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                margin-bottom: 25px;
            }

            #__doMeasureBox .header-left {
                flex: 1;
            }

            #__doMeasureBox .header-right {
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 5px;
                margin-right: 0;
                margin-top: -5px;
                margin-bottom: 2px;
            }

            #__doMeasureBox .delivery-order-title {
                font-family: 'Century Gothic', sans-serif;
                font-size: 14pt;
                font-weight: bold;
                color: black;
                margin-bottom: 5px;
                text-align: right;
                margin-top: 5px;
            }

            #__doMeasureBox .do-number,
            #__doMeasureBox .deliver-to,
            #__doMeasureBox .client-info,
            #__doMeasureBox .client-phone {
                font-family: 'Century Gothic', sans-serif;
                font-size: 9pt;
                color: black;
                font-weight: bold;
            }

            #__doMeasureBox .items-table,
            #__doMeasureBox .do-measure-table {
                width: 100%;
                border-collapse: collapse;
                border: 2px solid black;
                margin-bottom: 0;
            }

            #__doMeasureBox .items-table th,
            #__doMeasureBox .do-measure-table th {
                background-color: #333;
                color: white;
                padding: 8px;
                text-align: left;
                font-family: 'Century Gothic', sans-serif;
                font-size: 9pt;
                font-weight: bold;
                border: 1px solid #333;
            }

            #__doMeasureBox .items-table td,
            #__doMeasureBox .do-measure-table td {
                padding: 6px 8px;
                font-family: 'Century Gothic', sans-serif;
                font-size: 9pt;
                color: black;
                vertical-align: top;
                word-break: break-word;
                overflow-wrap: anywhere;
            }

            #__doMeasureBox .items-table td:first-child,
            #__doMeasureBox .do-measure-table td:first-child {
                border-right: 1px solid black;
                border-left: 1px solid black;
            }

            #__doMeasureBox .items-table td:last-child,
            #__doMeasureBox .do-measure-table td:last-child {
                border-right: 1px solid black;
            }

            #__doMeasureBox .job-title {
                font-weight: bold;
                background-color: #f5f5f5;
            }

            #__doMeasureBox .department-header {
                font-weight: bold;
                color: black;
                background-color: #f0f0f0;
            }

            #__doMeasureBox .quantity-col {
                text-align: center;
                width: 80px;
            }

            #__doMeasureBox .footer-measure {
                width: 100%;
                text-align: center;
                font-family: 'Calibri', sans-serif;
                font-size: 7pt;
                line-height: 1.2;
                overflow-wrap: anywhere;
            }

            #__doMeasureBox .do-letterhead { min-height:15mm;display:flex;justify-content:space-between;align-items:flex-start;gap:12mm;margin-bottom:8mm; }
            #__doMeasureBox .do-letterhead-brand { flex:0 0 auto;min-width:40mm; }
            #__doMeasureBox .do-letterhead-brand img { display:block;width:auto;max-width:42mm;height:auto;max-height:14mm;object-fit:contain; }
            #__doMeasureBox .do-wordmark { max-width:75mm;color:#172033;font-size:15pt;line-height:1.05;font-weight:700; }
            #__doMeasureBox .do-letterhead-details { max-width:88mm;color:#64748b;font-size:6.5pt;line-height:1.35;text-align:right; }
            #__doMeasureBox .do-letterhead-details strong { display:block;margin-bottom:1mm;color:#172033;font-size:8.5pt;line-height:1.2; }
            #__doMeasureBox .do-title-row { display:flex;align-items:flex-end;justify-content:space-between;gap:10mm;padding-bottom:3mm;border-bottom:.6pt solid #cbd5e1; }
            #__doMeasureBox .delivery-order-title { margin:0;color:#172033;font-size:20pt;line-height:1;text-align:left; }
            #__doMeasureBox .do-number { margin:0;color:${themeColor};font-size:12pt;line-height:1.1;text-align:right; }
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
            #__doMeasureBox .items-table td,#__doMeasureBox .do-measure-table td { padding:1.35mm 2.7mm;border:0;border-bottom:.35pt solid #e2e8f0;color:#172033;font-size:8pt;line-height:1.2;vertical-align:top;word-break:break-word;overflow-wrap:anywhere; }
            #__doMeasureBox .department-header { padding:1.5mm 2.7mm!important;border-top:.5pt solid #cbd5e1!important;border-bottom:.5pt solid #cbd5e1!important;background:#f1f5f9;color:#172033;font-size:7.2pt!important;text-transform:uppercase; }
            #__doMeasureBox .quantity-col { width:22mm;border-left:.5pt solid #cbd5e1!important;text-align:right; }
            #__doMeasureBox .quantity-column { width:22mm; }
            #__doMeasureBox .asset-id-line { display:block;margin-top:.5mm;color:#64748b;font-size:6.5pt;font-style:normal; }
            #__doMeasureBox .footer-measure { width:100%;color:#64748b;font-size:6.2pt;line-height:1.25;text-align:left;overflow-wrap:anywhere; }
        </style>

        <div id="__doBaseMeasure">
            ${documentHeaderHtml}
            <table class="items-table">
                ${tableColumnsHtml}
                <thead>
                    <tr>
                        <th class="description-header">DESCRIPTION</th>
                        <th class="quantity-header">QUANTITY</th>
                    </tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>

        <table class="do-measure-table">
            ${tableColumnsHtml}
            <tbody id="__doMeasureBody"></tbody>
        </table>

        <div id="__doFooterMeasure" class="footer-measure">${footerHtml}</div>
    `;

    const normaliseMeasuredHeight = mountPdfMeasureBox(measureBox, 184);

    const measureBody = measureBox.querySelector('#__doMeasureBody');
    const baseHeight = normaliseMeasuredHeight(
        measureBox.querySelector('#__doBaseMeasure').getBoundingClientRect().height
    );
    const footerHeight = normaliseMeasuredHeight(
        measureBox.querySelector('#__doFooterMeasure')?.getBoundingClientRect().height || 0
    );
    const normalReservedMm = pdfFooterReserveMm({
        pageFlowHeightMm: PAGE_BODY_HEIGHT_MM,
        topPaddingMm: 10,
        footerBottomMm: 8
    }, footerHeight);

    const normalPageRowBudget = Math.max(
        50,
        pdfMmToPx(PAGE_BODY_HEIGHT_MM - normalReservedMm) - baseHeight
    );

    const lastPageRowBudget = Math.max(
        50,
        pdfMmToPx(PAGE_BODY_HEIGHT_MM - Math.max(LAST_RESERVED_MM, normalReservedMm)) - baseHeight
    );

    function measureRow(rowHtml) {
        measureBody.innerHTML = rowHtml;
        const row = measureBody.querySelector('tr');
        return row ? normaliseMeasuredHeight(row.getBoundingClientRect().height) : 0;
    }

    const deptHeights = {};
    const records = [];

    Object.keys(departments).forEach(dept => {
        const deptItems = departments[dept] || [];
        if (deptItems.length === 0) return;

        deptHeights[dept] = measureRow(renderDeptRow(dept));

        deptItems.forEach(item => {
            const assetIds = data.showAssetIds
                ? getAssetIdsByItem(data.event, item, dept)
                : [];

            const record = {
                dept,
                item: {
                    ...item,
                    assetIds
                },
                height: 0
            };

            record.height = measureRow(renderItemRow(record));
            records.push(record);
        });
    });

    measureBox.remove();

    function costToAdd(page, record) {
        const needsDeptHeader = page.lastDept !== record.dept;
        return (needsDeptHeader ? deptHeights[record.dept] : 0) + record.height;
    }

    function canFitRemaining(startIndex, budget) {
        const testPage = {
            records: [],
            height: 0,
            lastDept: null
        };

        for (let i = startIndex; i < records.length; i++) {
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

    function fillPage(startIndex, budget) {
        const page = {
            records: [],
            height: 0,
            lastDept: null
        };

        let i = startIndex;

        while (i < records.length) {
            const record = records[i];
            const cost = costToAdd(page, record);

            if (page.records.length > 0 && page.height + cost > budget) {
                break;
            }

            // If one single row is taller than the available area,
            // keep it on the page instead of creating an infinite loop.
            if (page.records.length === 0 && cost > budget) {
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

        while (index < records.length) {
            const remainingCanBeLastPage = canFitRemaining(index, lastPageRowBudget);
            const budget = remainingCanBeLastPage ? lastPageRowBudget : normalPageRowBudget;

            const result = fillPage(index, budget);
            pages.push(result.page);
            index = result.nextIndex;
        }
    }

    let pagesHtml = '';
    const totalPages = pages.length;

    pages.forEach((page, pageIndex) => {
        const isLastPage = pageIndex === totalPages - 1;
        const pageNumber = pageIndex + 1;

        pagesHtml += `
            <div class="page">
                ${documentHeaderHtml}
                <table class="items-table">
                    ${tableColumnsHtml}
                    <thead>
                        <tr>
                            <th class="description-header">DESCRIPTION</th>
                            <th class="quantity-header">QUANTITY</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        let currentDept = null;

        page.records.forEach(record => {
            if (record.dept !== currentDept) {
                pagesHtml += renderDeptRow(record.dept);
                currentDept = record.dept;
            }

            pagesHtml += renderItemRow(record);
        });

        pagesHtml += `
                    </tbody>
                </table>
        `;

        if (isLastPage) {
            pagesHtml += `
                <div class="comments-section">
                    <div class="other-comments"><strong>Other comments:</strong> ${safe(data.additionalComments || '-')}</div>
                    <div class="received-text">Received in good order & condition</div>
                </div>

                <div class="signature-holder">
                    <div class="signature-line">
                        Company's Stamp & Signature
                    </div>
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
  saveDoEdits(eventId, state);
  return true;
}

function applyDoOrdering(items, dept, eventId, subprojectId = '') {
  const state = getDoEdits(eventId);
  const ordering = normaliseDoOrdering(
    items,
    state.ordering?.[deliveryOrderOrderingKey(subprojectId, dept)]
  );
  if (!ordering) return items;
  const orderedItems = [];
  const itemsMap = new Map(items.map(item => [item.key, item]));
  ordering.forEach(key => {
    const item = itemsMap.get(key);
    if (item) {
      orderedItems.push(item);
      itemsMap.delete(key);
    }
  });
  itemsMap.forEach(item => orderedItems.push(item));
  return orderedItems;
}

function setupDoItemDragHandlers(previewContainer, eventId) {
  let draggedIndex = null;
  let draggedDept = null;
  let draggedSubprojectId = '';

  previewContainer.querySelectorAll('.do-item-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      draggedIndex = Number(row.dataset.index);
      draggedDept = row.dataset.dept;
      draggedSubprojectId = row.dataset.subprojectId || '';
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-showbase-delivery-order-line', String(draggedIndex));
    });

    row.addEventListener('dragend', () => {
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

function deliveryOrderDepartmentOptions(selected, names = []) {
  const options = new Set([...getDefaultDoDepartments(), ...names, selected].filter(Boolean));
  return Array.from(options).sort((a, b) => a.localeCompare(b)).map(name =>
    `<option value="${escapeHtmlAttr(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`
  ).join('');
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
  saveDoEdits(eventId, state);
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
    results.innerHTML = '';
    return;
  }
  deliveryOrderEditorState.catalogMatches = deliveryOrderEditorState.catalog.filter(item =>
    [item.label, item.detail, item.brand, item.model, item.department, ...(item.tags || [])]
      .join(' ').toLowerCase().includes(query)
  ).slice(0, 12);
  results.innerHTML = deliveryOrderEditorState.catalogMatches.map((item, index) => `
    <button type="button" class="do-catalog-result" onclick="deliveryOrderSelectCatalogItem(${index})">
      <strong>${escapeHtml(item.label)}</strong>
      <span>${escapeHtml([item.detail, item.department].filter(Boolean).join(' / '))}</span>
    </button>
  `).join('') || '<div class="do-empty-dept">No inventory match. This can be added as a custom DO item.</div>';
}

function deliveryOrderSelectCatalogItem(index) {
  const item = deliveryOrderEditorState.catalogMatches[Number(index)];
  if (!item) return;
  deliveryOrderEditorState.selectedCatalogItem = item;
  const search = document.getElementById('doCatalogSearch');
  const category = document.getElementById('doCatalogDepartment');
  const results = document.getElementById('doCatalogResults');
  if (search) search.value = [item.label, item.detail].filter(Boolean).join(' - ');
  if (category) category.value = item.department;
  if (results) results.innerHTML = '';
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
  `).join('');
}

function deliveryOrderSelectDepartment(name) {
  const input = document.getElementById('doCatalogDepartment');
  const results = document.getElementById('doCatalogDepartmentResults');
  if (input) input.value = name;
  if (results) results.innerHTML = '';
}

function deliveryOrderAddCatalogItem() {
  const event = currentDeliveryOrderEvent;
  if (!event) return;
  const eventId = event.id || event.event_id || '0';
  const search = document.getElementById('doCatalogSearch');
  const category = document.getElementById('doCatalogDepartment');
  const quantityInput = document.getElementById('doCatalogQuantity');
  const description = search?.value.trim();
  if (!description) {
    showNotification('warning', 'Enter or select an asset first');
    search?.focus();
    return;
  }
  const selected = deliveryOrderEditorState.selectedCatalogItem;
  const department = category?.value.trim() || selected?.department || 'MISC';
  const state = getDoEdits(eventId);
  state.custom[department] ||= [];
  state.custom[department].push({
    id: makeDoCustomItemId(),
    description,
    quantity: Math.max(1, Number(quantityInput?.value) || 1),
    brand: selected?.brand || '',
    model: selected?.model || '',
    catalogKey: selected?.catalogKey || '',
    sourceAssetIds: [...(selected?.sourceAssetIds || [])],
    subprojectId: deliveryOrderActiveSubprojectId(event)
  });
  saveDoEdits(eventId, state);
  showNotification('success', 'Item added to the delivery order');
  populateDeliveryItemsPreview(event);
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
  const editMode = !!deliveryOrderEditorState.editMode;
  const populatedDepartments = Object.values(depts).filter(items => items.length);
  const lineCount = populatedDepartments.reduce((total, items) => total + items.length, 0);
  const unitCount = populatedDepartments.reduce((total, items) => (
    total + items.reduce((subtotal, item) => subtotal + (Number(item.quantity) || 0), 0)
  ), 0);
  const escA = value => (typeof escapeHtmlAttr === 'function' ? escapeHtmlAttr(value) : escapeHtml(value));

  const addRow = editMode ? showbaseLineWorkspace.addRowMarkup({
    mode: 'delivery-order',
    className: 'do-catalog-composer',
    search: {
      id: 'doCatalogSearch',
      resultsId: 'doCatalogResults',
      placeholder: 'Search inventory or enter an item',
      oninput: 'deliveryOrderRenderCatalogResults()',
      onkeydown: "if(event.key==='Enter'){event.preventDefault();deliveryOrderAddCatalogItem();}"
    },
    category: {
      id: 'doCatalogDepartment',
      resultsId: 'doCatalogDepartmentResults',
      value: 'MISC',
      placeholder: 'Category',
      oninput: 'deliveryOrderRenderDepartmentSuggestions()',
      onfocus: 'deliveryOrderRenderDepartmentSuggestions()',
      onblur: "setTimeout(()=>deliveryOrderSelectDepartment(document.getElementById('doCatalogDepartment')?.value||'MISC'),120)"
    },
    extraMarkup: '<input id="doCatalogQuantity" class="finance-input do-catalog-quantity" type="number" min="1" max="999" value="1" aria-label="Quantity">',
    addAction: 'deliveryOrderAddCatalogItem()',
    showGroup: false
  }) : '';

  const sectionMarkup = (department, items) => {
    const encodedDepartment = encodeURIComponent(department);
    const collapseKey = `${eventId}::${subprojectId}::${department}`;
    const collapsed = !!deliveryOrderEditorState.collapsedCategories[collapseKey];
    const rows = items.map((item, index) => editMode ? `
      <tr class="do-item-row do-edit-row" draggable="true"
          data-key="${escA(item.key)}"
          data-custom-id="${escA(item.customId || '')}"
          data-kind="${escA(item.source || '')}"
          data-dept="${escA(department)}"
          data-subproject-id="${escA(subprojectId)}"
          data-index="${index}">
        <td class="do-item-cell">
          <div class="do-edit-item">
            <span class="do-drag-handle" title="Drag to reorder" aria-label="Drag to reorder"><i></i><i></i><i></i><i></i><i></i><i></i></span>
            <div class="do-edit-fields">
              <input type="text" class="do-desc form-input" value="${escA(item.description)}" placeholder="Item">
              <select class="do-dept form-input" aria-label="Category">${deliveryOrderDepartmentOptions(department, getDoDepartmentList(depts, edits))}</select>
            </div>
          </div>
        </td>
        <td class="do-quantity-cell"><input type="number" class="do-qty form-input" value="${escA(item.quantity)}" min="1" max="999"></td>
        <td class="do-action-cell">
          <button type="button" class="btn do-save">Save</button>
          <button type="button" class="btn do-del" title="Remove line" aria-label="Remove line" onclick="return removeDeliveryOrderRow(this)">&times;</button>
        </td>
      </tr>
    ` : `
      <tr class="do-item-row">
        <td class="do-item-cell">${escapeHtml(item.description)}</td>
        <td class="do-quantity-cell"><span class="do-quantity-badge">${escapeHtml(item.quantity)}</span></td>
      </tr>
    `).join('');

    const categoryHeader = showbaseLineWorkspace.categoryHeaderRowMarkup({
      colspan: editMode ? 3 : 2,
      className: 'do-category-row',
      content: `<div class="do-category-heading-main">${showbaseLineWorkspace.categoryToggleMarkup({
        label: `${department} category`,
        collapsed,
        action: `deliveryOrderToggleCategory(${JSON.stringify(encodedDepartment)})`
      })}<span>${escapeHtml(department)} Department</span></div><span class="do-dept-count">${items.length}</span>`
    });
    return `
      <section class="${showbaseLineWorkspace.categorySectionClass({ className: 'do-department-section', collapsed })}" data-do-category="${escA(encodedDepartment)}">
        <table class="do-line-table showbase-category-table">
          <thead>
            ${categoryHeader}
            <tr class="do-column-row showbase-category-column-header">
              <th>Item</th>
              <th>Quantity</th>
              ${editMode ? '<th aria-label="Actions"></th>' : ''}
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
          <label class="do-edit-toggle">
            <input type="checkbox" id="doEditToggle"${editMode ? ' checked' : ''}>
            <span class="do-toggle-control" aria-hidden="true"></span>
            <span>Edit</span>
          </label>
          <button type="button" class="btn do-reset-button" id="doResetEdits">Reset</button>
        </div>
      </div>
      ${deliveryOrderSubprojectTabsMarkup(event)}
      ${addRow ? `<div class="do-composer-toolbar">${addRow}</div>` : ''}
      <div class="do-category-list showbase-category-stack">${body}</div>
    </div>
  `;

  document.getElementById('doEditToggle')?.addEventListener('change', eventChange => {
    deliveryOrderEditorState.editMode = !!eventChange.currentTarget.checked;
    populateDeliveryItemsPreview(event);
  });
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
  previewContainer.querySelectorAll('.do-save').forEach(button => {
    button.addEventListener('click', () => {
      const row = button.closest('.do-item-row');
      const key = row?.dataset.key || '';
      const kind = row?.dataset.kind || '';
      const customId = row?.dataset.customId || '';
      const sourceDepartment = row?.dataset.dept || 'MISC';
      const targetDepartment = row?.querySelector('.do-dept')?.value || sourceDepartment;
      const description = row?.querySelector('.do-desc')?.value.trim() || '';
      const quantity = Math.max(1, Number(row?.querySelector('.do-qty')?.value) || 1);
      if (!description) {
        showNotification('warning', 'Item is required');
        return;
      }

      const state = getDoEdits(eventId);
      if (kind.startsWith('do-custom')) {
        let savedItem = null;
        Object.keys(state.custom || {}).some(department => {
          const index = state.custom[department].findIndex(item => item.id === customId);
          if (index < 0) return false;
          savedItem = { ...state.custom[department][index], description, quantity };
          state.custom[department].splice(index, 1);
          return true;
        });
        if (savedItem) {
          state.custom[targetDepartment] ||= [];
          state.custom[targetDepartment].push(savedItem);
        }
      } else {
        state.overrides[key] = { description, quantity, department: targetDepartment };
      }
      saveDoEdits(eventId, state);
      showNotification('success', 'Delivery Order item updated');
      populateDeliveryItemsPreview(event);
    });
  });

  if (editMode) setupDoItemDragHandlers(previewContainer, eventId);
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
          quantity: String(line.quantity || 0),
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
        quantity: String(mg.requiredQuantity || 0),
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
          subprojectId: itemSubprojectId
        });
      });
    });
  }

  getDoDepartmentList(departments, edits).forEach(d => {
    departments[d] ||= [];
    departments[d] = applyDoOrdering(departments[d], d, eventId, subprojectId || 'all');
  });

  return departments;
}

function getAssetIdsByItem(event, item, department) {
    const assetIds = [];
    if (!event.assetsByDepartment || !item || item.source !== 'model') return assetIds;

    const keyParts = String(item.key || '').split('|');
    if (keyParts.length < 4) return assetIds;

    // makeModelKey format: MG|department|brand|model
    const deptCodeFromKey = normalizeDepartmentCode(keyParts[1] || getDepartmentCodeForDoName(department));
    const brand = keyParts[2] || '';
    const model = keyParts[3] || '';

    const departmentAssets = event.assetsByDepartment[deptCodeFromKey] || [];
    departmentAssets.forEach(asset => {
        if (!asset || !asset.id) return;
        if (asset.isBulk || String(asset.id).startsWith('[BULK]') || isCustomAssetId(asset.id) || String(asset.id).startsWith('[MODEL]')) return;
        if (asset.status === 'returned') return;

        if (asset.brand === brand && asset.model === model) {
            assetIds.push(asset.id);
        }
    });

    return assetIds.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}
