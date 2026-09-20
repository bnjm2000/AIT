/* Personal statistics across all companies. Amounts are grouped by submission
 * date, never presented as payment-date cash flow or company pay comparisons. */
const WorkerStatistics = (() => {
  const views = new WeakMap();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const states = [
    { key: 'received', label: 'Receipt confirmed', colour: '#9333ea' },
    { key: 'paid', label: 'Paid · confirm receipt', colour: '#3b82f6' },
    { key: 'approved', label: 'Approved · awaiting payment', colour: '#8b5cf6' },
    { key: 'review', label: 'Awaiting review', colour: '#f59e0b' },
    { key: 'details', label: 'Needs attention', colour: '#f97316' },
    { key: 'denied', label: 'Denied', colour: '#e05268' }
  ];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const currency = cents => `$${(cents / 100).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const compact = cents => `$${(cents / 100).toLocaleString('en-SG', { notation: 'compact', maximumFractionDigits: 1 })}`;
  const files = count => `${count} file${count === 1 ? '' : 's'}`;
  const percent = (value, total) => total ? Math.min(100, value / total * 100) : 0;

  function dateKey(value) {
    const raw = String(value || '').trim();
    // Event dates may be YYYYMMDD or YYYY/MM/DD. Date-only values are calendar dates.
    const calendar = raw.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/);
    if (calendar) {
      const [, year, month, day] = calendar;
      const key = `${year}-${month}-${day}`;
      const date = new Date(`${key}T12:00:00Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === key ? key : '';
    }
    if (!/^\d{4}-\d{2}-\d{2}T/.test(raw)) return '';
    // Legacy timestamps with no offset were written in the app's Singapore time.
    const timestamp = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}+08:00`;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const part = type => parts.find(item => item.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  function personalEvents(companies) {
    const seen = new Set();
    return (companies || []).flatMap(company => (company.events || []).filter(event => {
      if (event.subjectType === 'vendor') return false;
      const key = JSON.stringify([company.code, event.id, event.subjectId || company.freelancer?.id]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(event => ({ companyCode: company.code, companyName: company.name || company.code, event })));
  }

  function years(companies) {
    const values = [Number(dateKey(new Date().toISOString()).slice(0, 4))];
    personalEvents(companies).forEach(({ event }) => {
      [event.startDate, ...(event.submissions?.invoices || []).map(row => row.submittedAt),
        ...(event.submissions?.claims || []).map(row => row.submittedAt)].forEach(value => {
        const key = dateKey(value);
        if (key) values.push(Number(key.slice(0, 4)));
      });
    });
    return [...new Set(values)].sort((a, b) => b - a);
  }

  function status(row) {
    if (row.status === 'Payment Confirmed' || row.paymentConfirmedAt) return 'received';
    if (row.adminStatus === 'Paid' || row.status === 'Paid') return 'paid';
    if (row.adminStatus === 'Approved' || row.status === 'Approved') return 'approved';
    if (row.adminStatus === 'Denied' || row.status === 'Denied') return 'denied';
    if (row.needsDetails || row.submissionStage === 'Details Required'
      || ['Details Required', 'Failed'].includes(row.status)
      || ['Failed', 'Manual Required'].includes(row.processingState)) return 'details';
    return 'review';
  }

  function build(companies, selection) {
    const monthly = selection.period === 'month';
    const periodKey = monthly ? String(selection.month || '') : String(selection.year || '');
    const valid = monthly ? /^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey) : /^\d{4}$/.test(periodKey);
    if (!valid) return null;
    const year = Number(periodKey.slice(0, 4));
    const month = Number(periodKey.slice(5, 7));
    const length = monthly ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 12;
    const buckets = Array.from({ length }, (_, index) => ({
      label: monthly ? String(index + 1) : months[index],
      fullLabel: monthly ? `${index + 1} ${months[month - 1]}` : months[index],
      invoice: 0, claim: 0, events: 0, files: 0
    }));
    const summary = Object.fromEntries(states.map(state => [state.key, { cents: 0, count: 0 }]));
    const model = {
      monthly, periodKey, buckets, summary, categories: [], rows: [],
      invoice: 0, claim: 0, invoiceCount: 0, claimCount: 0,
      eventCount: 0, unknownAmounts: 0, undatedFiles: 0, undatedEvents: 0,
      vendorExcluded: (companies || []).some(company => company.events?.some(event => event.subjectType === 'vendor')),
      label: monthly ? `${months[month - 1]} ${year}` : String(year)
    };
    const categories = new Map();
    const eventKeys = new Set();
    const rowKeys = new Set();
    const inPeriod = date => date && date.startsWith(periodKey);
    const bucketFor = date => buckets[Number(date.slice(monthly ? 8 : 5, monthly ? 10 : 7)) - 1];
    personalEvents(companies).forEach(({ companyCode, companyName, event }) => {
      const start = dateKey(event.startDate);
      const eventKey = JSON.stringify([companyCode, event.id]);
      if (!eventKeys.has(eventKey)) {
        eventKeys.add(eventKey);
        if (!start) model.undatedEvents += 1;
        if (inPeriod(start)) {
          model.eventCount += 1;
          bucketFor(start).events += 1;
        }
      }
      for (const [plural, kind] of [['invoices', 'invoice'], ['claims', 'claim']]) {
        (event.submissions?.[plural] || []).forEach((row, index) => {
          const key = JSON.stringify([companyCode, event.id, event.subjectId || '', kind, row.id || index]);
          if (rowKeys.has(key)) return;
          rowKeys.add(key);
          const date = dateKey(row.submittedAt);
          if (!date) { model.undatedFiles += 1; return; }
          if (!inPeriod(date)) return;
          const known = row.amount != null && String(row.amount).trim() !== ''
            && Number.isFinite(Number(row.amount)) && Number(row.amount) >= 0;
          const cents = known ? Math.round(Number(row.amount) * 100) : 0;
          const state = status(row);
          summary[state].count += 1;
          summary[state].cents += cents;
          if (!known) model.unknownAmounts += 1;
          const bucket = bucketFor(date);
          bucket.files += 1;
          const accepted = ['approved', 'paid', 'received'].includes(state);
          model.rows.push({
            kind, state, cents, known, date,
            companyName, eventName: event.name || `Event ${event.id}`,
            filename: row.originalName || (kind === 'invoice' ? 'Invoice' : 'Claim'),
            fileUrl: /^\/api\/worker\/submissions\/[^/?#]+\/file\?/.test(String(row.fileUrl || '')) ? row.fileUrl : '',
            denialReason: state === 'denied' ? String(row.denialReason || '') : ''
          });
          if (!accepted) return;
          model[kind] += cents;
          model[`${kind}Count`] += 1;
          bucket[kind] += cents;
          if (kind === 'claim') {
            const rawCategory = String(row.category || '').trim();
            const category = ['transport', 'crew transport', 'staff transport', 'cab', 'taxi', 'grab'].includes(rawCategory.toLowerCase())
              ? 'Crew Transport'
              : (rawCategory || 'Uncategorised');
            const item = categories.get(category) || { label: category, cents: 0, count: 0 };
            item.cents += cents;
            item.count += 1;
            categories.set(category, item);
          }
        });
      }
    });
    model.categories = [...categories.values()].sort((a, b) => b.cents - a.cents || a.label.localeCompare(b.label));
    return model;
  }

  function legend() {
    return '<div class="stats-legend"><span><i class="stats-invoice-colour"></i>Invoice earnings</span><span><i class="stats-claim-colour"></i>Claim reimbursements</span></div>';
  }

  function bars(model, activity = false) {
    const max = Math.max(1, ...model.buckets.flatMap(bucket => activity ? [bucket.events] : [bucket.invoice, bucket.claim]));
    const ceiling = activity ? max : Math.ceil(max / (max > 100000 ? 100000 : max > 10000 ? 10000 : 1000)) * (max > 100000 ? 100000 : max > 10000 ? 10000 : 1000);
    const tick = value => activity ? String(Math.round(value)) : compact(value);
    return `<div class="stats-chart-scroll" tabindex="0" role="region" aria-label="${activity ? 'Event activity' : 'Earnings and reimbursements'} chart. Scroll horizontally on small screens.">
      <div class="stats-bar-chart ${model.monthly ? 'stats-daily' : ''}" style="--stats-bucket-count:${model.buckets.length}">
        <div class="stats-chart-axis" aria-hidden="true"><span>${tick(ceiling)}</span><span>${ceiling > 1 ? tick(ceiling / 2) : ''}</span><span>0</span></div>
        <div class="stats-chart-plot">
          ${model.buckets.map(bucket => {
            const description = activity
              ? `${bucket.fullLabel}: ${bucket.events} event${bucket.events === 1 ? '' : 's'}`
              : `${bucket.fullLabel}: invoice earnings ${currency(bucket.invoice)}, claim reimbursements ${currency(bucket.claim)}`;
            return `<button type="button" class="stats-bar-column" data-statistics-bar aria-label="${esc(description)}">
              <span class="stats-bar-pair" aria-hidden="true">${activity
                ? `<i class="stats-activity-bar" style="height:${percent(bucket.events, ceiling)}%"></i>`
                : `<i class="stats-invoice-colour" style="height:${percent(bucket.invoice, ceiling)}%"></i><i class="stats-claim-colour" style="height:${percent(bucket.claim, ceiling)}%"></i>`}</span>
              <span class="stats-bar-label" aria-hidden="true">${bucket.label}</span>
              <span class="stats-bar-tooltip" aria-hidden="true">${esc(description)}</span>
            </button>`;
          }).join('')}
        </div>
      </div>
    </div><p class="stats-chart-readout" role="status" aria-live="polite">Tap or click a bar to see exact figures here.</p><p class="stats-chart-caption">${activity ? 'Number of events' : 'Amounts in SGD'} · ${model.monthly ? 'Day' : 'Month'} of ${activity ? 'event start' : 'submission'} · Swipe or scroll horizontally to see the full chart.</p>`;
  }

  function paymentChart(model) {
    const total = model.rows.length;
    let offset = 0;
    const segments = states.map(state => {
      const start = offset;
      const count = model.summary[state.key].count;
      const size = percent(count, total);
      offset += size;
      if (!count) return '';
      return `<circle cx="50" cy="50" r="43" fill="none" stroke="${state.colour}" stroke-width="14" pathLength="100"
        stroke-dasharray="${size} ${100 - size}" stroke-dashoffset="${-start}" transform="rotate(-90 50 50)"
        tabindex="0" role="button" data-statistics-status="${state.key}" aria-controls="statsPaymentDetails" aria-expanded="false"
        aria-label="${state.label}: ${files(count)}. View files."><title>${state.label}: ${files(count)}</title></circle>`;
    });
    return `<div class="stats-payment-body">
      <div class="stats-donut stats-donut-interactive">
        <svg viewBox="0 0 100 100" role="group" aria-label="Payment status chart. Select a segment to view files.">
          <circle cx="50" cy="50" r="43" fill="none" stroke="#e8eef3" stroke-width="14" />${segments.join('')}
        </svg>
        <div><strong>${total}</strong><span>submissions</span></div>
      </div>
      <ul class="stats-status-list">${states.map(state => {
        const item = model.summary[state.key];
        return `<li><button type="button" class="stats-status-button" data-statistics-status="${state.key}" aria-controls="statsPaymentDetails" aria-expanded="false"><span><i style="background:${state.colour}"></i>${state.label}<small>${files(item.count)} · View files</small></span><strong>${currency(item.cents)}</strong></button></li>`;
      }).join('')}</ul>
    </div><p class="stats-chart-caption">Tap a status or chart segment to view its invoices and claims. Files are limited to the selected period.</p>
    <section id="statsPaymentDetails" class="stats-payment-details" aria-labelledby="statsPaymentDetailsTitle" hidden></section>`;
  }

  function selectStatus(root, key, focus = true) {
    const view = views.get(root);
    const panel = root.querySelector('#statsPaymentDetails');
    if (!view || !panel) return;
    const selected = states.find(state => state.key === key);
    const previous = view.selected;
    view.selected = selected?.key || null;
    root.querySelectorAll('[data-statistics-status]').forEach(button => {
      const active = button.dataset.statisticsStatus === view.selected;
      button.setAttribute('aria-expanded', String(active));
      button.classList.toggle('is-selected', active);
    });
    panel.hidden = !selected;
    if (!selected) {
      panel.innerHTML = '';
      if (focus && previous) root.querySelector(`.stats-status-button[data-statistics-status="${previous}"]`)?.focus({ preventScroll: true });
      return;
    }
    const rows = view.model.rows.filter(row => row.state === key).sort((a, b) => b.date.localeCompare(a.date));
    panel.innerHTML = `<header><div><h3 id="statsPaymentDetailsTitle" tabindex="-1">${selected.label}</h3><p>${files(rows.length)} · ${esc(view.model.label)} · Invoices and claims</p></div><button type="button" class="stats-details-close" data-statistics-close aria-label="Close status files">Close</button></header>
      ${rows.length ? `<ul class="stats-file-list">${rows.map(row => `<li><div class="stats-file-top"><span class="stats-file-kind">${row.kind === 'invoice' ? 'Invoice' : 'Claim'}</span><strong>${row.known ? currency(row.cents) : 'Amount pending'}</strong></div>
        ${row.fileUrl ? `<a href="${esc(row.fileUrl)}" target="_blank" rel="noopener noreferrer">${esc(row.filename)}<span class="sr-only"> (opens in a new tab)</span></a>` : `<strong class="stats-file-name">${esc(row.filename)}</strong>`}
        <p>${esc(row.eventName)} · ${esc(row.companyName)}</p><small>Submitted ${Number(row.date.slice(8, 10))} ${months[Number(row.date.slice(5, 7)) - 1]} ${row.date.slice(0, 4)}</small>
        ${row.denialReason ? `<p class="stats-file-reason">Reason: ${esc(row.denialReason)}</p>` : ''}</li>`).join('')}</ul>` : '<p class="stats-details-empty">No invoices or claims with this status in the selected period.</p>'}`;
    if (focus) {
      panel.querySelector('h3').focus({ preventScroll: true });
      panel.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }

  function render(root, companies, selection) {
    if (!root) return;
    const model = build(companies, selection);
    if (!model) {
      views.delete(root);
      root.innerHTML = '<div class="stats-empty" role="status">Choose a valid period to see your statistics.</div>';
      return;
    }
    const tableOpen = root.querySelector('[data-statistics-table]')?.open;
    const selectedStatus = views.get(root)?.selected;
    views.set(root, { model, selected: null });
    const accepted = model.invoice + model.claim;
    const received = model.summary.received;
    const approved = model.summary.approved;
    const paid = model.summary.paid;
    const notes = [
      ...(model.vendorExcluded ? ['Vendor submissions are excluded from your personal statistics.'] : []),
      ...(model.undatedFiles ? [`${files(model.undatedFiles)} without a valid submission date cannot be placed in a period.`] : []),
      ...(model.undatedEvents ? [`${model.undatedEvents} event(s) without a valid start date are excluded from activity.`] : []),
      ...(model.unknownAmounts ? [`${files(model.unknownAmounts)} in this period have no confirmed amount; they are counted but add nothing to the totals.`] : [])
    ];
    const cards = [
      ['Invoice earnings', model.invoice, `${files(model.invoiceCount)} approved or paid`, 'invoice'],
      ['Claim reimbursements', model.claim, `${files(model.claimCount)} approved or paid`, 'claim'],
      ['Awaiting payment', approved.cents, `${files(approved.count)} approved · invoices + claims`, 'waiting'],
      ['Receipt confirmed', received.cents, `${files(received.count)} confirmed by you · invoices + claims`, 'received']
    ];
    root.innerHTML = `<div class="stats-scope"><div><span class="stats-scope-dot"></span><strong>All companies combined</strong><span>Your personal overview</span></div><span class="stats-period-label">${esc(model.label)}</span></div>
      <p class="stats-basis">Financial figures use the date each file was submitted, with its latest status. They do not show when money reached your account.</p>
      ${!model.rows.length && !model.eventCount ? '<div class="stats-empty"><strong>A fresh page for this period</strong><p>No personal submissions or events to show yet. Try a different month or year.</p></div>' : ''}
      <div class="stats-metrics">${cards.map(([label, cents, detail, style]) => `<article class="stats-metric stats-metric-${style}"><span>${label}</span><strong>${currency(cents)}</strong><small>${detail}</small></article>`).join('')}</div>
      <div class="stats-layout">
        <article class="stats-panel stats-trend"><header><div><p class="stats-eyebrow">YOUR EARNINGS OVER TIME</p><h2>Invoices &amp; reimbursements</h2><p>Approved and paid files, grouped by submission date.</p></div></header>
          ${legend()}${bars(model)}
          <details class="stats-data-table" data-statistics-table ${tableOpen ? 'open' : ''}><summary>View exact figures</summary><div class="stats-table-scroll" tabindex="0" role="region" aria-label="Exact statistics figures"><table><caption>${esc(model.label)} · all companies combined</caption><thead><tr><th scope="col">${model.monthly ? 'Day' : 'Month'}</th><th scope="col">Invoice earnings</th><th scope="col">Reimbursements</th><th scope="col">Files submitted</th><th scope="col">Events starting</th></tr></thead><tbody>${model.buckets.map(bucket => `<tr><th scope="row">${esc(bucket.fullLabel)}</th><td>${currency(bucket.invoice)}</td><td>${currency(bucket.claim)}</td><td>${bucket.files}</td><td>${bucket.events}</td></tr>`).join('')}</tbody><tfoot><tr><th scope="row">Total</th><td>${currency(model.invoice)}</td><td>${currency(model.claim)}</td><td>${model.rows.length}</td><td>${model.eventCount}</td></tr></tfoot></table></div></details>
        </article>
        <article class="stats-panel stats-payments"><header><div><p class="stats-eyebrow">FOLLOW YOUR SUBMISSIONS</p><h2>Payment progress</h2><p>See what is paid and what is still moving.</p></div></header>${paymentChart(model)}</article>
        <article class="stats-panel"><header><div><p class="stats-eyebrow">YOUR WORK ACTIVITY</p><h2>Events across the period</h2><p>Personal events grouped by their start date.</p></div><div class="stats-panel-number"><strong>${model.eventCount}</strong><span>events</span></div></header>${bars(model, true)}</article>
        <article class="stats-panel"><header><div><p class="stats-eyebrow">EXPENSES AT A GLANCE</p><h2>Claim categories</h2><p>Approved and paid reimbursements, by expense type.</p></div></header>
          ${model.categories.length ? `<ul class="stats-category-list">${model.categories.map(item => `<li><div><span>${esc(item.label)}<small>${files(item.count)}</small></span><strong>${currency(item.cents)}</strong></div><div class="stats-category-track" role="img" aria-label="${esc(item.label)}: ${Math.round(percent(item.cents, model.claim))}% of reimbursements"><i style="width:${percent(item.cents, model.claim)}%"></i></div></li>`).join('')}</ul>` : '<div class="stats-panel-empty">Your claim categories will appear here once a claim submitted in this period is approved.</div>'}
        </article>
      </div>
      <section class="stats-next"><div><p class="stats-eyebrow">KEEP THINGS MOVING</p><h2>Your next steps</h2><p>For submissions in ${esc(model.label)}.</p></div><div class="stats-next-items">
        <div><strong>${paid.count}</strong><span>payment receipt${paid.count === 1 ? '' : 's'} to confirm<small>${currency(paid.cents)} marked paid</small></span></div>
        <div><strong>${model.summary.details.count + model.summary.denied.count}</strong><span>file${model.summary.details.count + model.summary.denied.count === 1 ? '' : 's'} to check<small>Needs attention or denied</small></span></div>
        <div><strong>${accepted ? Math.round(percent(received.cents, accepted)) : 0}%</strong><span>receipt confirmed<small>Of approved / paid value</small></span></div>
      </div><button type="button" class="secondary-button" data-statistics-events>Go to My Events</button></section>
      ${notes.length ? `<aside class="stats-notes" aria-label="About these statistics">${notes.map(note => `<p>${esc(note)}</p>`).join('')}</aside>` : ''}`;
    if (selectedStatus) selectStatus(root, selectedStatus, false);
  }
  return { dateKey, years, build, render, selectStatus };
})();
