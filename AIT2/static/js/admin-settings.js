// Administration, company settings, departments, and user management.

// ---------------- PDF Settings ----------------
function normalisePdfSettings(settings = {}) {
  return {
    footerText: typeof settings.footerText === 'string' ? settings.footerText : DEFAULT_PDF_FOOTER_TEXT,
    logoUrl: settings.logoUrl || "",
    hasCustomLogo: !!settings.hasCustomLogo,
    logoOriginalName: settings.logoOriginalName || "",
    companyName: settings.companyName || "",
    registrationNumber: settings.registrationNumber || "",
    billingAddress: settings.billingAddress || "",
    phone: settings.phone || "",
    email: settings.email || "",
    website: settings.website || "",
    bankName: settings.bankName || "",
    bankAccountName: settings.bankAccountName || "",
    bankAccountNumber: settings.bankAccountNumber || "",
    paynowUen: settings.paynowUen || "",
    paymentDetailsText: typeof settings.paymentDetailsText === 'string' ? settings.paymentDetailsText : "",
    paymentDetailsEnabled: settings.paymentDetailsEnabled !== false,
    currency: settings.currency || "SGD",
    taxLabel: settings.taxLabel || "GST",
    taxRate: Number(settings.taxRate || 0),
    quotationPrefix: settings.quotationPrefix || "QT",
    invoicePrefix: settings.invoicePrefix || "INV",
    defaultPaymentTerms: settings.defaultPaymentTerms || "30 Days",
    defaultValidityDays: Number(settings.defaultValidityDays || 30),
    defaultTerms: settings.defaultTerms || "",
    themeColor: /^#[0-9A-Fa-f]{6}$/.test(settings.themeColor || '') ? settings.themeColor : "#0f766e",
    letterheadText: typeof settings.letterheadText === 'string' ? settings.letterheadText : "",
    letterheadEnabled: settings.letterheadEnabled !== false,
    updatedAt: settings.updatedAt || ""
  };
}

function getPdfLogoUrl() {
  return (pdfSettings && pdfSettings.logoUrl) || "";
}

function getPdfFooterText() {
  return pdfSettings && typeof pdfSettings.footerText === 'string'
    ? pdfSettings.footerText
    : DEFAULT_PDF_FOOTER_TEXT;
}

function renderPdfFooterHtml() {
  const text = getPdfFooterText();
  if (!text) return '';
  return text.split(/\r?\n/).map(line => escapeHtml(line)).join('<br>');
}

function renderPdfLogoRowHtml(className = 'logo-row') {
  const logoUrl = getPdfLogoUrl();
  if (!logoUrl) return '';
  return `<div class="${escapeHtmlAttr(className)}"><img src="${escapeHtmlAttr(logoUrl)}" alt="Company Logo"></div>`;
}

function pdfMmToPx(mm) {
  return (Number(mm || 0) * 96) / 25.4;
}

function mountPdfMeasureBox(measureBox, measureWidthMm) {
  // The application body is displayed with CSS zoom, but print windows render
  // at full scale. Mount beside the body and normalise any remaining scaling.
  const measureRoot = document.documentElement || document.body;
  measureRoot.appendChild(measureBox);

  const expectedWidth = pdfMmToPx(measureWidthMm);
  const renderedWidth = measureBox.getBoundingClientRect().width;
  const measurementScale = renderedWidth > 0 && expectedWidth > 0
    ? renderedWidth / expectedWidth
    : 1;

  return height => Number(height || 0) / measurementScale;
}

function pdfFooterReserveMm(pageConfig, footerHeightPx) {
  const pageHeightMm = Number(pageConfig.pageHeightMm || 297);
  const pageFlowHeightMm = Number(pageConfig.pageFlowHeightMm || 276);
  const topPaddingMm = Number(pageConfig.topPaddingMm ?? 7);
  const footerBottomMm = Number(pageConfig.footerBottomMm ?? 7);
  const footerGapMm = Number(pageConfig.footerGapMm ?? 2);
  const minReserveMm = Math.max(0, Number(pageConfig.minReserveMm ?? 6));
  const footerHeightMm = Math.max(0, Number(footerHeightPx || 0) * 25.4 / 96);
  const safeFlowHeightMm = pageHeightMm - topPaddingMm - footerBottomMm - footerHeightMm - footerGapMm;
  return Math.max(minReserveMm, pageFlowHeightMm - safeFlowHeightMm, 0);
}

function applyPdfSettingsToApp() {
  const logo = document.getElementById('company-logo');
  if (logo) {
    const logoUrl = getPdfLogoUrl();
    if (logoUrl) {
      logo.src = logoUrl;
      logo.style.display = '';
    } else {
      logo.removeAttribute('src');
      logo.style.display = 'none';
    }
  }
}

async function loadPdfSettings(force = false) {
  if (!force && pdfSettingsLoaded) {
    return pdfSettings;
  }

  try {
    const res = await apiCall('/api/pdf-settings');
    pdfSettings = normalisePdfSettings(res.data || {});
  } catch (error) {
    console.warn('PDF settings not loaded:', error);
    pdfSettings = normalisePdfSettings(pdfSettings);
  }
  pdfSettingsLoaded = true;

  applyPdfSettingsToApp();
  renderPdfSettingsForm();
  return pdfSettings;
}

async function setupPdfSettingsTab() {
  if (!isAdminUser()) {
    removePdfSettingsTab();
    ensurePersonalNotificationsNavItem();
    ensurePersonalNotificationsSection();
    return;
  }

  ensurePdfSettingsNavItem();
  ensurePdfSettingsSection();
  renderPdfSettingsForm();
}

function removePdfSettingsTab() {
  const tab = document.querySelector(`[data-section="pdf-settings"], [onclick="showSection('pdf-settings')"]`);
  if (tab) tab.remove();

  const section = document.getElementById('pdf-settings-section');
  if (section) section.remove();
}

function ensurePdfSettingsNavItem() {
  if (document.querySelector(`[data-section="pdf-settings"], [onclick="showSection('pdf-settings')"]`)) return;

  const settingsSection = Array.from(document.querySelectorAll('.nav-section'))
    .find(section => {
      const heading = section.querySelector('h3');
      return heading && heading.textContent.trim() === 'Settings';
    });

  if (!settingsSection) {
    console.warn('Could not find Settings section for Company Details tab');
    return;
  }

  const pdfSettingsTab = document.createElement('button');
  pdfSettingsTab.type = 'button';
  pdfSettingsTab.className = 'nav-item';
  pdfSettingsTab.dataset.section = 'pdf-settings';
  pdfSettingsTab.textContent = '🏢 Company Details';

  const logoutButton = settingsSection.querySelector(`[onclick="logout()"]`);

  if (logoutButton) {
    settingsSection.insertBefore(pdfSettingsTab, logoutButton);
  } else {
    settingsSection.appendChild(pdfSettingsTab);
  }
}

function ensurePersonalNotificationsNavItem() {
  if (document.querySelector(`[data-section="notifications"]`)) return;
  const settingsSection = Array.from(document.querySelectorAll('.nav-section'))
    .find(section => section.querySelector('h3')?.textContent.trim() === 'Settings');
  if (!settingsSection) return;
  const notificationTab = document.createElement('button');
  notificationTab.type = 'button';
  notificationTab.className = 'nav-item';
  notificationTab.dataset.section = 'notifications';
  notificationTab.textContent = 'Notifications';
  const logoutButton = settingsSection.querySelector(`[onclick="logout()"]`);
  settingsSection.insertBefore(notificationTab, logoutButton || null);
}

function ensurePersonalNotificationsSection() {
  if (document.getElementById('notifications-section')) return;
  const firstSection = document.querySelector('.content-section');
  const sectionParent = firstSection ? firstSection.parentElement : document.body;
  const section = document.createElement('div');
  section.id = 'notifications-section';
  section.className = 'content-section';
  section.innerHTML = `
    <div class="content-header settings-page-header">
      <div>
        <h2 class="content-title">Notifications</h2>
        <p class="settings-page-subtitle">Connect your personal Telegram account and choose the alerts relevant to your role.</p>
      </div>
    </div>
    <div class="company-details-form">
      <section class="company-notifications" aria-labelledby="personalNotificationsHeading">
        <div class="company-details-section-heading">
          <div><h3 id="personalNotificationsHeading">Personal notifications</h3><p>Your connection belongs only to your signed-in account.</p></div>
        </div>
        <div id="companyNotificationSettings" class="company-notification-content" aria-live="polite">
          <div class="company-storage-loading">Loading notification settings...</div>
        </div>
      </section>
    </div>`;
  sectionParent.appendChild(section);
}

function loadNotificationSettingsSection() {
  return loadAdminNotificationSettings(false);
}

let companyDetailsActiveTab = 'details';
let companyStorageUsageLoaded = false;
let adminNotificationSettings = null;
let companyNotificationSettingsLoaded = false;
let telegramConnectionPollTimer = null;
let telegramConnectionPending = false;

function showCompanyDetailsTab(tabName) {
  const nextTab = ['details', 'storage', 'notifications'].includes(tabName)
    ? tabName
    : 'details';
  companyDetailsActiveTab = nextTab;
  document.querySelectorAll('#pdf-settings-section [data-company-details-tab]').forEach(button => {
    const isActive = button.dataset.companyDetailsTab === nextTab;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
    button.tabIndex = isActive ? 0 : -1;
  });
  document.querySelectorAll('#pdf-settings-section [data-company-details-panel]').forEach(panel => {
    const isActive = panel.dataset.companyDetailsPanel === nextTab;
    panel.hidden = !isActive;
    panel.classList.toggle('active', isActive);
  });
  if (nextTab === 'storage') loadCompanyStorageUsage(false);
  if (nextTab === 'notifications') loadAdminNotificationSettings(false);
}

function ensurePdfSettingsSection() {
  if (document.getElementById('pdf-settings-section')) return;

  const firstSection = document.querySelector('.content-section');
  const sectionParent = firstSection ? firstSection.parentElement : document.body;

  const section = document.createElement('div');
  section.id = 'pdf-settings-section';
  section.className = 'content-section';

  section.innerHTML = `
    <div class="content-header company-details-page-header">
      <div>
        <h2 class="content-title">Company Details</h2>
        <p>Manage the company identity, document defaults and storage usage.</p>
      </div>
    </div>

    <div class="company-details-tabs" role="tablist" aria-label="Company settings">
      <button type="button" class="company-details-tab active" data-company-details-tab="details" role="tab" aria-selected="true" onclick="showCompanyDetailsTab('details')">
        ${settingsIcon('building')}<span>Company details</span>
      </button>
      <button type="button" class="company-details-tab" data-company-details-tab="storage" role="tab" aria-selected="false" tabindex="-1" onclick="showCompanyDetailsTab('storage')">
        ${settingsIcon('storage')}<span>Storage usage</span>
      </button>
      <button type="button" class="company-details-tab" data-company-details-tab="notifications" role="tab" aria-selected="false" tabindex="-1" onclick="showCompanyDetailsTab('notifications')">
        ${settingsIcon('bell')}<span>Notifications</span>
      </button>
    </div>

    <div class="company-details-form">
      <div class="company-details-tab-panel active" data-company-details-panel="details" role="tabpanel">
        <div class="company-details-workspace">
          <aside class="company-details-brand-panel" aria-labelledby="companyLogoHeading">
            <div class="company-details-section-heading">
              <div>
                <h3 id="companyLogoHeading">Company logo</h3>
                <p>Used across the app and exported documents.</p>
              </div>
            </div>
          <div class="company-logo-dropzone">
            <img id="pdfSettingsLogoPreview" alt="Company logo">
            <span id="pdfSettingsLogoPlaceholder">No logo uploaded</span>
          </div>
          <input id="pdfSettingsLogoInput" class="company-logo-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
          <div class="company-logo-actions">
            <button type="button" class="btn btn-primary" onclick="uploadPdfSettingsLogo()">${settingsIcon('upload')}<span>Upload</span></button>
            <button type="button" class="btn btn-secondary" onclick="resetPdfSettingsLogo()">Remove</button>
          </div>
          <div id="pdfSettingsLogoName" class="company-logo-name"></div>
          </aside>

          <main class="company-details-fields">
          <section class="company-details-section">
            <div class="company-details-section-heading">
              <div><h3>Business identity</h3><p>Core contact details shown to clients.</p></div>
            </div>
            <div class="company-details-grid">
              <label class="form-group company-details-span-2"><span class="form-label">Company name</span><input id="companyDetailsName" class="form-input"></label>
              <label class="form-group"><span class="form-label">UEN / registration no.</span><input id="companyDetailsRegistration" class="form-input"></label>
              <label class="form-group company-details-wide"><span class="form-label">Billing address</span><textarea id="companyDetailsAddress" class="form-input" rows="3"></textarea></label>
              <label class="form-group"><span class="form-label">Phone</span><input id="companyDetailsPhone" class="form-input"></label>
              <label class="form-group"><span class="form-label">Email</span><input id="companyDetailsEmail" class="form-input" type="email"></label>
              <label class="form-group"><span class="form-label">Website</span><input id="companyDetailsWebsite" class="form-input"></label>
              <div class="form-group company-details-wide">
                <div class="company-letterhead-heading">
                  <label class="form-label" for="companyDetailsLetterhead">Letterhead</label>
                  <button type="button" class="btn btn-secondary company-letterhead-default" onclick="populateDefaultCompanyLetterhead()">Default</button>
                </div>
                <textarea id="companyDetailsLetterhead" class="form-input" rows="3"></textarea>
              </div>
            </div>
          </section>

          <section class="company-details-section">
            <div class="company-details-section-heading">
              <div><h3>Billing &amp; document defaults</h3><p>Applied when new quotations and invoices are created.</p></div>
            </div>
            <div class="company-details-grid">
              <label class="form-group company-details-wide"><span class="form-label">PDF colour theme</span>
                <div class="company-theme-control">
                  <input id="companyDetailsThemePicker" type="color" value="#0f766e" oninput="syncCompanyThemeColor(this.value)">
                  <input id="companyDetailsThemeColor" class="form-input" maxlength="7" value="#0f766e" oninput="syncCompanyThemeColor(this.value)">
                  <button type="button" class="company-theme-swatch" style="--swatch:#0f766e" onclick="syncCompanyThemeColor('#0f766e')" title="Showbase teal"></button>
                  <button type="button" class="company-theme-swatch" style="--swatch:#1d4ed8" onclick="syncCompanyThemeColor('#1d4ed8')" title="Corporate blue"></button>
                  <button type="button" class="company-theme-swatch" style="--swatch:#334155" onclick="syncCompanyThemeColor('#334155')" title="Slate"></button>
                  <button type="button" class="company-theme-swatch" style="--swatch:#7c2d12" onclick="syncCompanyThemeColor('#7c2d12')" title="Warm brown"></button>
                </div>
              </label>
              <label class="form-group"><span class="form-label">Bank</span><input id="companyDetailsBank" class="form-input"></label>
              <label class="form-group"><span class="form-label">Account name</span><input id="companyDetailsAccountName" class="form-input"></label>
              <label class="form-group"><span class="form-label">Account number</span><input id="companyDetailsAccountNumber" class="form-input"></label>
              <label class="form-group"><span class="form-label">PayNow UEN</span><input id="companyDetailsPaynow" class="form-input"></label>
              <div class="form-group company-details-span-2">
                <div class="company-letterhead-heading">
                  <label class="form-label" for="companyDetailsPaymentDetails">Payment details</label>
                  <button type="button" class="btn btn-secondary company-letterhead-default" onclick="populateDefaultCompanyPaymentDetails()">Default</button>
                </div>
                <textarea id="companyDetailsPaymentDetails" class="form-input" rows="4" placeholder="Payment instructions shown on invoices"></textarea>
              </div>
              <label class="form-group"><span class="form-label">Currency</span><input id="companyDetailsCurrency" class="form-input" maxlength="6"></label>
              <label class="form-group"><span class="form-label">Tax label</span><input id="companyDetailsTaxLabel" class="form-input"></label>
              <label class="form-group"><span class="form-label">Tax rate (%)</span><input id="companyDetailsTaxRate" class="form-input" type="number" min="0" max="100" step="0.01"></label>
              <label class="form-group"><span class="form-label">Default validity (days)</span><input id="companyDetailsValidity" class="form-input" type="number" min="1" max="365"></label>
              <label class="form-group"><span class="form-label">Quotation prefix</span><input id="companyDetailsQuotePrefix" class="form-input"></label>
              <label class="form-group"><span class="form-label">Invoice prefix</span><input id="companyDetailsInvoicePrefix" class="form-input"></label>
              <label class="form-group company-details-wide"><span class="form-label">Default payment terms</span><input id="companyDetailsPaymentTerms" class="form-input"></label>
              <label class="form-group company-details-wide"><span class="form-label">Default terms &amp; conditions</span><textarea id="companyDetailsTerms" class="form-input" rows="6"></textarea></label>
              <label class="form-group company-details-wide"><span class="form-label">PDF footer</span><textarea id="pdfSettingsFooterText" class="form-input" rows="4" maxlength="2000"></textarea></label>
            </div>
            <div class="company-details-actions">
              <button type="button" class="btn btn-secondary" onclick="resetPdfSettingsFooter()">Clear Footer</button>
              <button type="button" class="btn btn-primary" onclick="saveCompanyDetails()">${settingsIcon('check')}<span>Save changes</span></button>
            </div>
          </section>
          </main>
        </div>
      </div>

      <div class="company-details-tab-panel" data-company-details-panel="storage" role="tabpanel" hidden>
        <section class="company-details-storage" aria-labelledby="companyStorageHeading">
          <div class="company-details-storage-heading">
            <div>
              <h3 id="companyStorageHeading">Storage overview</h3>
              <p>Documents, media and company data stored in this workspace.</p>
            </div>
            <button type="button" class="company-storage-refresh" onclick="loadCompanyStorageUsage(true)" title="Refresh storage usage" aria-label="Refresh storage usage">
              ${settingsIcon('refresh')}
            </button>
          </div>
          <div id="companyStorageUsage" class="company-details-storage-content" aria-live="polite">
            <div class="company-storage-loading">Calculating storage usage...</div>
          </div>
        </section>
      </div>

      <div class="company-details-tab-panel" data-company-details-panel="notifications" role="tabpanel" hidden>
        <section class="company-notifications" aria-labelledby="companyNotificationsHeading">
          <div class="company-details-section-heading">
            <div>
              <h3 id="companyNotificationsHeading">Personal notifications</h3>
              <p>Connect your own Telegram account. Connections and preferences are separate for every user.</p>
            </div>
          </div>
          <div id="companyNotificationSettings" class="company-notification-content" aria-live="polite">
            <div class="company-storage-loading">Loading notification settings...</div>
          </div>
        </section>
      </div>
    </div>
  `;

  sectionParent.appendChild(section);
  showCompanyDetailsTab(companyDetailsActiveTab);
}

function renderPdfSettingsForm() {
  const logoPreview = document.getElementById('pdfSettingsLogoPreview');
  const logoPlaceholder = document.getElementById('pdfSettingsLogoPlaceholder');
  const logoName = document.getElementById('pdfSettingsLogoName');
  const footerText = document.getElementById('pdfSettingsFooterText');

  if (logoPreview) {
    const logoUrl = getPdfLogoUrl();
    if (logoUrl) {
      logoPreview.src = logoUrl;
      logoPreview.hidden = false;
    } else {
      logoPreview.removeAttribute('src');
      logoPreview.hidden = true;
    }
  }

  if (logoPlaceholder) {
    logoPlaceholder.hidden = !!getPdfLogoUrl();
  }

  if (logoName) {
    logoName.textContent = pdfSettings.hasCustomLogo && pdfSettings.logoOriginalName
      ? pdfSettings.logoOriginalName
      : 'No logo uploaded';
  }

  if (footerText && footerText.value !== getPdfFooterText()) {
    footerText.value = getPdfFooterText();
  }

  const values = {
    companyDetailsName: pdfSettings.companyName,
    companyDetailsRegistration: pdfSettings.registrationNumber,
    companyDetailsAddress: pdfSettings.billingAddress,
    companyDetailsPhone: pdfSettings.phone,
    companyDetailsEmail: pdfSettings.email,
    companyDetailsWebsite: pdfSettings.website,
    companyDetailsLetterhead: pdfSettings.letterheadEnabled === false
      ? ''
      : (pdfSettings.letterheadText || defaultCompanyLetterheadText()),
    companyDetailsBank: pdfSettings.bankName,
    companyDetailsAccountName: pdfSettings.bankAccountName,
    companyDetailsAccountNumber: pdfSettings.bankAccountNumber,
    companyDetailsPaynow: pdfSettings.paynowUen,
    companyDetailsPaymentDetails: pdfSettings.paymentDetailsEnabled === false
      ? ''
      : (pdfSettings.paymentDetailsText || defaultCompanyPaymentDetailsText()),
    companyDetailsCurrency: pdfSettings.currency,
    companyDetailsTaxLabel: pdfSettings.taxLabel,
    companyDetailsTaxRate: pdfSettings.taxRate,
    companyDetailsValidity: pdfSettings.defaultValidityDays,
    companyDetailsQuotePrefix: pdfSettings.quotationPrefix,
    companyDetailsInvoicePrefix: pdfSettings.invoicePrefix,
    companyDetailsPaymentTerms: pdfSettings.defaultPaymentTerms,
    companyDetailsTerms: pdfSettings.defaultTerms,
    companyDetailsThemeColor: pdfSettings.themeColor
  };
  Object.entries(values).forEach(([id, value]) => {
    const field = document.getElementById(id);
    if (field && field.value !== String(value ?? '')) field.value = value ?? '';
  });
  const themePicker = document.getElementById('companyDetailsThemePicker');
  if (themePicker && /^#[0-9A-Fa-f]{6}$/.test(pdfSettings.themeColor || '')) {
    themePicker.value = pdfSettings.themeColor;
  }
}

function defaultCompanyLetterheadText(useFormValues = false) {
  const settingValue = (fieldId, settingKey) => {
    if (useFormValues) {
      const field = document.getElementById(fieldId);
      if (field) return field.value;
    }
    return pdfSettings?.[settingKey];
  };
  const companyName = settingValue('companyDetailsName', 'companyName');
  const registrationNumber = settingValue('companyDetailsRegistration', 'registrationNumber');
  const billingAddress = settingValue('companyDetailsAddress', 'billingAddress');
  const contactLine = [
    settingValue('companyDetailsPhone', 'phone'),
    settingValue('companyDetailsEmail', 'email'),
    settingValue('companyDetailsWebsite', 'website'),
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' | ');
  return [
    companyName,
    registrationNumber ? `UEN / Reg No: ${registrationNumber}` : '',
    billingAddress,
    contactLine,
  ].map(value => String(value || '').trim()).filter(Boolean).join('\n');
}

function populateDefaultCompanyLetterhead() {
  const textarea = document.getElementById('companyDetailsLetterhead');
  if (!textarea) return;
  textarea.value = defaultCompanyLetterheadText(true);
  textarea.focus();
}

function defaultCompanyPaymentDetailsText(useFormValues = false) {
  const settingValue = (fieldId, settingKey) => {
    if (useFormValues) {
      const field = document.getElementById(fieldId);
      if (field) return field.value;
    }
    return pdfSettings?.[settingKey];
  };
  return [
    ['Bank', settingValue('companyDetailsBank', 'bankName')],
    ['Account name', settingValue('companyDetailsAccountName', 'bankAccountName')],
    ['Account number', settingValue('companyDetailsAccountNumber', 'bankAccountNumber')],
    ['PayNow UEN', settingValue('companyDetailsPaynow', 'paynowUen')],
  ]
    .filter(([, value]) => String(value || '').trim())
    .map(([label, value]) => `${label}: ${String(value).trim()}`)
    .join('\n');
}

function populateDefaultCompanyPaymentDetails() {
  const textarea = document.getElementById('companyDetailsPaymentDetails');
  if (!textarea) return;
  textarea.value = defaultCompanyPaymentDetailsText(true);
  textarea.focus();
}

async function loadPdfSettingsSection() {
  if (!isAdminUser()) {
    showNotification('error', 'Admin privileges required');
    showSection('events');
    return;
  }

  ensurePdfSettingsSection();
  await loadPdfSettings(true);
  showCompanyDetailsTab(companyDetailsActiveTab);
}

function companyStorageFileDate(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function renderCompanyStorageUsage(storage) {
  const container = document.getElementById('companyStorageUsage');
  if (!container) return;
  const breakdown = (storage?.breakdown || [])
    .filter(item => Number(item.bytes || 0) > 0);
  const largestFiles = storage?.largestFiles || [];
  const records = Number(storage?.recordCount || 0);

  container.innerHTML = `
    <div class="company-details-storage-summary">
      <div>
        <span>Total storage used</span>
        <strong>${formatCompanyStorageBytes(storage?.totalBytes)}</strong>
      </div>
      <p>${Number(storage?.fileCount || 0)} files${records ? ` &middot; ${records} database records` : ''}</p>
    </div>
    <div class="company-details-storage-layout">
      <div class="company-details-storage-breakdown">
        <h4>Breakdown</h4>
        ${breakdown.length ? breakdown.map(item => `
          <div class="company-details-storage-row">
            <div class="company-details-storage-row-heading">
              <span>${escapeHtml(item.label || item.key || 'Other')}</span>
              <strong>${formatCompanyStorageBytes(item.bytes)}</strong>
            </div>
            <div class="company-details-storage-track" aria-hidden="true">
              <span style="width:${Math.max(0, Math.min(100, Number(item.percent || 0)))}%"></span>
            </div>
            <small>${companyStorageItemCount(item)} &middot; ${Number(item.percent || 0).toFixed(1)}%</small>
          </div>
        `).join('') : '<div class="company-storage-empty">No stored items yet.</div>'}
      </div>
      <div class="company-details-largest-files">
        <div class="company-details-largest-files-heading">
          <h4>Largest files</h4>
          <span>Top ${Math.min(20, largestFiles.length)}</span>
        </div>
        ${largestFiles.length ? `
          <div class="company-details-file-list">
            ${largestFiles.map(file => `
              <div class="company-details-file-row">
                <div class="company-details-file-name">
                  <strong title="${escapeHtmlAttr(file.displayName || file.name || '')}">${escapeHtml(file.displayName || file.name || '-')}</strong>
                  ${file.contextLabel && file.contextLabel !== file.categoryLabel
                    ? `<span>${escapeHtml(file.contextLabel)}</span>`
                    : ''}
                  ${file.contextDetail ? `<small>${escapeHtml(file.contextDetail)}</small>` : ''}
                </div>
                <span class="company-details-file-category">${escapeHtml(file.categoryLabel || 'Other')}</span>
                <time datetime="${escapeHtmlAttr(file.modifiedAt || '')}">${companyStorageFileDate(file.modifiedAt)}</time>
                <strong class="company-details-file-size">${formatCompanyStorageBytes(file.bytes)}</strong>
              </div>
            `).join('')}
          </div>
        ` : '<div class="company-storage-empty">No files stored in this workspace.</div>'}
      </div>
    </div>
  `;
  companyStorageUsageLoaded = true;
}

async function loadCompanyStorageUsage(force = false) {
  const container = document.getElementById('companyStorageUsage');
  if (!container) return;
  if (!force && companyStorageUsageLoaded) return;
  if (force) {
    container.innerHTML = '<div class="company-storage-loading">Recalculating storage usage...</div>';
  }
  try {
    const suffix = force ? '?refresh=1' : '';
    const response = await apiCall(`/api/company-storage${suffix}`);
    renderCompanyStorageUsage(response.data || {});
  } catch (error) {
    container.innerHTML = `<div class="company-storage-error">Unable to load storage usage: ${escapeHtml(error.message)}</div>`;
  }
}

function notificationLinkedDate(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function telegramProviderIcon() {
  return `<span class="company-notification-provider-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M23.91 3.79 20.3 20.84c-.27 1.2-.98 1.49-1.99.93l-5.5-4.06-2.66 2.56c-.29.29-.54.54-1.1.54l.39-5.53L19.5 6.19c.44-.39-.1-.61-.68-.22L6.39 13.8l-5.36-1.67c-1.17-.36-1.19-1.17.24-1.73L22.2 2.33c.97-.36 1.82.24 1.71 1.46z"/>
    </svg>
  </span>`;
}

function telegramPreferenceMarkup(data) {
  const available = new Set(data.availablePreferences || []);
  const preferences = [
    ['assignedEventCreated', 'telegramAssignedEventCreated', 'New events assigned to me', 'Notify me when a new or existing event is assigned to me.'],
    ['eventStateChanges', 'telegramEventStateChanges', 'Event state changes', data.role === 'user' || data.role === 'manager'
      ? 'Notify me when an event assigned to me changes state.'
      : 'Notify me when any event changes state.'],
    ['invoiceUploads', 'telegramInvoiceUploads', 'Invoice uploads', 'Notify me when crew submit invoices.'],
    ['claimUploads', 'telegramClaimUploads', 'Claim uploads', 'Notify me when crew submit claims or receipts.'],
    ['invoiceStatusChanges', 'telegramInvoiceStatusChanges', 'Invoice status changes', 'Notify me when an invoice is approved, denied, paid, or payment is confirmed.'],
    ['claimStatusChanges', 'telegramClaimStatusChanges', 'Claim status changes', 'Notify me when a claim is approved, denied, paid, or payment is confirmed.'],
    ['assetStatusChanges', 'telegramAssetStatusChanges', 'Asset status changes', 'Notify me when an asset condition changes, including maintenance faults and resolutions.'],
    ['quotationStatusChanges', 'telegramQuotationStatusChanges', 'Quotation status changes', 'Notify me when a quotation moves between draft, sent, accepted, invoiced, paid, or expired states.'],
    ['accessControlChanges', 'telegramAccessControlChanges', 'Access control and user management', 'Notify me when users are created, updated, disabled, moved, deleted, or have passwords reset.']
  ];
  return preferences
    .filter(([key]) => available.has(key))
    .map(([key, id, title, description]) => `
      <label class="company-notification-toggle">
        <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(description)}</small></span>
        <input id="${id}" type="checkbox" ${data[key] !== false ? 'checked' : ''} onchange="saveAdminTelegramPreferences()">
      </label>`)
    .join('');
}

function renderAdminNotificationSettings(settings = adminNotificationSettings) {
  const container = document.getElementById('companyNotificationSettings');
  if (!container) return;
  const data = settings || {};
  if (!data.providerConfigured) {
    container.innerHTML = `
      <div class="company-notification-unavailable">
        <strong>Telegram is not available yet</strong>
        <p>The Showbase server administrator must configure the shared Telegram bot before users can connect.</p>
      </div>`;
    return;
  }

  if (!data.connected) {
    container.innerHTML = `
      <div class="company-notification-connect-card">
        <div class="company-notification-provider">
          ${telegramProviderIcon()}
          <div>
            <strong>Telegram</strong>
            <p>Choose the company alerts available for your role.</p>
          </div>
        </div>
        ${telegramConnectionPending ? `
          <div class="company-notification-pending">
            <span class="company-notification-spinner" aria-hidden="true"></span>
            Waiting for you to press Start in Telegram...
          </div>` : ''}
        <div class="company-notification-actions">
          <button type="button" class="btn btn-primary" onclick="connectAdminTelegram()">
            ${settingsIcon('bell')}<span>${telegramConnectionPending ? 'Open Telegram again' : 'Connect my Telegram'}</span>
          </button>
          ${telegramConnectionPending ? '<button type="button" class="btn btn-secondary" onclick="loadAdminNotificationSettings(true)">Refresh status</button>' : ''}
        </div>
        <small>Links are private, expire after 10 minutes, and connect only your signed-in Showbase account.</small>
      </div>`;
    return;
  }

  const telegramHandle = data.telegramUsername
    ? `@${escapeHtml(data.telegramUsername)}`
    : '';
  const linked = notificationLinkedDate(data.linkedAt);
  container.innerHTML = `
    <div class="company-notification-connected-card">
      <div class="company-notification-connected-heading">
        <div class="company-notification-provider">
          ${telegramProviderIcon()}
          <div>
            <strong>${escapeHtml(data.displayName || 'Telegram account')}</strong>
            <p>${telegramHandle}${telegramHandle && linked ? ' · ' : ''}${linked ? `Connected ${escapeHtml(linked)}` : 'Connected to Telegram'}</p>
          </div>
        </div>
        <span class="company-notification-status">Connected</span>
      </div>

      <label class="company-notification-toggle company-notification-master">
        <span><strong>Telegram alerts</strong><small>Pause or resume all alerts for your account.</small></span>
        <input id="telegramNotificationsEnabled" type="checkbox" ${data.enabled !== false ? 'checked' : ''} onchange="saveAdminTelegramPreferences()">
      </label>
      <div class="company-notification-preferences ${data.enabled === false ? 'is-disabled' : ''}">
        ${telegramPreferenceMarkup(data)}
      </div>
      <div class="company-notification-actions">
        <button type="button" class="btn btn-secondary" onclick="testAdminTelegram()">Send test</button>
        <button type="button" class="btn btn-secondary company-notification-disconnect" onclick="disconnectAdminTelegram()">Disconnect</button>
      </div>
    </div>`;
}

async function loadAdminNotificationSettings(force = false, quiet = false) {
  const container = document.getElementById('companyNotificationSettings');
  if (!container) return null;
  const activeCompanyCode = String(
    currentUser?.company?.code || currentUser?.companyCode || ''
  ).toUpperCase();
  const loadedCompanyCode = String(
    adminNotificationSettings?.companyCode || ''
  ).toUpperCase();
  if (
    !force &&
    companyNotificationSettingsLoaded &&
    adminNotificationSettings &&
    activeCompanyCode === loadedCompanyCode
  ) {
    renderAdminNotificationSettings();
    return adminNotificationSettings;
  }
  try {
    const response = await apiCall('/api/notification-settings');
    adminNotificationSettings = response.data || {};
    companyNotificationSettingsLoaded = true;
    if (adminNotificationSettings.connected) telegramConnectionPending = false;
    renderAdminNotificationSettings();
    return adminNotificationSettings;
  } catch (error) {
    if (!quiet) {
      container.innerHTML = `<div class="company-storage-error">Unable to load notification settings: ${escapeHtml(error.message)}</div>`;
    }
    return null;
  }
}

function startTelegramConnectionPolling() {
  if (telegramConnectionPollTimer) clearInterval(telegramConnectionPollTimer);
  let attempts = 0;
  telegramConnectionPollTimer = setInterval(async () => {
    attempts += 1;
    const settings = await loadAdminNotificationSettings(true, true);
    if (settings?.connected) {
      clearInterval(telegramConnectionPollTimer);
      telegramConnectionPollTimer = null;
      telegramConnectionPending = false;
      renderAdminNotificationSettings();
      showNotification('success', 'Telegram account connected');
    } else if (attempts >= 40) {
      clearInterval(telegramConnectionPollTimer);
      telegramConnectionPollTimer = null;
      telegramConnectionPending = false;
      renderAdminNotificationSettings();
    }
  }, 3000);
}

async function connectAdminTelegram() {
  const telegramWindow = window.open('', '_blank');
  try {
    const response = await apiCall('/api/notification-settings/telegram/connect', 'POST', {});
    const connectUrl = String(response.data?.connectUrl || '');
    if (!connectUrl) throw new Error('Telegram connection link was not returned');
    telegramConnectionPending = true;
    renderAdminNotificationSettings();
    if (telegramWindow) {
      telegramWindow.opener = null;
      telegramWindow.location.href = connectUrl;
    } else {
      window.location.href = connectUrl;
    }
    startTelegramConnectionPolling();
  } catch (error) {
    if (telegramWindow) telegramWindow.close();
    showNotification('error', error.message || 'Could not open Telegram');
  }
}

async function saveAdminTelegramPreferences() {
  const payload = {
    enabled: Boolean(document.getElementById('telegramNotificationsEnabled')?.checked)
  };
  const preferenceInputs = {
    assignedEventCreated: 'telegramAssignedEventCreated',
    eventStateChanges: 'telegramEventStateChanges',
    invoiceUploads: 'telegramInvoiceUploads',
    claimUploads: 'telegramClaimUploads',
    invoiceStatusChanges: 'telegramInvoiceStatusChanges',
    claimStatusChanges: 'telegramClaimStatusChanges',
    assetStatusChanges: 'telegramAssetStatusChanges',
    quotationStatusChanges: 'telegramQuotationStatusChanges',
    accessControlChanges: 'telegramAccessControlChanges'
  };
  Object.entries(preferenceInputs).forEach(([preference, inputId]) => {
    const input = document.getElementById(inputId);
    if (input) payload[preference] = Boolean(input.checked);
  });
  try {
    const response = await apiCall('/api/notification-settings/telegram', 'PUT', payload);
    adminNotificationSettings = response.data || adminNotificationSettings;
    renderAdminNotificationSettings();
  } catch (error) {
    showNotification('error', error.message || 'Could not save notification preferences');
    await loadAdminNotificationSettings(true, true);
  }
}

async function testAdminTelegram() {
  try {
    await apiCall('/api/notification-settings/telegram/test', 'POST', {});
    showNotification('success', 'Test notification sent');
  } catch (error) {
    showNotification('error', error.message || 'Test notification failed');
  }
}

async function disconnectAdminTelegram() {
  if (!window.confirm('Disconnect your Telegram account from Showbase alerts?')) return;
  try {
    const response = await apiCall('/api/notification-settings/telegram', 'DELETE');
    adminNotificationSettings = response.data || {};
    telegramConnectionPending = false;
    renderAdminNotificationSettings();
    showNotification('success', 'Telegram account disconnected');
  } catch (error) {
    showNotification('error', error.message || 'Could not disconnect Telegram');
  }
}

async function uploadPdfSettingsLogo() {
  if (!isAdminUser()) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const input = document.getElementById('pdfSettingsLogoInput');
  const file = input && input.files ? input.files[0] : null;

  if (!file) {
    showNotification('warning', 'Choose a logo file first');
    return;
  }

  const formData = new FormData();
  formData.append('logo', file);

  try {
    const response = await fetch('/api/pdf-settings/logo', {
      method: 'POST',
      headers: {
        "X-Client-Id": REALTIME_CLIENT_ID,
      },
      body: formData
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to upload logo');
    }

    pdfSettings = normalisePdfSettings(result.data || {});
    if (input) input.value = '';
    applyPdfSettingsToApp();
    renderPdfSettingsForm();
    showNotification('success', 'PDF logo updated');
    await continueCompanyOnboardingIfReady();
  } catch (error) {
    console.error('PDF logo upload failed:', error);
    showNotification('error', error.message || 'Failed to upload logo');
  }
}

async function resetPdfSettingsLogo() {
  if (!isAdminUser()) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  try {
    const response = await fetch('/api/pdf-settings/logo', {
      method: 'DELETE',
      headers: {
        "X-Client-Id": REALTIME_CLIENT_ID,
      },
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to remove logo');
    }

    pdfSettings = normalisePdfSettings(result.data || {});
    applyPdfSettingsToApp();
    renderPdfSettingsForm();
    showNotification('success', 'PDF logo removed');
  } catch (error) {
    console.error('PDF logo removal failed:', error);
    showNotification('error', error.message || 'Failed to remove logo');
  }
}

function syncCompanyThemeColor(value) {
  const clean = String(value || '').trim();
  if (!/^#[0-9A-Fa-f]{6}$/.test(clean)) return;
  const normalised = clean.toLowerCase();
  const picker = document.getElementById('companyDetailsThemePicker');
  const input = document.getElementById('companyDetailsThemeColor');
  if (picker && picker.value !== normalised) picker.value = normalised;
  if (input && input.value !== normalised) input.value = normalised;
}

async function saveCompanyDetails() {
  if (!isAdminUser()) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const value = id => document.getElementById(id)?.value || '';
  const payload = {
    footerText: value('pdfSettingsFooterText'),
    companyName: value('companyDetailsName'),
    registrationNumber: value('companyDetailsRegistration'),
    billingAddress: value('companyDetailsAddress'),
    phone: value('companyDetailsPhone'),
    email: value('companyDetailsEmail'),
    website: value('companyDetailsWebsite'),
    bankName: value('companyDetailsBank'),
    bankAccountName: value('companyDetailsAccountName'),
    bankAccountNumber: value('companyDetailsAccountNumber'),
    paynowUen: value('companyDetailsPaynow'),
    paymentDetailsText: value('companyDetailsPaymentDetails'),
    paymentDetailsEnabled: Boolean(value('companyDetailsPaymentDetails').trim()),
    currency: value('companyDetailsCurrency'),
    taxLabel: value('companyDetailsTaxLabel'),
    taxRate: Number(value('companyDetailsTaxRate') || 0),
    quotationPrefix: value('companyDetailsQuotePrefix'),
    invoicePrefix: value('companyDetailsInvoicePrefix'),
    defaultPaymentTerms: value('companyDetailsPaymentTerms'),
    defaultValidityDays: Number(value('companyDetailsValidity') || 30),
    defaultTerms: value('companyDetailsTerms'),
    themeColor: value('companyDetailsThemeColor') || '#0f766e',
    letterheadText: value('companyDetailsLetterhead'),
    letterheadEnabled: Boolean(value('companyDetailsLetterhead').trim())
  };

  try {
    const res = await apiCall('/api/pdf-settings', 'PUT', payload);
    pdfSettings = normalisePdfSettings(res.data || {});
    renderPdfSettingsForm();
    showNotification('success', 'Company details saved');
    await continueCompanyOnboardingIfReady();
  } catch (error) {
    showNotification('error', error.message || 'Failed to save company details');
  }
}

async function continueCompanyOnboardingIfReady() {
  if (!isAdminUser() || !String(pdfSettings?.companyName || '').trim() || !pdfSettings?.hasCustomLogo) return;
  try {
    const response = await apiCall('/api/assets');
    if (!(response.data || []).length) {
      showSection('inventory', { replaceHistory: true });
    }
  } catch (error) {
    console.warn('Unable to continue company onboarding:', error);
  }
}

async function savePdfSettingsFooter() {
  return saveCompanyDetails();
}

async function resetPdfSettingsFooter() {
  const textarea = document.getElementById('pdfSettingsFooterText');
  if (textarea) textarea.value = DEFAULT_PDF_FOOTER_TEXT;
}


// ---------------- Company Management ----------------
function settingsIcon(name) {
  const paths = {
    building: '<path d="M4 21V5l8-3 8 3v16M8 9h.01M12 9h.01M16 9h.01M8 13h.01M12 13h.01M16 13h.01M9 21v-4h6v4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="m4 20 4.5-1 10-10-3.5-3.5-10 10zM13.5 7l3.5 3.5"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6.5L4 9m2 6a7 7 0 0 0 12 2.5L20 15"/>',
    storage: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    upload: '<path d="M12 16V4m0 0-4 4m4-4 4 4M5 15v5h14v-5"/>',
    switch: '<path d="M7 7h11l-3-3m3 3-3 3M17 17H6l3 3m-3-3 3-3"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2"/>',
    shield: '<path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
    eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/>',
    eyeOff: '<path d="m4 4 16 16M10.7 6.2A10.5 10.5 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-2.3 3.1M6.3 7.3A16 16 0 0 0 2.5 12s3.5 6 9.5 6a9.6 9.6 0 0 0 3-.5M10 10a2.8 2.8 0 0 0 4 4"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.building}</svg>`;
}

async function fetchCompanies(force = false) {
  if (!force && companyOptions.length) return companyOptions;
  if (!isSuperAdminUser()) {
    companyOptions = currentUser?.company ? [currentUser.company] : [];
    return companyOptions;
  }

  const res = await apiCall('/api/companies');
  companyOptions = res.data || [];
  return companyOptions;
}

function companyOptionsMarkup(selectedCode = '') {
  const selected = String(selectedCode || '').toUpperCase();
  return (companyOptions || []).map(company => `
    <option value="${escapeHtmlAttr(company.code)}" ${String(company.code).toUpperCase() === selected ? 'selected' : ''}>
      ${escapeHtml(company.code)} - ${escapeHtml(company.name || company.code)}
    </option>
  `).join('');
}

function ensureCompanyActionModals() {
  if (document.getElementById('createCompanyModal')) return;

  const style = document.createElement('style');
  style.id = 'company-action-styles';
  style.textContent = `
    .company-action-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .company-action-buttons .btn {
      min-width: 150px;
    }
    .company-action-buttons .company-edit-button,
    .company-edit-button {
      background: #fd7e14;
      color: #fff;
    }
    .company-action-buttons .company-edit-button:hover,
    .company-edit-button:hover {
      background: #e96b02;
    }
    .companies-admin-table-scroll {
      width: 100%;
      overflow-x: auto;
    }
    .companies-admin-table {
      min-width: 760px;
      margin-top: 0;
    }
    .company-people-total {
      color: #182230;
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .company-role-counts {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .company-role-count {
      background: #f2f4f7;
      border: 1px solid #e4e7ec;
      border-radius: 4px;
      color: #475467;
      font-size: 11px;
      line-height: 1;
      padding: 5px 6px;
      white-space: nowrap;
    }
    .company-role-count.sales {
      background: #ecfdf3;
      border-color: #abefc6;
      color: #067647;
    }
    .company-storage-button {
      align-items: flex-start;
      background: transparent;
      border: 0;
      color: #087a55;
      cursor: pointer;
      display: inline-flex;
      flex-direction: column;
      font: inherit;
      gap: 2px;
      padding: 4px 0;
      text-align: left;
    }
    .company-storage-button:hover .company-storage-value,
    .company-storage-button:focus-visible .company-storage-value {
      text-decoration: underline;
    }
    .company-storage-value {
      font-size: 14px;
      font-weight: 700;
    }
    .company-storage-meta {
      color: #667085;
      font-size: 11px;
    }
    .company-storage-summary {
      align-items: baseline;
      background: #f6fef9;
      border: 1px solid #abefc6;
      border-radius: 6px;
      display: flex;
      gap: 10px;
      justify-content: space-between;
      margin-bottom: 18px;
      padding: 14px 16px;
    }
    .company-storage-summary strong {
      color: #05603a;
      font-size: 22px;
    }
    .company-storage-summary span {
      color: #475467;
      font-size: 12px;
    }
    .company-storage-breakdown {
      display: grid;
      gap: 14px;
    }
    .company-storage-row-header {
      align-items: baseline;
      display: flex;
      gap: 12px;
      justify-content: space-between;
      margin-bottom: 6px;
    }
    .company-storage-row-label {
      color: #182230;
      font-size: 13px;
      font-weight: 600;
    }
    .company-storage-row-value {
      color: #344054;
      font-size: 12px;
      white-space: nowrap;
    }
    .company-storage-track {
      background: #eaecf0;
      border-radius: 3px;
      height: 6px;
      overflow: hidden;
    }
    .company-storage-fill {
      background: #12a675;
      border-radius: inherit;
      height: 100%;
      min-width: 2px;
      transition: width 220ms ease;
    }
    .company-storage-row-meta {
      color: #667085;
      font-size: 11px;
      margin-top: 5px;
    }
    @media (max-width: 640px) {
      .company-action-buttons .btn {
        width: 100%;
      }
      .company-storage-summary {
        align-items: flex-start;
        flex-direction: column;
      }
    }
  `;
  document.head.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div id="createCompanyModal" class="modal">
      <div class="modal-content" style="max-width:620px;">
        <div class="modal-header">
          <h3 class="modal-title">Create Company</h3>
          <button type="button" class="close-btn" onclick="closeModal('createCompanyModal')" aria-label="Close">&times;</button>
        </div>
        <form onsubmit="event.preventDefault(); createCompanyFromUsersAdmin();">
          <div class="modal-body">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
              <div class="form-group">
                <label class="form-label" for="userNewCompanyCode">Code</label>
                <input id="userNewCompanyCode" class="form-input" placeholder="e.g. CLIENTCO" autocomplete="off">
              </div>
              <div class="form-group">
                <label class="form-label" for="userNewCompanyName">Name</label>
                <input id="userNewCompanyName" class="form-input" placeholder="Company name" autocomplete="organization">
              </div>
              <div class="form-group">
                <label class="form-label" for="userNewCompanyFirstAdmin">First Admin *</label>
                <input id="userNewCompanyFirstAdmin" class="form-input" placeholder="Existing or new username" autocomplete="off" required>
                <small class="form-help">Every company must retain at least one active admin.</small>
              </div>
              <div class="form-group">
                <label class="form-label" for="userNewCompanyFirstAdminPassword">Password</label>
                <input id="userNewCompanyFirstAdminPassword" type="password" class="form-input" placeholder="Only needed for a new user" autocomplete="new-password">
              </div>
            </div>
          </div>
          <div class="modal-footer modal-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal('createCompanyModal')">Cancel</button>
            <button type="submit" class="btn btn-success">Create Company</button>
          </div>
        </form>
      </div>
    </div>

    <div id="editCompanyModal" class="modal">
      <div class="modal-content" style="max-width:520px;">
        <div class="modal-header">
          <h3 class="modal-title">Edit Company</h3>
          <button type="button" class="close-btn" onclick="closeModal('editCompanyModal')" aria-label="Close">&times;</button>
        </div>
        <form onsubmit="event.preventDefault(); editCompanyFromUsersAdmin();">
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label" for="userEditCompanyOriginalCode">Company</label>
              <select id="userEditCompanyOriginalCode" class="form-input" onchange="populateEditCompanyFields()"></select>
            </div>
            <div class="form-group">
              <label class="form-label" for="userEditCompanyCode">Code</label>
              <input id="userEditCompanyCode" class="form-input" placeholder="Company code" autocomplete="off">
            </div>
            <div class="form-group">
              <label class="form-label" for="userEditCompanyName">Company Name</label>
              <input id="userEditCompanyName" class="form-input" placeholder="Company name" autocomplete="organization">
            </div>
            <p style="margin:8px 0 0;color:#667085;font-size:13px;">Changing the code also updates company folders and user assignments.</p>
          </div>
          <div class="modal-footer modal-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal('editCompanyModal')">Cancel</button>
            <button type="submit" class="btn company-edit-button">Save Company</button>
          </div>
        </form>
      </div>
    </div>

    <div id="deleteCompanyModal" class="modal">
      <div class="modal-content" style="max-width:520px;">
        <div class="modal-header">
          <h3 class="modal-title">Delete Company</h3>
          <button type="button" class="close-btn" onclick="closeModal('deleteCompanyModal')" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label" for="userDeleteCompanyCode">Company</label>
            <select id="userDeleteCompanyCode" class="form-input"></select>
          </div>
          <p style="margin:8px 0 0;color:#b42318;font-size:13px;">Deleting a company permanently removes its assets and assigned company users.</p>
        </div>
        <div class="modal-footer modal-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal('deleteCompanyModal')">Cancel</button>
          <button type="button" class="btn btn-danger" onclick="deleteCompanyFromUsersAdmin()">Delete Company</button>
        </div>
      </div>
    </div>

    <div id="companyStorageModal" class="modal">
      <div class="modal-content" style="max-width:620px;">
        <div class="modal-header">
          <div>
            <h3 id="companyStorageModalTitle" class="modal-title">Company Storage</h3>
            <p id="companyStorageModalSubtitle" style="margin:4px 0 0;color:#667085;font-size:12px;"></p>
          </div>
          <button type="button" class="close-btn" onclick="closeModal('companyStorageModal')" aria-label="Close">&times;</button>
        </div>
        <div id="companyStorageModalBody" class="modal-body">
          <p style="text-align:center;color:#667085;padding:28px 0;">Calculating storage...</p>
        </div>
      </div>
    </div>
  `;

  while (wrapper.firstElementChild) {
    document.body.appendChild(wrapper.firstElementChild);
  }
}

function companyActionButtonsMarkup() {
  return `
    <div class="company-action-buttons">
      <button type="button" class="btn company-create-button" onclick="openCreateCompanyModal()">${settingsIcon('plus')}<span>Create company</span></button>
      <button type="button" class="btn company-edit-button" onclick="openEditCompanyModal()">${settingsIcon('edit')}<span>Edit company</span></button>
      <button type="button" class="btn company-delete-button" onclick="openDeleteCompanyModal()">${settingsIcon('trash')}<span>Delete company</span></button>
    </div>
  `;
}

function formatCompanyStorageBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function companyStorageItemCount(item) {
  const parts = [];
  const fileCount = Number(item?.fileCount || 0);
  const recordCount = Number(item?.recordCount || 0);
  if (fileCount) parts.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
  if (recordCount) parts.push(`${recordCount} database record${recordCount === 1 ? '' : 's'}`);
  return parts.join(' &middot; ') || 'No stored items';
}

async function openCompanyStorageBreakdown(companyCode) {
  ensureCompanyActionModals();
  const company = companyOptions.find(item => String(item.code || '').toUpperCase() === String(companyCode || '').toUpperCase());
  const title = document.getElementById('companyStorageModalTitle');
  const subtitle = document.getElementById('companyStorageModalSubtitle');
  const body = document.getElementById('companyStorageModalBody');
  if (title) title.textContent = `${company?.name || companyCode} Storage`;
  if (subtitle) subtitle.textContent = companyCode;
  if (body) body.innerHTML = '<p style="text-align:center;color:#667085;padding:28px 0;">Calculating storage...</p>';
  openModal('companyStorageModal');

  try {
    const response = await apiCall(`/api/companies/${encodeURIComponent(companyCode)}/storage?refresh=1`);
    const storage = response.data || {};
    const breakdown = (storage.breakdown || []).filter(item => Number(item.bytes || 0) > 0);
    if (!body) return;
    body.innerHTML = `
      <div class="company-storage-summary">
        <strong>${formatCompanyStorageBytes(storage.totalBytes)}</strong>
        <span>${Number(storage.fileCount || 0)} files${Number(storage.recordCount || 0) ? ` &middot; ${Number(storage.recordCount)} database records` : ''}</span>
      </div>
      ${breakdown.length ? `
        <div class="company-storage-breakdown">
          ${breakdown.map(item => `
            <div class="company-storage-row">
              <div class="company-storage-row-header">
                <span class="company-storage-row-label">${escapeHtml(item.label || item.key || 'Other')}</span>
                <span class="company-storage-row-value">${formatCompanyStorageBytes(item.bytes)} &middot; ${Number(item.percent || 0).toFixed(1)}%</span>
              </div>
              <div class="company-storage-track" aria-hidden="true">
                <div class="company-storage-fill" style="width:${Math.max(0, Math.min(100, Number(item.percent || 0)))}%;"></div>
              </div>
              <div class="company-storage-row-meta">${companyStorageItemCount(item)}</div>
            </div>
          `).join('')}
        </div>
      ` : '<p style="text-align:center;color:#667085;padding:18px 0;">This company is not using any storage yet.</p>'}
    `;

    company.storageBytes = Number(storage.totalBytes || 0);
    company.storageFileCount = Number(storage.fileCount || 0);
    company.storageRecordCount = Number(storage.recordCount || 0);
    const tableButton = document.querySelector(`[data-company-storage-code="${CSS.escape(String(companyCode))}"]`);
    if (tableButton) {
      const value = tableButton.querySelector('.company-storage-value');
      const meta = tableButton.querySelector('.company-storage-meta');
      if (value) value.textContent = formatCompanyStorageBytes(storage.totalBytes);
      if (meta) meta.textContent = `${Number(storage.fileCount || 0)} files`;
    }
  } catch (error) {
    if (body) {
      body.innerHTML = `<p style="color:#b42318;text-align:center;padding:28px 0;">Unable to calculate storage: ${escapeHtml(error.message)}</p>`;
    }
  }
}

function openCreateCompanyModal() {
  ensureCompanyActionModals();
  ['userNewCompanyCode', 'userNewCompanyName', 'userNewCompanyFirstAdmin', 'userNewCompanyFirstAdminPassword'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
  openModal('createCompanyModal');
}

function populateEditCompanyFields() {
  const code = document.getElementById('userEditCompanyOriginalCode')?.value || '';
  const company = companyOptions.find(item => String(item.code || '').toUpperCase() === String(code).toUpperCase());
  const codeInput = document.getElementById('userEditCompanyCode');
  const input = document.getElementById('userEditCompanyName');
  if (codeInput) codeInput.value = company?.code || '';
  if (input) input.value = company?.name || '';
}

function populateEditCompanyName() {
  populateEditCompanyFields();
}

async function openEditCompanyModal() {
  ensureCompanyActionModals();
  await fetchCompanies(true);
  const select = document.getElementById('userEditCompanyOriginalCode');
  if (select) select.innerHTML = companyOptionsMarkup(currentUser?.company?.code || '');
  populateEditCompanyFields();
  openModal('editCompanyModal');
}

async function openDeleteCompanyModal() {
  ensureCompanyActionModals();
  await fetchCompanies(true);
  const select = document.getElementById('userDeleteCompanyCode');
  if (select) select.innerHTML = companyOptionsMarkup('');
  openModal('deleteCompanyModal');
}

async function setupCompanyManagementTab() {
  if (!isSuperAdminUser()) {
    removeCompanyManagementTab();
    return;
  }

  ensureCompanyManagementNavItem();
  ensureCompanyManagementSection();
  await fetchCompanies(true);
  renderCompanySwitchControl();
}

function removeCompanyManagementTab() {
  const tab = document.querySelector(`[data-section="companies"], [onclick="showSection('companies')"]`);
  if (tab) tab.remove();

  const section = document.getElementById('companies-section');
  if (section) section.remove();
}

function ensureCompanyManagementNavItem() {
  const existingTab = document.querySelector(`[data-section="companies"], [onclick="showSection('companies')"]`);
  if (existingTab) {
    existingTab.classList.add('nav-item-inline');
    setupSidebarNavigation();
    return;
  }

  const settingsSection = Array.from(document.querySelectorAll('.nav-section'))
    .find(section => {
      const heading = section.querySelector('h3');
      return heading && heading.textContent.trim() === 'Settings';
    });

  if (!settingsSection) {
    console.warn('Could not find Settings section for Companies tab');
    return;
  }

  const companiesTab = document.createElement('button');
  companiesTab.type = 'button';
  companiesTab.className = 'nav-item nav-item-inline platform-admin-only';
  companiesTab.dataset.section = 'companies';
  companiesTab.dataset.label = 'Companies';
  companiesTab.textContent = 'Companies';

  const logoutButton = settingsSection.querySelector(`[onclick="logout()"]`);
  if (logoutButton) {
    settingsSection.insertBefore(companiesTab, logoutButton);
  } else {
    settingsSection.appendChild(companiesTab);
  }
  setupSidebarNavigation();
}

function ensureCompanyManagementSection() {
  if (document.getElementById('companies-section')) return;

  ensureCompanyActionModals();
  const firstSection = document.querySelector('.content-section');
  const sectionParent = firstSection ? firstSection.parentElement : document.body;

  const section = document.createElement('div');
  section.id = 'companies-section';
  section.className = 'content-section';

  section.innerHTML = `
    <div class="content-header settings-page-header">
      <div>
        <h2 class="content-title">Companies</h2>
        <p class="settings-page-subtitle">Manage company workspaces, access and storage.</p>
      </div>
      <button type="button" class="settings-icon-command" onclick="loadCompaniesAdmin()" title="Refresh companies">
        ${settingsIcon('refresh')}<span>Refresh</span>
      </button>
    </div>

    <section class="companies-control-band" aria-label="Company controls">
      <div class="company-active-control">
        <span class="settings-eyebrow">Active company</span>
        <div class="company-switch-row">
          <div id="activeCompanySwitcher" class="company-custom-select">
            <input id="activeCompanySelect" type="hidden">
            <button id="activeCompanyTrigger" type="button" class="company-select-trigger" aria-haspopup="listbox" aria-expanded="false" onclick="toggleCompanySwitcher(event)">
              <span class="company-select-trigger-copy"><strong>Loading...</strong><small>Please wait</small></span>
              <span class="company-select-chevron" aria-hidden="true">&#8964;</span>
            </button>
            <div id="activeCompanyMenu" class="company-custom-menu" role="listbox"></div>
          </div>
          <button type="button" class="btn company-switch-button" onclick="switchCompanyAdmin()">
            ${settingsIcon('switch')}<span>Switch</span>
          </button>
        </div>
      </div>

      <div class="company-actions-panel">
        <span class="settings-eyebrow">Company actions</span>
        ${companyActionButtonsMarkup()}
      </div>
    </section>

    <section class="companies-directory">
      <div class="settings-section-heading">
        <div>
          <h3>Company directory</h3>
          <span id="companyDirectoryCount">Loading company records...</span>
        </div>
      </div>
      <div id="companies-admin-table-container" aria-live="polite">
        <div class="settings-loading-state">Loading companies...</div>
      </div>
    </section>
  `;

  sectionParent.appendChild(section);
}

function closeCompanySwitcher() {
  const switcher = document.getElementById('activeCompanySwitcher');
  const trigger = document.getElementById('activeCompanyTrigger');
  if (switcher) switcher.classList.remove('is-open');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function toggleCompanySwitcher(event) {
  event?.stopPropagation();
  const switcher = document.getElementById('activeCompanySwitcher');
  const trigger = document.getElementById('activeCompanyTrigger');
  if (!switcher || !trigger) return;
  const isOpen = switcher.classList.toggle('is-open');
  trigger.setAttribute('aria-expanded', String(isOpen));
}

function chooseCompanyForSwitch(encodedCode) {
  const code = decodeURIComponent(String(encodedCode || ''));
  const input = document.getElementById('activeCompanySelect');
  if (input) input.value = code;
  renderCompanySwitchControl();
  closeCompanySwitcher();
}

function ensureCompanySwitcherDismissal() {
  if (document.documentElement.dataset.companySwitcherDismissal === 'ready') return;
  document.documentElement.dataset.companySwitcherDismissal = 'ready';
  document.addEventListener('click', event => {
    if (!event.target.closest('#activeCompanySwitcher')) closeCompanySwitcher();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeCompanySwitcher();
  });
}

function renderCompanySwitchControl() {
  const select = document.getElementById('activeCompanySelect');
  const trigger = document.getElementById('activeCompanyTrigger');
  const menu = document.getElementById('activeCompanyMenu');
  if (!select || !trigger || !menu) return;
  const activeCode = currentUser?.company?.code || '';
  const selectedCode = (companyOptions || []).some(company => String(company.code) === String(select.value))
    ? select.value
    : activeCode;
  select.value = selectedCode;

  const selectedCompany = (companyOptions || []).find(company => String(company.code) === String(selectedCode));
  trigger.innerHTML = `
    <span class="company-select-trigger-copy">
      <strong>${escapeHtml(selectedCompany?.name || selectedCompany?.code || 'Choose a company')}</strong>
      <small>${selectedCompany ? escapeHtml(selectedCompany.code) : 'No company selected'}</small>
    </span>
    <span class="company-select-chevron" aria-hidden="true">&#8964;</span>
  `;
  menu.innerHTML = (companyOptions || []).map(company => {
    const selected = String(company.code) === String(selectedCode);
    return `
      <button type="button" class="company-select-option${selected ? ' is-selected' : ''}" role="option" aria-selected="${selected}" data-company-code="${escapeHtmlAttr(encodeURIComponent(company.code))}" onclick="chooseCompanyForSwitch(this.dataset.companyCode)">
        <span class="company-select-option-mark">${escapeHtml(String(company.code || '?').slice(0, 2).toUpperCase())}</span>
        <span><strong>${escapeHtml(company.name || company.code)}</strong><small>${escapeHtml(company.code)}</small></span>
        ${selected ? settingsIcon('check') : ''}
      </button>
    `;
  }).join('');
  ensureCompanySwitcherDismissal();
}

async function loadCompaniesAdmin() {
  if (!isSuperAdminUser()) {
    showNotification('error', 'Administrative access required');
    showSection('events');
    return;
  }

  ensureCompanyManagementSection();
  const container = document.getElementById('companies-admin-table-container');
  if (container) {
    container.innerHTML = '<div class="settings-loading-state">Loading companies...</div>';
  }

  try {
    const companies = await fetchCompanies(true);
    renderCompanySwitchControl();

    if (!container) return;
    if (!companies.length) {
      container.innerHTML = '<div class="settings-empty-state">No companies found.</div>';
      const count = document.getElementById('companyDirectoryCount');
      if (count) count.textContent = 'No company records';
      return;
    }

    const count = document.getElementById('companyDirectoryCount');
    if (count) count.textContent = `${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`;

    container.innerHTML = `
      <div class="companies-admin-table-scroll">
      <table class="table companies-admin-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>People</th>
            <th>Storage</th>
            <th>Branding</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          ${companies.map(company => {
            const roles = company.roleCounts || {};
            return `
            <tr class="${company.isActive ? 'is-active' : ''}">
              <td data-label="Company">
                <div class="company-identity">
                  <span class="company-monogram">${escapeHtml(String(company.code || '?').slice(0, 2).toUpperCase())}</span>
                  <span><strong>${escapeHtml(company.name || company.code)}</strong><small>${escapeHtml(company.code)}</small></span>
                </div>
              </td>
              <td data-label="People">
                <div class="company-people-total">${Number(company.userCount || 0)} account${Number(company.userCount || 0) === 1 ? '' : 's'}</div>
                <div class="company-role-counts">
                  <span class="company-role-count">${Number(roles.user || 0)} users</span>
                  <span class="company-role-count">${Number(roles.manager || 0)} managers</span>
                  <span class="company-role-count">${Number(roles.admin || 0)} admins</span>
                  <span class="company-role-count sales">${Number(company.salesPersonnelCount || 0)} sales</span>
                </div>
              </td>
              <td data-label="Storage">
                <button type="button" class="company-storage-button" data-company-storage-code="${escapeHtmlAttr(company.code)}" onclick="openCompanyStorageBreakdown(this.dataset.companyStorageCode)" aria-label="View storage breakdown for ${escapeHtmlAttr(company.name || company.code)}">
                  <span class="company-storage-value">${formatCompanyStorageBytes(company.storageBytes)}</span>
                  <span class="company-storage-meta">${Number(company.storageFileCount || 0)} files</span>
                </button>
              </td>
              <td data-label="Branding"><span class="company-state-badge ${company.brandingSetupRequired ? 'pending' : 'ready'}">${company.brandingSetupRequired ? 'Pending' : 'Ready'}</span></td>
              <td data-label="State">${company.isActive ? '<span class="company-state-badge active">Active</span>' : '<span class="settings-dash">-</span>'}</td>
            </tr>
          `}).join('')}
        </tbody>
      </table>
      </div>
    `;
  } catch (error) {
    if (container) {
      container.innerHTML = `<div class="settings-error-state">Failed to load companies: ${escapeHtml(error.message)}</div>`;
    }
  }
}

async function deleteCompanyAdmin(code, isActive = false, companyCount = 0) {
  if (!isSuperAdminUser()) {
    showNotification('error', 'Administrative access required');
    return false;
  }

  if (isActive) {
    showNotification('warning', 'Switch to another company before deleting this one');
    return false;
  }

  if (Number(companyCount || 0) <= 1) {
    showNotification('warning', 'At least one company must remain');
    return false;
  }

  const company = (companyOptions || []).find(item => String(item.code || '').toUpperCase() === String(code || '').toUpperCase());
  const name = company?.name || code;

  const confirmed = await showAppConfirm({
    title: 'Delete Company',
    message: `Delete ${name || code}? This permanently removes the company folder and all company assets.`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
    variant: 'danger'
  });

  if (!confirmed) return false;

  try {
    const res = await apiCall(`/api/companies/${encodeURIComponent(code)}`, 'DELETE');
    const removedUsers = res?.data?.removedUsers || [];
    const userNote = removedUsers.length ? ` Removed ${removedUsers.length} assigned user account(s).` : '';
    showNotification('success', `Company deleted.${userNote}`);
    closeModal('deleteCompanyModal');
    await loadCompaniesAdmin();
    if (document.getElementById('users-section')) {
      await loadUsersAdmin();
    }
    return true;
  } catch (error) {
    showNotification('error', `Failed to delete company: ${error.message}`);
    return false;
  }
}

async function switchCompanyAdmin() {
  const code = document.getElementById('activeCompanySelect')?.value || '';
  if (!code) {
    showNotification('warning', 'Choose a company first');
    return;
  }

  try {
    await apiCall('/api/current-company', 'PUT', { companyCode: code });
    showNotification('success', 'Company switched');
    setTimeout(() => window.location.reload(), 400);
  } catch (error) {
    showNotification('error', `Failed to switch company: ${error.message}`);
  }
}

function ensureCompanyBrandingPromptModal() {
  if (document.getElementById('companyBrandingSetupModal')) return;

  const modal = document.createElement('div');
  modal.id = 'companyBrandingSetupModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:720px;">
      <div class="modal-header">
        <h3>Company Branding</h3>
      </div>
      <div class="modal-body">
        <p style="margin-bottom:16px;color:#495057;">
          Add a logo and footer for <strong id="companyBrandingName"></strong>, or leave them blank for now.
        </p>
        <div style="display:grid;grid-template-columns:minmax(220px,280px) 1fr;gap:18px;align-items:start;">
          <div class="form-group">
            <label class="form-label" for="companyBrandingLogoInput">Logo</label>
            <div style="border:1px solid #e9ecef;border-radius:8px;padding:16px;background:#fff;min-height:110px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;">
              <img id="companyBrandingLogoPreview" alt="Company Logo" style="max-width:220px;max-height:80px;object-fit:contain;">
              <span id="companyBrandingLogoPlaceholder" style="color:#64748b;font-size:12px;font-weight:700;">No logo uploaded</span>
            </div>
            <input id="companyBrandingLogoInput" class="form-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
          </div>
          <div class="form-group">
            <label class="form-label" for="companyBrandingFooterText">Footer</label>
            <textarea id="companyBrandingFooterText" class="form-input" rows="6" maxlength="2000"></textarea>
          </div>
        </div>
      </div>
      <div class="modal-footer modal-actions">
        <button type="button" class="btn btn-secondary" onclick="completeCompanyBrandingSetup(true)">Skip for Now</button>
        <button type="button" class="btn btn-primary" onclick="completeCompanyBrandingSetup(false)">Save Branding</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

async function showCompanyBrandingPromptIfNeeded() {
  if (!currentUser || !currentUser.isAdmin || !currentUser.company?.brandingSetupRequired) return;

  await loadPdfSettings(true);
  ensureCompanyBrandingPromptModal();

  const name = document.getElementById('companyBrandingName');
  const preview = document.getElementById('companyBrandingLogoPreview');
  const placeholder = document.getElementById('companyBrandingLogoPlaceholder');
  const footer = document.getElementById('companyBrandingFooterText');
  const fileInput = document.getElementById('companyBrandingLogoInput');
  const logoUrl = getPdfLogoUrl();

  if (name) name.textContent = currentUser.company.name || currentUser.company.code || 'this company';
  if (preview) {
    if (logoUrl) {
      preview.src = logoUrl;
      preview.hidden = false;
    } else {
      preview.removeAttribute('src');
      preview.hidden = true;
    }
  }
  if (placeholder) placeholder.hidden = !!logoUrl;
  if (footer) footer.value = getPdfFooterText();
  if (fileInput) fileInput.value = '';

  openModal('companyBrandingSetupModal');
}

async function completeCompanyBrandingSetup(useDefaults = false) {
  try {
    if (useDefaults) {
      await apiCall('/api/company/branding-setup-complete', 'POST', {});
    } else {
      const input = document.getElementById('companyBrandingLogoInput');
      const file = input && input.files ? input.files[0] : null;
      const footerText = document.getElementById('companyBrandingFooterText')?.value || DEFAULT_PDF_FOOTER_TEXT;

      if (file) {
        const formData = new FormData();
        formData.append('logo', file);
        const response = await fetch('/api/pdf-settings/logo', {
          method: 'POST',
          headers: {
            "X-Client-Id": REALTIME_CLIENT_ID,
          },
          body: formData
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || 'Failed to upload logo');
        }
        pdfSettings = normalisePdfSettings(result.data || {});
      }

      const res = await apiCall('/api/pdf-settings', 'PUT', { footerText });
      pdfSettings = normalisePdfSettings(res.data || pdfSettings);
    }

    const currentUserRes = await apiCall('/api/current-user');
    currentUser = currentUserRes.data;
    await loadPdfSettings(true);
    applyPdfSettingsToApp();
    closeModal('companyBrandingSetupModal');
    showNotification('success', 'Company branding saved');
  } catch (error) {
    showNotification('error', `Failed to save company branding: ${error.message}`);
  }
}


// ---------------- Department Management ----------------
function normalizeDepartmentCode(code) {
  const cleaned = String(code || 'UN').trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '');
  return cleaned || 'UN';
}

function departmentClassName(code) {
  return `dept-${normalizeDepartmentCode(code).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;
}

function getDepartmentMeta(code) {
  const normalized = normalizeDepartmentCode(code);
  return departments[normalized] || {
    code: normalized,
    name: normalized,
    color: '#e2e3e5',
    textColor: '#383d41',
    assetCount: 0
  };
}

function departmentBadgeHtml(code, showName = false) {
  const dept = getDepartmentMeta(code);
  const label = showName && dept.name && dept.name !== dept.code
    ? `${dept.code} - ${dept.name}`
    : dept.code;

  return `<span class="asset-badge ${departmentClassName(dept.code)}" title="${escapeHtmlAttr(dept.name || dept.code)}">${escapeHtml(label)}</span>`;
}

function applyDepartmentStyles() {
  let style = document.getElementById('dynamic-department-styles');
  if (!style) {
    style = document.createElement('style');
    style.id = 'dynamic-department-styles';
    document.head.appendChild(style);
  }

  const rules = Object.values(departments).map(dept => {
    const cls = departmentClassName(dept.code);
    const bg = /^#[0-9A-Fa-f]{6}$/.test(dept.color || '') ? dept.color : '#e2e3e5';
    const fg = /^#[0-9A-Fa-f]{6}$/.test(dept.textColor || '') ? dept.textColor : '#383d41';
    return `.${cls} { background: ${bg} !important; color: ${fg} !important; }`;
  });

  style.textContent = rules.join('\n');
}

async function loadDepartments(force = false) {
  if (departmentsLoaded && !force) return departments;

  const res = await apiCall('/api/departments');
  const list = res.data || [];
  departments = {};
  list.forEach(dept => {
    const code = normalizeDepartmentCode(dept.code);
    departments[code] = {
      code,
      name: dept.name || code,
      color: dept.color || '#e2e3e5',
      textColor: dept.textColor || '#383d41',
      assetCount: Number(dept.assetCount || 0)
    };
  });

  departmentsLoaded = true;
  applyDepartmentStyles();
  populateDepartmentSelects();
  renderDepartmentManager();
  return departments;
}

function sortedDepartmentList() {
  return Object.values(departments).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

function populateDepartmentSelects() {
  const list = sortedDepartmentList();

  const filter = document.getElementById('department-filter');
  if (filter) {
    const options = document.getElementById('department-filter-options');
    const existingCheckboxes = Array.from(options?.querySelectorAll('input[type="checkbox"]') || []);
    const selectedCodes = new Set(existingCheckboxes.filter(input => input.checked).map(input => input.value));
    const previouslySelectedAll = existingCheckboxes.length === 0 || selectedCodes.size === existingCheckboxes.length;
    if (options) {
      options.innerHTML = list.map(dept => {
        const checked = previouslySelectedAll || selectedCodes.has(dept.code);
        return `
          <label class="inventory-department-filter-option">
            <input type="checkbox" value="${escapeHtmlAttr(dept.code)}"${checked ? ' checked' : ''} />
            <span class="sb-department-badge" style="--sb-department-color:${escapeHtmlAttr(dept.color || '#e2e8f0')};--sb-department-text:${escapeHtmlAttr(dept.textColor || '#334155')}">${escapeHtml(dept.code)}</span>
            <span class="sb-department-name">${escapeHtml(dept.name || dept.code)}</span>
            <span class="inventory-department-filter-check" aria-hidden="true"></span>
          </label>
        `;
      }).join('');
      updateInventoryCheckboxFilterSummary('department-filter');
    }
  }

  const assetDeptSelect = document.getElementById('assetDepartment');
  if (assetDeptSelect) {
    const current = assetDeptSelect.value || 'UN';
    assetDeptSelect.innerHTML = list.map(dept => (
      `<option value="${escapeHtmlAttr(dept.code)}">${escapeHtml(dept.code)} - ${escapeHtml(dept.name || dept.code)}</option>`
    )).join('');
    assetDeptSelect.value = list.some(dept => dept.code === current) ? current : (list[0]?.code || 'UN');
    window.refreshShowbaseSelect?.(assetDeptSelect);
  }

  ensureDepartmentDatalist();
}

function ensureDepartmentDatalist() {
  let datalist = document.getElementById('department-code-options');
  if (!datalist) {
    datalist = document.createElement('datalist');
    datalist.id = 'department-code-options';
    document.body.appendChild(datalist);
  }

  datalist.innerHTML = sortedDepartmentList().map(dept => (
    `<option value="${escapeHtmlAttr(dept.code)}">${escapeHtml(dept.name || dept.code)}</option>`
  )).join('');
}

function ensureDepartmentManagerPanel() {
  if (!currentUser || !currentUser.isAdmin) return;
  if (document.getElementById('department-admin-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'department-admin-panel';
  panel.className = 'modal';
  panel.innerHTML = `
    <div class="modal-content" style="max-width:900px;width:94%;max-height:88vh;overflow:hidden;display:flex;flex-direction:column;">
      <div class="modal-header">
        <div>
          <h3 class="modal-title" style="margin:0;">Manage departments</h3>
          <p style="margin:4px 0 0;color:#64748b;font-size:12px;">Department names, codes and colours</p>
        </div>
        <button type="button" class="close-btn" onclick="closeModal('department-admin-panel')" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body" style="min-height:0;overflow:auto;">
        <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
          <button type="button" class="btn btn-primary" onclick="openDepartmentModal()">Add department</button>
        </div>
        <div id="department-admin-table" class="responsive-table-wrap"></div>
      </div>
    </div>
  `;

  document.body.appendChild(panel);
  enhanceModalAccessibility(panel);
}

function renderDepartmentManager() {
  if (!currentUser || !currentUser.isAdmin) return;
  ensureDepartmentManagerPanel();

  const container = document.getElementById('department-admin-table');
  if (!container) return;

  const list = sortedDepartmentList().filter(isSelectableCompanyDepartment);
  if (list.length === 0) {
    container.innerHTML = '<p style="color:#666;text-align:center;padding:20px;">No departments found.</p>';
    return;
  }

  container.innerHTML = `
    <table class="table" style="margin-top:0;">
      <thead>
        <tr>
          <th>Code</th>
          <th>Name</th>
          <th>Preview</th>
          <th>Colour</th>
          <th>Assets</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${list.map(dept => `
          <tr>
            <td><strong>${escapeHtml(dept.code)}</strong></td>
            <td>${escapeHtml(dept.name || dept.code)}</td>
            <td>${departmentBadgeHtml(dept.code, true)}</td>
            <td><span style="display:inline-flex;align-items:center;gap:8px;"><span style="width:22px;height:22px;border-radius:6px;border:1px solid #ccc;background:${escapeHtmlAttr(dept.color || '#e2e3e5')};display:inline-block;"></span>${escapeHtml(dept.color || '')}</span></td>
            <td>${Number(dept.assetCount || 0)}</td>
            <td>
              <button class="btn btn-warning btn-sm" onclick="openDepartmentModal('${encodeURIComponent(dept.code)}')">Edit</button>
              <button class="btn btn-danger btn-sm" onclick="deleteDepartment('${encodeURIComponent(dept.code)}')">Delete</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function ensureDepartmentModal() {
  if (document.getElementById('departmentModal')) return;

  const modal = document.createElement('div');
  modal.id = 'departmentModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:520px;">
      <div class="modal-header">
        <h3 class="modal-title" id="departmentModalTitle">Department</h3>
        <button class="close-btn" onclick="closeModal('departmentModal')">&times;</button>
      </div>
      <div class="modal-body">
        <div id="departmentRenameWarning" style="display:none;background:#fff3cd;border:1px solid #ffeaa7;color:#856404;padding:12px;border-radius:8px;margin-bottom:14px;">
          Renaming the department code will update matching inventory rows and event model requirements so old events stay linked.
        </div>
        <div class="form-group">
          <label class="form-label">Department Code</label>
          <input id="departmentCodeInput" class="form-input" placeholder="AX / LX / VIDEO" style="text-transform:uppercase;">
        </div>
        <div class="form-group">
          <label class="form-label">Display Name</label>
          <input id="departmentNameInput" class="form-input" placeholder="Audio / Lighting / Video">
        </div>
        <div class="form-group">
          <label class="form-label">Badge Colour</label>
          <div style="display:flex;gap:10px;align-items:center;">
            <input id="departmentColorInput" type="color" class="form-input" style="width:80px;padding:4px;height:44px;">
            <input id="departmentColorTextInput" class="form-input" placeholder="#667EEA">
          </div>
        </div>
        <div style="margin-top:10px;">
          <span style="color:#666;font-size:13px;margin-right:8px;">Preview:</span>
          <span id="departmentPreviewBadge" class="asset-badge">DEPT</span>
        </div>
      </div>
      <div class="modal-footer modal-actions" style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
        <button class="btn btn-secondary" onclick="closeModal('departmentModal')">Cancel</button>
        <button class="btn btn-success" onclick="saveDepartmentModal()">Save Department</button>
      </div>
    </div>
  `;

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal('departmentModal');
  });

  document.body.appendChild(modal);

  const colorInput = document.getElementById('departmentColorInput');
  const colorTextInput = document.getElementById('departmentColorTextInput');
  const codeInput = document.getElementById('departmentCodeInput');
  const nameInput = document.getElementById('departmentNameInput');

  colorInput.addEventListener('input', () => {
    colorTextInput.value = colorInput.value.toUpperCase();
    updateDepartmentPreview();
  });
  colorTextInput.addEventListener('input', () => {
    if (/^#[0-9A-Fa-f]{6}$/.test(colorTextInput.value.trim())) {
      colorInput.value = colorTextInput.value.trim();
    }
    updateDepartmentPreview();
  });
  codeInput.addEventListener('input', updateDepartmentPreview);
  nameInput.addEventListener('input', updateDepartmentPreview);
}

function updateDepartmentPreview() {
  const badge = document.getElementById('departmentPreviewBadge');
  if (!badge) return;

  const code = normalizeDepartmentCode(document.getElementById('departmentCodeInput')?.value || 'DEPT');
  const name = document.getElementById('departmentNameInput')?.value.trim() || code;
  const colour = document.getElementById('departmentColorTextInput')?.value.trim() || '#e2e3e5';

  badge.textContent = name && name !== code ? `${code} - ${name}` : code;
  const safeColour = /^#[0-9A-Fa-f]{6}$/.test(colour) ? colour : '#e2e3e5';
  badge.style.background = safeColour;
  badge.style.color = getReadableTextColour(safeColour);
}

function getReadableTextColour(colour) {
  // Supports hex input. Browser rgb() fallback uses dark text.
  if (!/^#[0-9A-Fa-f]{6}$/.test(colour || '')) return '#111827';
  const r = parseInt(colour.slice(1, 3), 16);
  const g = parseInt(colour.slice(3, 5), 16);
  const b = parseInt(colour.slice(5, 7), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 150 ? '#111827' : '#FFFFFF';
}

function openDepartmentModal(encodedCode = '') {
  if (!currentUser || !currentUser.isAdmin) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  ensureDepartmentModal();

  const modal = document.getElementById('departmentModal');
  const originalCode = encodedCode ? decodeURIComponent(encodedCode) : '';
  const dept = originalCode ? getDepartmentMeta(originalCode) : { code: '', name: '', color: '#667eea' };

  modal.dataset.originalCode = originalCode;
  document.getElementById('departmentModalTitle').textContent = originalCode ? `Edit Department: ${originalCode}` : 'Add Department';
  document.getElementById('departmentRenameWarning').style.display = originalCode ? 'block' : 'none';
  document.getElementById('departmentCodeInput').value = dept.code || '';
  document.getElementById('departmentNameInput').value = dept.name || '';
  document.getElementById('departmentColorInput').value = dept.color || '#667eea';
  document.getElementById('departmentColorTextInput').value = (dept.color || '#667eea').toUpperCase();

  updateDepartmentPreview();
  openModal('departmentModal');
  setTimeout(() => document.getElementById('departmentCodeInput')?.focus(), 100);
}

async function saveDepartmentModal() {
  if (!currentUser || !currentUser.isAdmin) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const modal = document.getElementById('departmentModal');
  const originalCode = modal.dataset.originalCode || '';
  const code = normalizeDepartmentCode(document.getElementById('departmentCodeInput')?.value);
  const name = document.getElementById('departmentNameInput')?.value.trim();
  const color = document.getElementById('departmentColorTextInput')?.value.trim();

  if (!code) {
    showNotification('warning', 'Department code is required');
    return;
  }

  if (!name) {
    showNotification('warning', 'Department display name is required');
    return;
  }

  if (!/^#[0-9A-Fa-f]{6}$/.test(color || '')) {
    showNotification('warning', 'Colour must be a valid hex colour, e.g. #667EEA');
    return;
  }

  if (originalCode && code !== normalizeDepartmentCode(originalCode)) {
    const ok = await showAppConfirm({
      title: 'Rename Department',
      message: `Rename department code "${originalCode}" to "${code}"?\n\nThis will update matching inventory rows and event model requirements.`,
      confirmText: 'Rename',
      cancelText: 'Cancel',
      variant: 'warning',
    });
    if (!ok) return;
  }

  try {
    const endpoint = originalCode
      ? `/api/departments/${encodeURIComponent(originalCode)}`
      : '/api/departments';
    const method = originalCode ? 'PUT' : 'POST';

    const res = await apiCall(endpoint, method, { code, name, color });
    closeModal('departmentModal');

    const data = res.data || {};
    let message = originalCode ? 'Department updated' : 'Department created';
    if (data.assetsUpdated) message += `; ${data.assetsUpdated} asset(s) updated`;
    if (data.eventsUpdated) message += `; ${data.eventsUpdated} event(s) updated`;
    showNotification('success', message);

    departmentsLoaded = false;
    await loadDepartments(true);
    await loadInventory();
  } catch (error) {
    showNotification('error', `Failed to save department: ${error.message}`);
  }
}

async function deleteDepartment(encodedCode) {
  if (!currentUser || !currentUser.isAdmin) {
    showNotification('error', 'Admin privileges required');
    return;
  }

  const code = decodeURIComponent(encodedCode || '');
  const dept = getDepartmentMeta(code);
  const ok = await showAppConfirm({
    title: 'Delete Department',
    message: `Delete department "${dept.code}"?\n\nThis is only allowed when no assets are assigned to it.`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
    variant: 'danger',
  });
  if (!ok) return;

  try {
    await apiCall(`/api/departments/${encodeURIComponent(dept.code)}`, 'DELETE');
    showNotification('success', `Department ${dept.code} deleted`);
    departmentsLoaded = false;
    await loadDepartments(true);
    await loadInventory();
  } catch (error) {
    await showAppAlert({
      title: 'Department Not Deleted',
      message: error.message,
      variant: 'warning',
    });
  }
}


// ---------------- Admin User Management ----------------

async function setupChangePasswordTab() {
  if (!currentUser) {
    const res = await apiCall('/api/current-user');
    currentUser = res.data;
  }

  refreshSidebarUserMenu();
  ensureChangePasswordNavItem();
  ensureChangePasswordSection();
}

function ensureChangePasswordNavItem() {
  if (document.querySelector(`[data-section="change-password"], [onclick="showSection('change-password')"]`)) return;

  const settingsSection = Array.from(document.querySelectorAll('.nav-section'))
    .find(section => {
      const heading = section.querySelector('h3');
      return heading && heading.textContent.trim() === 'Settings';
    });

  if (!settingsSection) {
    console.warn('Could not find Settings section for Change Password tab');
    return;
  }

  const passwordTab = document.createElement('button');
  passwordTab.type = 'button';
  passwordTab.className = 'nav-item';
  passwordTab.dataset.section = 'change-password';
  passwordTab.textContent = 'Change Password';

  const logoutButton = settingsSection.querySelector(`[onclick="logout()"]`);

  if (logoutButton) {
    settingsSection.insertBefore(passwordTab, logoutButton);
  } else {
    settingsSection.appendChild(passwordTab);
  }
}

function ensureChangePasswordSection() {
  if (document.getElementById('change-password-section')) return;

  const firstSection = document.querySelector('.content-section');
  const sectionParent = firstSection ? firstSection.parentElement : document.body;

  const section = document.createElement('div');
  section.id = 'change-password-section';
  section.className = 'content-section';

  const userName = String(currentUser?.name || currentUser?.username || 'Showbase user').trim();
  const username = String(currentUser?.username || '').trim();

  section.innerHTML = `
    <div class="content-header settings-page-header">
      <div>
        <h2 class="content-title">Change password</h2>
        <p class="settings-page-subtitle">Update the password used for your Showbase account.</p>
      </div>
    </div>

    <div class="password-page-layout">
      <section class="password-security-band" aria-label="Signed-in account">
        <span class="settings-feature-icon">${settingsIcon('shield')}</span>
        <div>
          <span class="settings-eyebrow">Signed in as</span>
          <strong>${escapeHtml(userName)}</strong>
          ${username && username !== userName ? `<small>@${escapeHtml(username)}</small>` : ''}
        </div>
      </section>

      <section class="password-form-panel">
        <form id="changePasswordForm" onsubmit="submitChangePassword(event)">
          <div class="password-form-heading">
            <span class="settings-feature-icon compact">${settingsIcon('lock')}</span>
            <div>
              <h3>Set a new password</h3>
              <p>Enter your current password before choosing a replacement.</p>
            </div>
          </div>

          <div class="form-group password-field-current">
            <label class="form-label" for="currentPasswordInput">Current password</label>
            <div class="password-input-wrap">
              <input id="currentPasswordInput" type="password" class="form-input" autocomplete="current-password">
              <button type="button" class="password-visibility-button" onclick="toggleSettingsPasswordVisibility('currentPasswordInput', this)" aria-label="Show password" title="Show password">${settingsIcon('eye')}</button>
            </div>
          </div>

          <div class="password-new-grid">
            <div class="form-group">
              <label class="form-label" for="newPasswordInput">New password</label>
              <div class="password-input-wrap">
                <input id="newPasswordInput" type="password" class="form-input" autocomplete="new-password">
                <button type="button" class="password-visibility-button" onclick="toggleSettingsPasswordVisibility('newPasswordInput', this)" aria-label="Show password" title="Show password">${settingsIcon('eye')}</button>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label" for="confirmPasswordInput">Confirm password</label>
              <div class="password-input-wrap">
                <input id="confirmPasswordInput" type="password" class="form-input" autocomplete="new-password">
                <button type="button" class="password-visibility-button" onclick="toggleSettingsPasswordVisibility('confirmPasswordInput', this)" aria-label="Show password" title="Show password">${settingsIcon('eye')}</button>
              </div>
            </div>
          </div>

          <div class="password-form-actions">
            <button type="submit" id="changePasswordSubmit" class="btn password-save-button">${settingsIcon('lock')}<span>Save new password</span></button>
            <button type="button" class="btn password-clear-button" onclick="resetChangePasswordForm()">Clear</button>
          </div>
        </form>
      </section>
    </div>
  `;

  sectionParent.appendChild(section);
}

function toggleSettingsPasswordVisibility(inputId, button) {
  const input = document.getElementById(inputId);
  if (!input || !button) return;
  const willShow = input.type === 'password';
  input.type = willShow ? 'text' : 'password';
  button.innerHTML = settingsIcon(willShow ? 'eyeOff' : 'eye');
  button.setAttribute('aria-label', willShow ? 'Hide password' : 'Show password');
  button.setAttribute('title', willShow ? 'Hide password' : 'Show password');
}

function resetChangePasswordForm() {
  const form = document.getElementById('changePasswordForm');
  if (form) form.reset();
}

function loadChangePasswordSection() {
  ensureChangePasswordSection();
  const input = document.getElementById('currentPasswordInput');
  if (input) {
    setTimeout(() => input.focus({ preventScroll: true }), 0);
  }
}

async function submitChangePassword(event) {
  if (event) event.preventDefault();

  const currentPassword = document.getElementById('currentPasswordInput')?.value || '';
  const newPassword = document.getElementById('newPasswordInput')?.value || '';
  const confirmPassword = document.getElementById('confirmPasswordInput')?.value || '';
  const submitButton = document.getElementById('changePasswordSubmit');

  if (!currentPassword) {
    showNotification('warning', 'Current password is required');
    return;
  }

  if (!newPassword) {
    showNotification('warning', 'New password is required');
    return;
  }

  if (newPassword !== confirmPassword) {
    showNotification('warning', 'New passwords do not match');
    return;
  }

  if (submitButton) submitButton.disabled = true;

  try {
    await apiCall('/api/current-user/password', 'PUT', {
      currentPassword,
      newPassword
    });

    resetChangePasswordForm();
    showNotification('success', 'Password changed');
  } catch (error) {
    showNotification('error', `Failed to change password: ${error.message}`);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

async function setupAdminUserManagementTab() {
  try {
    if (!currentUser) {
      const res = await apiCall('/api/current-user');
      currentUser = res.data;
    }

    if (!currentUser || !currentUser.isAdmin) return;

    ensureUsersNavItem();
    ensureUsersSection();
  } catch (error) {
    console.warn('User management tab not loaded:', error);
  }
}

function ensureUsersNavItem() {
  if (document.querySelector(`[data-section="users"], [onclick="showSection('users')"]`)) return;

  const settingsSection = Array.from(document.querySelectorAll('.nav-section'))
    .find(section => {
      const heading = section.querySelector('h3');
      return heading && heading.textContent.trim() === 'Settings';
    });

  if (!settingsSection) {
    console.warn('Could not find Settings section for Users tab');
    return;
  }

  const usersTab = document.createElement('button');
  usersTab.type = 'button';
  usersTab.className = 'nav-item';
  usersTab.dataset.section = 'users';
  usersTab.innerHTML = `👤 Users`;

  const logoutButton = settingsSection.querySelector(`[onclick="logout()"]`);

  if (logoutButton) {
    settingsSection.insertBefore(usersTab, logoutButton);
  } else {
    settingsSection.appendChild(usersTab);
  }
}

function userRoleOptionsMarkup(selectedRole = 'user') {
  const selected = String(selectedRole || 'user').toLowerCase();
  const roles = isPlatformAdminUser()
    ? ['owner', 'admin', 'manager', 'user']
    : (currentUserRole() === 'admin'
      ? ['admin', 'manager', 'user']
      : ['manager', 'user']);
  return roles.map(role => `
    <option value="${role}" ${role === selected ? 'selected' : ''}>${escapeHtml(userRoleLabel(role))}</option>
  `).join('');
}

function userRoleSummaryMarkup() {
  const roles = isPlatformAdminUser()
    ? ['owner', 'admin', 'manager', 'user']
    : (currentUserRole() === 'admin'
      ? ['admin', 'manager', 'user']
      : ['manager', 'user']);
  return roles.map(role => `
    <span class="user-role-chip user-role-chip-${role}">
      <strong>${escapeHtml(userRoleLabel(role))}</strong>
    </span>
  `).join('<span class="user-role-arrow" aria-hidden="true">/</span>')
    + '<span class="user-role-chip user-role-chip-sales"><strong>Sales</strong></span>';
}

function userActiveBadgeMarkup(user) {
  return user.isActive
    ? '<span class="user-status-badge user-status-active">Active</span>'
    : '<span class="user-status-badge user-status-inactive">Inactive</span>';
}

function ensureUsersSection() {
  if (document.getElementById('users-section')) return;

  const firstSection = document.querySelector('.content-section');
  const sectionParent = firstSection ? firstSection.parentElement : document.body;

  const section = document.createElement('div');
  section.id = 'users-section';
  section.className = 'content-section';

  section.innerHTML = `
    <div class="users-admin-shell">
      <div class="users-admin-hero">
        <div>
          <p class="users-admin-kicker">Settings</p>
          <h2>User Management</h2>
          <div class="user-role-ladder" aria-label="Role hierarchy">${userRoleSummaryMarkup()}</div>
        </div>
        <div class="users-admin-current">
          <span class="users-admin-current-label">Signed in</span>
          <strong>${escapeHtml(currentUser?.username || '')}</strong>
          <div class="users-admin-current-meta">
            ${roleBadgeMarkup(currentUserRole())}
            ${currentUserHasSalesAccess() ? '<span class="user-role-badge user-role-badge-sales">Sales</span>' : ''}
          </div>
        </div>
      </div>

      <section class="users-admin-panel users-admin-list-panel" aria-labelledby="existingUsersHeading">
        <div class="users-admin-toolbar">
          <div>
            <h3 id="existingUsersHeading">Existing Users</h3>
            <p id="usersAdminSummary" class="users-admin-summary"></p>
          </div>
          <div class="users-admin-toolbar-actions">
            <label class="users-admin-search">
              <span class="sr-only">Search users</span>
              <input
                id="usersAdminSearch"
                type="search"
                class="form-input"
                placeholder="Search users..."
                oninput="renderUsersAdminTables()"
                autocomplete="off"
              >
            </label>
            <button class="btn btn-success btn-sm" onclick="openCreateUserModal()">Create User</button>
            <button class="btn btn-secondary btn-sm" onclick="loadUsersAdmin()">Refresh</button>
          </div>
        </div>

        <div id="users-admin-table-container">
          <p class="users-admin-empty">Loading users...</p>
        </div>
      </section>
    </div>
  `;

  sectionParent.appendChild(section);
  ensureCreateUserModal();
  applyPermissionUi();
}

function ensureCreateUserModal() {
  if (document.getElementById('createUserModal')) return;

  const modal = document.createElement('div');
  modal.id = 'createUserModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content users-admin-create-modal">
      <div class="modal-header">
        <h3 class="modal-title">Create User</h3>
        <button class="close-btn" onclick="closeModal('createUserModal')">&times;</button>
      </div>

      <form onsubmit="event.preventDefault(); createUserAdmin();">
        <div class="users-admin-create-grid">
          <div class="form-group">
            <label class="form-label" for="newUserName">Name</label>
            <input id="newUserName" class="form-input" placeholder="Full name" autocomplete="name">
          </div>

          <div class="form-group">
            <label class="form-label" for="newUserUsername">Username</label>
            <input id="newUserUsername" class="form-input" placeholder="Username" autocomplete="off">
          </div>

          <div class="form-group">
            <label class="form-label" for="newUserPhone">Phone number</label>
            <input id="newUserPhone" class="form-input" type="tel" placeholder="+65 9123 4567" autocomplete="tel">
          </div>

          <div class="form-group">
            <label class="form-label" for="newUserPassword">Password</label>
            <input id="newUserPassword" type="password" class="form-input" placeholder="Password" autocomplete="new-password">
          </div>

          ${canCurrentUserManageUsers() ? `
            <div class="form-group">
              <label class="form-label" for="newUserRole">Role</label>
              <select id="newUserRole" class="form-input">${userRoleOptionsMarkup('user')}</select>
            </div>

            <label class="user-admin-switch user-admin-switch-stacked">
              <input id="newUserHasSalesAccess" type="checkbox">
              <span class="user-admin-switch-slider"></span>
              <span class="user-admin-switch-text">Sales</span>
            </label>
          ` : ''}

          <label class="user-admin-switch user-admin-switch-stacked">
            <input id="newUserIsActive" type="checkbox" checked>
            <span class="user-admin-switch-slider"></span>
            <span class="user-admin-switch-text">Active</span>
          </label>

          <div class="form-group platform-admin-only" id="newUserCompanyGroup" data-platform-admin-display="block">
            <label class="form-label" for="newUserCompanyCode">Company</label>
            <select id="newUserCompanyCode" class="form-input"></select>
          </div>
        </div>

        <div class="modal-actions users-admin-create-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal('createUserModal')">Cancel</button>
          <button type="submit" class="btn btn-success">Create User</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);
}

function openCreateUserModal() {
  ensureCreateUserModal();
  const companySelect = document.getElementById('newUserCompanyCode');
  if (companySelect) {
    companySelect.innerHTML = companyOptionsMarkup(currentUser?.company?.code || '');
  }
  openModal('createUserModal');
  setTimeout(() => {
    document.getElementById('newUserName')?.focus();
  }, 100);
}

function setUsersAdminSort(key) {
  if (!isSuperAdminUser() || !['name', 'company'].includes(key)) return;
  if (usersAdminSort.key === key) {
    usersAdminSort.direction = usersAdminSort.direction === 'asc' ? 'desc' : 'asc';
  } else {
    usersAdminSort = { key, direction: 'asc' };
  }
  renderUsersAdminTables();
}

function usersAdminSortHeader(label, key) {
  if (!isSuperAdminUser()) return `<th>${label}</th>`;
  const active = usersAdminSort.key === key;
  const arrow = active ? (usersAdminSort.direction === 'asc' ? '&#9650;' : '&#9660;') : '&#8597;';
  const ariaSort = active ? (usersAdminSort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
  return `
    <th aria-sort="${ariaSort}">
      <button type="button" class="users-admin-sort" onclick="setUsersAdminSort('${key}')">
        ${label}<span aria-hidden="true">${arrow}</span>
      </button>
    </th>
  `;
}

function usersAdminTableHeader() {
  return `
    <thead>
      <tr>
        ${usersAdminSortHeader('Name', 'name')}
        <th>Username</th>
        <th>Phone</th>
        <th>Role</th>
        <th>Sales</th>
        ${isSuperAdminUser() ? usersAdminSortHeader('Company', 'company') : ''}
        <th>Active</th>
        <th>Last Online</th>
        <th>Actions</th>
      </tr>
    </thead>
  `;
}

function formatUserLastOnline(value) {
  const raw = String(value || '-').trim();
  if (!raw || raw === '-') return '-';

  const timestamp = new Date(raw);
  if (Number.isNaN(timestamp.getTime())) return escapeHtml(raw);

  try {
    return escapeHtml(new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(timestamp));
  } catch (error) {
    return escapeHtml(timestamp.toLocaleString());
  }
}

function usersAdminRowMarkup(user, index) {
  const rowId = `userrow-${index}`;
  const isSelf = Boolean(
    currentUser
    && currentUser.username === user.username
    && String(currentUser.company?.code || currentUser.companyCode || '').toUpperCase()
      === String(user.companyCode || '').toUpperCase()
  );
  const role = String(user.role || (user.isSuperAdmin || user.isAdmin ? 'admin' : 'user')).toLowerCase();
  const isProtectedAccount = Boolean(user.isSuperAdmin);
  const canEditUser = canCurrentUserManageUser(user);
  const canEditRole = canEditUser && (
    !isProtectedAccount || (isPlatformAdminUser() && !isSelf)
  );
  const rawLastOnline = String(user.lastOnline || '-');
  const lastOnlineDisplay = formatUserLastOnline(rawLastOnline);
  const displayName = String(user.name || '').trim();

  return `
    <tr data-user-admin-row data-original-username="${escapeHtmlAttr(user.username)}" data-original-company-code="${escapeHtmlAttr(user.companyCode || '')}">
      <td>
        <input
          type="text"
          id="name-${rowId}"
          class="form-input user-admin-name-input"
          data-user-admin-autosave="name"
          value="${escapeHtmlAttr(displayName)}"
          placeholder="Name"
          ${canEditUser ? '' : 'disabled'}
        >
      </td>
      <td>
        <input
          type="text"
          id="username-${rowId}"
          class="form-input user-admin-username-input"
          data-user-admin-autosave="username"
          value="${escapeHtmlAttr(user.username)}"
          ${canEditUser ? '' : 'disabled'}
        >
        ${isSelf ? '<span style="font-size:11px;color:#666;margin-left:6px;">(you)</span>' : ''}
        <div class="users-admin-inline-meta">${userActiveBadgeMarkup(user)}</div>
      </td>
      <td>
        <input
          type="tel"
          id="phone-${rowId}"
          class="form-input user-admin-phone-input"
          data-user-admin-autosave="phone"
          value="${escapeHtmlAttr(user.phone || '')}"
          placeholder="+65 9123 4567"
          autocomplete="tel"
          ${canEditUser ? '' : 'disabled'}
        >
      </td>
      <td>
        ${canEditRole ? `
          <select id="role-${rowId}" class="form-input user-admin-role-select" data-user-admin-autosave="role">
            ${userRoleOptionsMarkup(role)}
          </select>
        ` : roleBadgeMarkup(role)}
      </td>
      <td>
        <label class="user-admin-switch user-admin-switch-compact">
          <input type="checkbox" id="sales-${rowId}" data-user-admin-autosave="sales" ${user.hasSalesAccess || user.isSales ? 'checked' : ''} ${canEditRole ? '' : 'disabled'}>
          <span class="user-admin-switch-slider"></span>
          <span class="user-admin-switch-text">Sales</span>
        </label>
      </td>
      ${isSuperAdminUser() ? `
        <td>
          <select id="company-${rowId}" class="form-input" data-user-admin-autosave="company" ${canEditUser ? '' : 'disabled'}>
            ${companyOptionsMarkup(user.companyCode || currentUser?.company?.code || '')}
          </select>
        </td>
      ` : ''}
      <td>
        <label class="user-admin-switch user-admin-switch-compact">
          <input type="checkbox" id="active-${rowId}" data-user-admin-autosave="active" ${user.isActive ? 'checked' : ''} ${canEditUser ? '' : 'disabled'}>
          <span class="user-admin-switch-slider"></span>
          <span class="user-admin-switch-text">Active</span>
        </label>
      </td>
      <td class="user-admin-last-online" title="${rawLastOnline === '-' ? '' : escapeHtmlAttr(rawLastOnline)}">
        ${lastOnlineDisplay}
      </td>
      <td class="users-admin-actions">
        <span class="user-admin-save-status is-saved" data-user-admin-save-status role="status" aria-live="polite"><span class="user-admin-save-mark" aria-hidden="true"></span><span data-user-admin-save-label>Saved</span></span>
        <span class="users-admin-action-buttons">
          <button type="button" class="btn btn-warning btn-sm" onclick="openResetPasswordModal(encodeURIComponent(this.closest('[data-user-admin-row]').dataset.originalUsername), this.closest('[data-user-admin-row]').dataset.originalCompanyCode)" ${canEditUser ? '' : 'disabled'}>Reset Password</button>
          <button type="button" class="btn btn-danger btn-sm" onclick="deleteUserAdmin(encodeURIComponent(this.closest('[data-user-admin-row]').dataset.originalUsername), this.closest('[data-user-admin-row]').dataset.originalCompanyCode)" ${(isSelf || !canEditUser) ? 'disabled title="This account cannot be deleted here"' : ''}>Delete</button>
        </span>
      </td>
    </tr>
  `;
}

function sortedUsersAdmin(users) {
  const direction = usersAdminSort.direction === 'desc' ? -1 : 1;
  return [...users].sort((left, right) => {
    const leftValue = usersAdminSort.key === 'company'
      ? (left.companyName || left.companyCode || '')
      : (left.name || left.username || '');
    const rightValue = usersAdminSort.key === 'company'
      ? (right.companyName || right.companyCode || '')
      : (right.name || right.username || '');
    const primary = String(leftValue).localeCompare(String(rightValue), undefined, { sensitivity: 'base', numeric: true });
    if (primary) return primary * direction;
    return String(left.username || '').localeCompare(String(right.username || ''), undefined, { sensitivity: 'base', numeric: true });
  });
}

function renderUsersAdminTables() {
  const container = document.getElementById('users-admin-table-container');
  if (!container) return;

  const search = (document.getElementById('usersAdminSearch')?.value || '').trim().toLocaleLowerCase();
  const inactiveWasOpen = document.getElementById('inactiveUsersDropdown')?.open || false;
  const filtered = usersAdminUsers.filter(user => {
    if (!search) return true;
    return [user.name, user.username, user.phone, user.companyCode, user.companyName, user.roleLabel, user.hasSalesAccess ? 'sales' : '']
      .some(value => String(value || '').toLocaleLowerCase().includes(search));
  });
  const sorted = isSuperAdminUser() ? sortedUsersAdmin(filtered) : filtered;
  const activeUsers = sorted.filter(user => user.isActive);
  const inactiveUsers = sorted.filter(user => !user.isActive);
  const inactiveTotal = usersAdminUsers.filter(user => !user.isActive).length;
  const inactiveLabel = search && inactiveUsers.length !== inactiveTotal
    ? `Inactive Users (${inactiveUsers.length} of ${inactiveTotal})`
    : `Inactive Users (${inactiveTotal})`;
  updateUsersAdminSummary();

  const activeMarkup = activeUsers.length
    ? `<div class="users-admin-table-scroll"><table class="table">${usersAdminTableHeader()}<tbody>${activeUsers.map(usersAdminRowMarkup).join('')}</tbody></table></div>`
    : `<p class="users-admin-empty">${search ? 'No active users match your search.' : 'No active users found.'}</p>`;
  const inactiveMarkup = inactiveUsers.length
    ? `<div class="users-admin-table-scroll"><table class="table">${usersAdminTableHeader()}<tbody>${inactiveUsers.map((user, index) => usersAdminRowMarkup(user, activeUsers.length + index)).join('')}</tbody></table></div>`
    : `<p class="users-admin-empty">${search ? 'No inactive users match your search.' : 'No inactive users.'}</p>`;

  container.innerHTML = `
    ${activeMarkup}
    <details id="inactiveUsersDropdown" class="inactive-users-dropdown" ${(inactiveWasOpen || (search && inactiveUsers.length)) ? 'open' : ''}>
      <summary>${inactiveLabel}</summary>
      <div class="inactive-users-content">${inactiveMarkup}</div>
    </details>
  `;
  bindUsersAdminAutosave(container);
}

function updateUsersAdminSummary() {
  const summary = document.getElementById('usersAdminSummary');
  if (!summary) return;
  const activeTotal = usersAdminUsers.filter(user => user.isActive).length;
  const inactiveTotal = usersAdminUsers.length - activeTotal;
  const salesTotal = usersAdminUsers.filter(user => user.hasSalesAccess || user.isSales).length;
  summary.textContent = `${activeTotal} active / ${inactiveTotal} inactive / ${salesTotal} sales`;
}

function collectUserAdminRowPayload(row) {
  const field = name => row.querySelector(`[data-user-admin-autosave="${name}"]`);
  const payload = {
    name: field('name')?.value.trim() || '',
    phone: field('phone')?.value.trim() || '',
    username: field('username')?.value.trim() || '',
    isActive: Boolean(field('active')?.checked),
    sourceCompanyCode: row.dataset.originalCompanyCode || '',
  };
  const role = field('role')?.value || '';
  if (canCurrentUserManageUsers() && role) {
    payload.role = role;
    payload.hasSalesAccess = Boolean(field('sales')?.checked);
  }
  const companyCode = field('company')?.value || '';
  if (isSuperAdminUser() && companyCode) payload.companyCode = companyCode;
  return payload;
}

function userAdminPayloadFingerprint(payload) {
  return JSON.stringify(payload);
}

function setUserAdminSaveStatus(row, status, label, detail = '') {
  const indicator = row.querySelector('[data-user-admin-save-status]');
  if (!indicator) return;
  indicator.className = `user-admin-save-status is-${status}`;
  indicator.title = detail;
  const text = indicator.querySelector('[data-user-admin-save-label]');
  if (text) text.textContent = label;
}

function scheduleUserAdminAutosave(row, delay = USERS_ADMIN_AUTOSAVE_DELAY) {
  const state = row.__userAdminAutosaveState;
  if (!state || !row.isConnected) return;
  clearTimeout(state.timer);
  setUserAdminSaveStatus(row, state.inFlight ? 'saving' : 'pending', state.inFlight ? 'Saving' : 'Unsaved');
  state.timer = setTimeout(() => flushUserAdminAutosave(row), Math.max(0, delay));
}

function applyUserAdminSavedData(row, endpointUsername, submittedPayload, responseData) {
  const saved = responseData || {};
  const savedUsername = String(saved.username || submittedPayload.username || endpointUsername);
  const sourceCompanyCode = String(row.dataset.originalCompanyCode || '').toUpperCase();
  const savedCompanyCode = String(saved.companyCode || submittedPayload.companyCode || sourceCompanyCode).toUpperCase();
  const userIndex = usersAdminUsers.findIndex(user => {
    const usernameMatches = user.username === endpointUsername || user.username === savedUsername;
    const userCompanyCode = String(user.companyCode || '').toUpperCase();
    return usernameMatches && (
      !sourceCompanyCode
      || userCompanyCode === sourceCompanyCode
      || userCompanyCode === savedCompanyCode
    );
  });
  const companyCode = saved.companyCode || submittedPayload.companyCode || usersAdminUsers[userIndex]?.companyCode || '';
  const company = companyOptions.find(item => String(item.code || '').toUpperCase() === String(companyCode).toUpperCase());
  const merged = {
    ...(userIndex >= 0 ? usersAdminUsers[userIndex] : {}),
    ...submittedPayload,
    ...saved,
    username: savedUsername,
    companyCode,
    companyName: company?.name || usersAdminUsers[userIndex]?.companyName || companyCode,
  };
  if (userIndex >= 0) usersAdminUsers[userIndex] = merged;
  row.dataset.originalUsername = savedUsername;
  row.dataset.originalCompanyCode = companyCode;
  const activeMeta = row.querySelector('.users-admin-inline-meta');
  if (activeMeta) activeMeta.innerHTML = userActiveBadgeMarkup(merged);
  updateUsersAdminSummary();

  if (
    currentUser?.username === endpointUsername
    && String(currentUser.company?.code || currentUser.companyCode || '').toUpperCase() === sourceCompanyCode
  ) {
    currentUser = { ...currentUser, ...saved, username: savedUsername };
    refreshSidebarUserMenu();
  }
}

function applyUserAdminResponseToUnchangedRow(row, responseData) {
  if (!responseData) return;
  const field = name => row.querySelector(`[data-user-admin-autosave="${name}"]`);
  if (field('name')) field('name').value = responseData.name || '';
  if (field('username')) field('username').value = responseData.username || '';
  if (field('phone')) field('phone').value = responseData.phone || '';
  if (field('role') && responseData.role) field('role').value = responseData.role;
  if (field('sales')) field('sales').checked = Boolean(responseData.hasSalesAccess || responseData.isSales);
  if (field('company') && responseData.companyCode) field('company').value = responseData.companyCode;
  if (field('active')) field('active').checked = Boolean(responseData.isActive);
}

async function flushUserAdminAutosave(row) {
  const state = row.__userAdminAutosaveState;
  if (!state || !row.isConnected) return;
  clearTimeout(state.timer);
  state.timer = null;

  const payload = collectUserAdminRowPayload(row);
  const requestFingerprint = userAdminPayloadFingerprint(payload);
  if (!payload.username) {
    setUserAdminSaveStatus(row, 'error', 'Not saved', 'Username cannot be empty');
    return;
  }
  if (requestFingerprint === state.lastSavedFingerprint) {
    setUserAdminSaveStatus(row, 'saved', 'Saved');
    return;
  }
  if (state.inFlight) {
    state.queued = true;
    return;
  }

  state.inFlight = true;
  state.queued = false;
  const endpointUsername = state.originalUsername;
  let saveSucceeded = false;
  setUserAdminSaveStatus(row, 'saving', 'Saving');

  try {
    const updateResult = await apiCall(`/api/users/${encodeURIComponent(endpointUsername)}`, 'PUT', payload);
    const unchangedSinceRequest = userAdminPayloadFingerprint(collectUserAdminRowPayload(row)) === requestFingerprint;
    state.originalUsername = String(updateResult?.data?.username || payload.username || endpointUsername);
    state.lastSavedFingerprint = requestFingerprint;
    applyUserAdminSavedData(row, endpointUsername, payload, updateResult?.data);
    if (unchangedSinceRequest) {
      applyUserAdminResponseToUnchangedRow(row, updateResult?.data);
      state.lastSavedFingerprint = userAdminPayloadFingerprint(collectUserAdminRowPayload(row));
    }
    saveSucceeded = true;
    setUserAdminSaveStatus(
      row,
      'saved',
      updateResult?.data?.selfChangesPending ? 'Saved; re-login required' : 'Saved'
    );
  } catch (error) {
    const unchangedSinceRequest = userAdminPayloadFingerprint(collectUserAdminRowPayload(row)) === requestFingerprint;
    if (unchangedSinceRequest) {
      try {
        applyUserAdminResponseToUnchangedRow(
          row,
          JSON.parse(state.lastSavedFingerprint),
        );
      } catch (_parseError) {
        // Keep the row editable if an older cached fingerprint cannot be restored.
      }
    }
    setUserAdminSaveStatus(row, 'error', 'Not saved', error.message || 'Unable to save this user');
    showNotification('warning', error.message || 'Unable to save this user');
  } finally {
    state.inFlight = false;
    if (!row.isConnected) return;
    const currentFingerprint = userAdminPayloadFingerprint(collectUserAdminRowPayload(row));
    if (state.queued || (saveSucceeded && currentFingerprint !== state.lastSavedFingerprint)) {
      state.queued = false;
      scheduleUserAdminAutosave(row, 0);
    }
  }
}

function bindUsersAdminAutosave(root) {
  root.querySelectorAll('[data-user-admin-row]').forEach(row => {
    const initialPayload = collectUserAdminRowPayload(row);
    row.__userAdminAutosaveState = {
      timer: null,
      inFlight: false,
      queued: false,
      originalUsername: row.dataset.originalUsername || initialPayload.username,
      lastSavedFingerprint: userAdminPayloadFingerprint(initialPayload),
    };

    row.querySelectorAll('[data-user-admin-autosave]:not([disabled])').forEach(control => {
      const field = control.dataset.userAdminAutosave;
      if (field === 'name') {
        control.addEventListener('input', () => scheduleUserAdminAutosave(row));
      } else if (field === 'username' || field === 'phone') {
        control.addEventListener('input', () => setUserAdminSaveStatus(row, 'pending', 'Unsaved'));
      }
      control.addEventListener('change', () => scheduleUserAdminAutosave(row, 0));
      if (control.matches('input[type="text"], input[type="tel"]')) {
        control.addEventListener('blur', () => scheduleUserAdminAutosave(row, 0));
        control.addEventListener('keydown', event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          control.blur();
        });
      }
    });
  });
}

async function loadUsersAdmin() {
  const container = document.getElementById('users-admin-table-container');
  if (!container) return;

  ensureUserAdminStyles();
  container.innerHTML = '<p style="text-align:center;color:#666;padding:30px;">Loading users...</p>';

  try {
    if (isSuperAdminUser()) {
      await fetchCompanies(true);
      const newUserCompany = document.getElementById('newUserCompanyCode');
      if (newUserCompany) {
        newUserCompany.innerHTML = companyOptionsMarkup(currentUser?.company?.code || '');
      }
    }

    const res = await apiCall('/api/users');
    usersAdminUsers = res.data || [];
    renderUsersAdminTables();
  } catch (error) {
    container.innerHTML = `<p style="color:red;text-align:center;padding:30px;">Failed to load users: ${escapeHtml(error.message)}</p>`;
  }
}

async function createUserAdmin() {
  const name = document.getElementById('newUserName')?.value.trim() || '';
  const username = document.getElementById('newUserUsername')?.value.trim();
  const phone = document.getElementById('newUserPhone')?.value.trim() || '';
  const password = document.getElementById('newUserPassword')?.value;
  const role = document.getElementById('newUserRole')?.value || 'user';
  const hasSalesAccess = document.getElementById('newUserHasSalesAccess')?.checked || false;
  const isActive = document.getElementById('newUserIsActive')?.checked || false;
  const companyCode = document.getElementById('newUserCompanyCode')?.value || currentUser?.company?.code || '';

  if (!username) {
    showNotification('warning', 'Username is required');
    return;
  }

  if (!password) {
    showNotification('warning', 'Password is required');
    return;
  }

  try {
    const payload = {
      name,
      phone,
      username,
      password,
      isActive
    };
    if (canCurrentUserManageUsers()) {
      payload.role = role;
      payload.hasSalesAccess = hasSalesAccess;
    }
    if (isSuperAdminUser()) {
      payload.companyCode = companyCode;
    }

    let createResponse;
    try {
      createResponse = await apiCall('/api/users', 'POST', payload);
    } catch (error) {
      if (!error.payload?.requiresHistoryInheritanceConfirmation) throw error;
      const counts = error.payload.historyCounts || {};
      const confirmed = await showAppConfirm({
        title: 'Inherit prior records?',
        message: `${error.message}\n\nFound ${counts.systemLogs || 0} system log(s), ${counts.eventLogs || 0} event log(s), ${counts.maintenanceLogs || 0} maintenance log(s), and ${counts.quotes || 0} quotation(s).`,
        confirmText: 'Create and inherit',
        cancelText: 'Cancel',
        variant: 'warning',
      });
      if (!confirmed) return;
      createResponse = await apiCall('/api/users', 'POST', {
        ...payload,
        inheritHistory: true,
      });
    }

    showNotification('success', `User ${username} created`);

    document.getElementById('newUserName').value = '';
    document.getElementById('newUserUsername').value = '';
    document.getElementById('newUserPhone').value = '';
    document.getElementById('newUserPassword').value = '';
    if (document.getElementById('newUserRole')) {
      document.getElementById('newUserRole').value = 'user';
    }
    if (document.getElementById('newUserHasSalesAccess')) {
      document.getElementById('newUserHasSalesAccess').checked = false;
    }
    document.getElementById('newUserIsActive').checked = true;
    if (document.getElementById('newUserCompanyCode')) {
      document.getElementById('newUserCompanyCode').value = currentUser?.company?.code || '';
    }
    closeModal('createUserModal');

    await loadUsersAdmin();

  } catch (error) {
    showNotification('error', `Failed to create user: ${error.message}`);
  }
}

async function createCompanyFromUsersAdmin() {
  const code = document.getElementById('userNewCompanyCode')?.value.trim() || '';
  const name = document.getElementById('userNewCompanyName')?.value.trim() || '';
  const firstAdminUsername = document.getElementById('userNewCompanyFirstAdmin')?.value.trim() || '';
  const firstAdminPassword = document.getElementById('userNewCompanyFirstAdminPassword')?.value || '';

  if (!code && !name) {
    showNotification('warning', 'Company code or name is required');
    return;
  }
  if (!firstAdminUsername) {
    showNotification('warning', 'A first admin username is required');
    return;
  }

  try {
    await apiCall('/api/companies', 'POST', {
      code,
      name,
      firstAdminUsername,
      firstAdminPassword
    });

    ['userNewCompanyCode', 'userNewCompanyName', 'userNewCompanyFirstAdmin', 'userNewCompanyFirstAdminPassword'].forEach(id => {
      const input = document.getElementById(id);
      if (input) input.value = '';
    });

    closeModal('createCompanyModal');
    showNotification('success', 'Company created');
    await loadCompaniesAdmin();
    if (document.getElementById('users-section')) {
      await loadUsersAdmin();
    }
  } catch (error) {
    showNotification('error', `Failed to create company: ${error.message}`);
  }
}

async function editCompanyFromUsersAdmin() {
  const originalCode = document.getElementById('userEditCompanyOriginalCode')?.value || '';
  const code = document.getElementById('userEditCompanyCode')?.value.trim() || '';
  const name = document.getElementById('userEditCompanyName')?.value.trim() || '';

  if (!originalCode) {
    showNotification('warning', 'Choose a company first');
    return;
  }
  if (!code) {
    showNotification('warning', 'Company code is required');
    return;
  }
  if (!name) {
    showNotification('warning', 'Company name is required');
    return;
  }

  try {
    const response = await apiCall(`/api/companies/${encodeURIComponent(originalCode)}`, 'PUT', { code, name });
    const renamedActiveCompany = String(currentUser?.company?.code || '').toUpperCase() === String(originalCode).toUpperCase()
      && String(response?.data?.code || '').toUpperCase() !== String(originalCode).toUpperCase();
    closeModal('editCompanyModal');
    showNotification('success', 'Company updated');
    if (renamedActiveCompany) {
      window.location.reload();
      return;
    }
    await loadCompaniesAdmin();
    if (document.getElementById('users-section')) {
      await loadUsersAdmin();
    }
  } catch (error) {
    showNotification('error', `Failed to update company: ${error.message}`);
  }
}

async function deleteCompanyFromUsersAdmin() {
  const code = document.getElementById('userDeleteCompanyCode')?.value || '';
  if (!code) {
    showNotification('warning', 'Choose a company first');
    return;
  }

  const company = (companyOptions || []).find(item => String(item.code || '').toUpperCase() === String(code).toUpperCase());
  await deleteCompanyAdmin(code, Boolean(company?.isActive), companyOptions.length);
}

async function resetUserPasswordAdmin(encodedOriginalUsername, newPassword, companyCode = '') {
  const originalUsername = decodeURIComponent(encodedOriginalUsername);

  if (!newPassword) {
    showNotification('warning', 'Enter a new password first');
    return;
  }

  try {
    await apiCall(`/api/users/${encodeURIComponent(originalUsername)}/password?companyCode=${encodeURIComponent(companyCode)}`, 'PUT', {
      password: newPassword
    });

    showNotification('success', `Password reset for ${originalUsername}`);
    closeModal('resetUserPasswordModal');

  } catch (error) {
    showNotification('error', `Failed to reset password: ${error.message}`);
  }
}

function ensureResetPasswordModal() {
  if (document.getElementById('resetUserPasswordModal')) return;

  const modal = document.createElement('div');
  modal.id = 'resetUserPasswordModal';
  modal.className = 'modal';

  modal.innerHTML = `
    <div class="modal-content" style="max-width:420px;">
      <div class="modal-header">
        <h3>Reset User Password</h3>
      </div>

      <div class="modal-body">
        <p style="margin-bottom:12px;">
          Enter a new password for <strong id="resetPasswordUsernameLabel"></strong>.
        </p>

        <div class="form-group">
          <label class="form-label">New Password</label>
          <input
            id="resetUserPasswordInput"
            type="password"
            class="form-input"
            placeholder="Enter new password"
            onkeypress="if(event.key==='Enter') confirmResetPasswordModal()"
          >
        </div>
      </div>

      <div class="modal-footer modal-actions">
        <button class="btn btn-secondary" onclick="closeModal('resetUserPasswordModal')">Cancel</button>
        <button class="btn btn-warning" onclick="confirmResetPasswordModal()">Reset Password</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

function openResetPasswordModal(encodedOriginalUsername, companyCode = '') {
  ensureResetPasswordModal();

  const username = decodeURIComponent(encodedOriginalUsername);

  document.getElementById('resetPasswordUsernameLabel').textContent = username;
  document.getElementById('resetUserPasswordInput').value = '';

  const modal = document.getElementById('resetUserPasswordModal');
  modal.dataset.encodedUsername = encodedOriginalUsername;
  modal.dataset.companyCode = companyCode;

  openModal('resetUserPasswordModal');

  setTimeout(() => {
    document.getElementById('resetUserPasswordInput')?.focus();
  }, 100);
}

function confirmResetPasswordModal() {
  const modal = document.getElementById('resetUserPasswordModal');
  const encodedOriginalUsername = modal.dataset.encodedUsername;
  const newPassword = document.getElementById('resetUserPasswordInput')?.value || '';

  resetUserPasswordAdmin(encodedOriginalUsername, newPassword, modal.dataset.companyCode || '');
}

async function deleteUserAdmin(encodedOriginalUsername, companyCode = '') {
  const username = decodeURIComponent(encodedOriginalUsername);

  if (currentUser && currentUser.username === username) {
    showNotification('warning', 'You cannot delete your own account');
    return;
  }

  const confirmed = await showAppConfirm({
    title: 'Delete User',
    message: `Delete user "${username}"? This cannot be undone.`,
    confirmText: 'Delete',
    cancelText: 'Cancel',
    variant: 'danger',
  });
  if (!confirmed) return;

  try {
    await apiCall(`/api/users/${encodeURIComponent(username)}?companyCode=${encodeURIComponent(companyCode)}`, 'DELETE');

    showNotification('success', `Deleted user ${username}`);
    await loadUsersAdmin();

  } catch (error) {
    showNotification('error', `Failed to delete user: ${error.message}`);
  }
}


function ensureUserAdminStyles() {
  if (document.getElementById('user-admin-switch-styles')) return;

  const style = document.createElement('style');
  style.id = 'user-admin-switch-styles';
  style.textContent = `
    .users-admin-shell {
      display: grid;
      gap: 18px;
    }

    .users-admin-hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 18px;
      padding-bottom: 16px;
      border-bottom: 1px solid #e4e7ec;
    }

    .users-admin-kicker {
      margin: 0 0 6px;
      color: #667085;
      font-size: 12px;
      font-weight: 750;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    .users-admin-hero h2,
    .users-admin-panel h3 {
      margin: 0;
      color: #101828;
    }

    .users-admin-current {
      min-width: min(260px, 100%);
      padding: 12px;
      border: 1px solid #d0d5dd;
      border-radius: 8px;
      background: #fff;
    }

    .users-admin-current-label,
    .users-admin-summary,
    .users-admin-inline-meta {
      color: #667085;
      font-size: 12px;
    }

    .users-admin-current strong {
      display: block;
      margin-top: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #101828;
    }

    .users-admin-current-meta,
    .user-role-ladder {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }

    .user-role-chip {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 4px 9px;
      border: 1px solid #d0d5dd;
      border-radius: 999px;
      background: #fff;
      color: #344054;
      font-size: 12px;
    }

    .user-role-arrow {
      color: #98a2b3;
      font-weight: 700;
    }

    .user-role-chip-owner { border-color: #f2c879; background: #fff7e6; color: #8a4b08; }
    .user-role-chip-admin { border-color: #c7d7fe; background: #eef4ff; color: #3538cd; }
    .user-role-chip-manager { border-color: #abefc6; background: #ecfdf3; color: #027a48; }
    .user-role-chip-sales { border-color: #fcceee; background: #fdf2fa; color: #c11574; }

    .users-admin-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 18px;
      align-items: start;
    }

    .users-admin-panel {
      border: 1px solid #d0d5dd;
      border-radius: 8px;
      background: #fff;
      padding: 16px;
    }

    .users-admin-list-panel {
      min-width: 0;
    }

    .users-admin-create-modal {
      max-width: 640px;
    }

    .users-admin-create-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 14px;
    }

    .users-admin-create-actions {
      margin-top: 14px;
      display: flex;
      justify-content: flex-end;
    }

    .user-admin-role-select {
      min-width: 136px;
    }

    .user-status-badge {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
    }

    .user-status-active {
      color: #027a48;
      background: #ecfdf3;
    }

    .user-status-inactive {
      color: #667085;
      background: #f2f4f7;
    }

    .user-admin-switch {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }

    .user-admin-switch-stacked {
      align-self: end;
      min-height: 44px;
      padding-bottom: 8px;
    }

    .user-admin-switch-compact {
      white-space: nowrap;
    }

    .user-admin-switch input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }

    .user-admin-switch-slider {
      position: relative;
      width: 46px;
      height: 24px;
      border-radius: 999px;
      background: #ccc;
      transition: background 0.2s ease;
      flex-shrink: 0;
    }

    .user-admin-switch-slider::before {
      content: "";
      position: absolute;
      width: 20px;
      height: 20px;
      left: 2px;
      top: 2px;
      border-radius: 50%;
      background: white;
      transition: transform 0.2s ease;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }

    .user-admin-switch input:checked + .user-admin-switch-slider {
      background: #28a745;
    }

    .user-admin-switch input:checked + .user-admin-switch-slider::before {
      transform: translateX(22px);
    }

    .user-admin-switch input:disabled + .user-admin-switch-slider {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .user-admin-switch-text {
      font-size: 13px;
      color: #333;
    }

    .user-admin-name-input,
    .user-admin-username-input {
      max-width: 220px;
      min-width: 160px;
    }

    .users-admin-toolbar,
    .users-admin-toolbar-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .users-admin-toolbar {
      margin-bottom: 15px;
    }

    .users-admin-search {
      min-width: min(320px, 70vw);
    }

    .users-admin-sort {
      appearance: none;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      font-weight: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 0;
    }

    .users-admin-sort:hover,
    .users-admin-sort:focus-visible {
      color: #485fc7;
    }

    .users-admin-table-scroll {
      overflow-x: auto;
    }

    .users-admin-table-scroll .table th,
    .users-admin-table-scroll .table td {
      vertical-align: middle;
    }

    .users-admin-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
    }

    .users-admin-action-buttons {
      display: inline-flex;
      flex-direction: column;
      align-items: stretch;
      gap: 6px;
    }

    .users-admin-action-buttons .btn {
      width: 100%;
    }

    .user-admin-save-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 72px;
      color: #667085;
      font-size: 12px;
      font-weight: 650;
    }

    .user-admin-save-mark {
      width: 8px;
      height: 8px;
      flex: 0 0 8px;
      border-radius: 50%;
      background: currentColor;
    }

    .user-admin-save-status.is-saved {
      color: #16845b;
    }

    .user-admin-save-status.is-pending {
      color: #b56b0b;
    }

    .user-admin-save-status.is-error {
      color: #c43d4b;
    }

    .user-admin-save-status.is-saving {
      color: #475467;
    }

    .user-admin-save-status.is-saving .user-admin-save-mark {
      width: 11px;
      height: 11px;
      flex-basis: 11px;
      border: 2px solid #d0d5dd;
      border-top-color: #16845b;
      background: transparent;
      animation: user-admin-saving-spin 600ms linear infinite;
    }

    @keyframes user-admin-saving-spin {
      to { transform: rotate(360deg); }
    }

    @media (prefers-reduced-motion: reduce) {
      .user-admin-save-status.is-saving .user-admin-save-mark {
        animation: none;
      }
    }

    .user-admin-last-online {
      white-space: nowrap;
      color: #475467;
      font-size: 13px;
    }

    .users-admin-empty {
      text-align: center;
      color: #667085;
      padding: 30px;
      margin: 0;
    }

    .inactive-users-dropdown {
      margin-top: 20px;
      border: 1px solid #dfe3e8;
      border-radius: 8px;
      overflow: hidden;
      background: #fafbfc;
    }

    .inactive-users-dropdown > summary {
      cursor: pointer;
      padding: 14px 16px;
      font-weight: 600;
      color: #475467;
      user-select: none;
    }

    .inactive-users-dropdown[open] > summary {
      border-bottom: 1px solid #dfe3e8;
    }

    .inactive-users-content {
      background: #fff;
    }

    .inactive-users-content .table {
      margin-bottom: 0;
    }

    @media (max-width: 640px) {
      .users-admin-hero,
      .users-admin-toolbar-actions,
      .users-admin-search {
        width: 100%;
      }

      .users-admin-hero {
        flex-direction: column;
      }

      .users-admin-grid {
        grid-template-columns: 1fr;
      }

      .users-admin-create-grid {
        grid-template-columns: 1fr;
      }
    }
  `;

  document.head.appendChild(style);
}
