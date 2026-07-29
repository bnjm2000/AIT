const vehiclePageState = {
  data: null,
  date: '',
  search: '',
  editingVehicleId: null,
  editingBookingId: null,
  bookingAvailabilityTimer: null,
  bookingAvailabilityRequest: 0,
  drag: null,
  suppressClickUntil: 0,
  loading: false
};

function vehicleToday() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
}

function vehicleEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function vehicleAttr(value) {
  return vehicleEscape(value);
}

function vehicleFormatTime(value) {
  const match = String(value || '').match(/T(\d{2}:\d{2})/);
  return match ? match[1] : String(value || '').slice(0, 5);
}

function vehicleFormatDateLabel(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-SG', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

function vehicleEventStateSlug(value) {
  return String(value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

async function loadVehiclesPage(options = {}) {
  const root = document.getElementById('vehicles-page-root');
  if (!root || vehiclePageState.loading) return;
  vehiclePageState.date ||= vehicleToday();
  vehiclePageState.loading = true;
  if (!options.quiet && !vehiclePageState.data) {
    root.innerHTML = '<div class="vehicles-loading">Loading fleet...</div>';
  }
  try {
    const response = await apiCall(
      `/api/vehicles?date=${encodeURIComponent(vehiclePageState.date)}`
    );
    vehiclePageState.data = response.data;
    vehiclePageState.date = response.data.date || vehiclePageState.date;
    renderVehiclesPage();
  } catch (error) {
    root.innerHTML = `<div class="vehicles-empty"><strong>Fleet could not be loaded</strong><span>${vehicleEscape(error.message)}</span></div>`;
  } finally {
    vehiclePageState.loading = false;
  }
}

function renderVehiclesPage() {
  const root = document.getElementById('vehicles-page-root');
  const data = vehiclePageState.data || { vehicles: [], bookings: [] };
  const vehicles = data.vehicles || [];
  const active = vehicles.filter(row => row.active !== false);
  const bookedIds = new Set((data.bookings || []).map(row => String(row.vehicleId)));
  const query = vehiclePageState.search.trim().toLowerCase();
  const filtered = vehicles.filter(row => !query || [
    row.registrationNumber,
    row.name,
    row.vehicleType,
    row.notes
  ].some(value => String(value || '').toLowerCase().includes(query)));

  root.innerHTML = `
    <header class="vehicles-header">
      <div>
        <p class="vehicles-eyebrow">Inventory</p>
        <h2>Vehicles</h2>
        <p>Manage company vehicles and schedule their use.</p>
      </div>
      <div class="vehicles-header-actions">
        <button class="vehicle-button secondary" type="button" onclick="openVehicleBookingModal()">Book vehicle</button>
        <button class="vehicle-button primary" type="button" onclick="openVehicleModal()">Add vehicle</button>
      </div>
    </header>

    <section class="vehicle-metrics" aria-label="Fleet summary">
      ${vehicleMetric(vehicles.length, 'Total fleet', 'Registered vehicles')}
      ${vehicleMetric(active.length, 'Active', 'Available for booking')}
      ${vehicleMetric(bookedIds.size, 'Booked today', vehicleFormatDateLabel(vehiclePageState.date))}
      ${vehicleMetric(Math.max(0, active.length - bookedIds.size), 'Available today', 'No booking on timeline')}
    </section>

    <section class="vehicle-timeline-section">
      <div class="vehicle-section-heading">
        <div><h3>Daily vehicle timeline</h3><p>Drag a booking to move it. Use either edge to adjust its duration.</p></div>
        <div class="vehicle-date-control">
          <label for="vehicleTimelineDate">Date</label>
          <div class="vehicle-date-navigation">
            <button class="vehicle-date-step vehicle-date-today ${vehiclePageState.date === vehicleToday() ? 'is-current' : ''}"
                    type="button" title="Go to today" onclick="showVehicleTimelineToday()">Today</button>
            <button class="vehicle-date-step" type="button" title="Previous day"
                    aria-label="Previous day" onclick="shiftVehicleTimelineDate(-1)">&#8249;</button>
            <input id="vehicleTimelineDate" type="date" value="${vehicleAttr(vehiclePageState.date)}"
                   onchange="changeVehicleTimelineDate(this.value)">
            <button class="vehicle-date-step" type="button" title="Next day"
                    aria-label="Next day" onclick="shiftVehicleTimelineDate(1)">&#8250;</button>
          </div>
        </div>
      </div>
      ${vehicleTimelineHtml(active, data.bookings || [])}
    </section>

    <section class="vehicle-directory-section">
      <div class="vehicle-section-heading">
        <div><h3>Fleet directory</h3><p>${filtered.length} of ${vehicles.length} vehicles</p></div>
        <label class="vehicle-search"><span class="sr-only">Search vehicles</span>
          <input type="search" value="${vehicleAttr(vehiclePageState.search)}" placeholder="Search registration, type or notes" oninput="searchVehicles(this.value)">
        </label>
      </div>
      ${vehicleDirectoryHtml(filtered, data.bookings || [])}
    </section>`;
}

function vehicleMetric(value, label, note) {
  return `<div class="vehicle-metric"><strong>${Number(value || 0).toLocaleString()}</strong>
    <span>${vehicleEscape(label)}</span><small>${vehicleEscape(note)}</small></div>`;
}

function vehicleTimelineHtml(vehicles, bookings) {
  if (!vehicles.length) {
    return '<div class="vehicles-empty"><strong>No active vehicles</strong><span>Add a vehicle to start using the fleet timeline.</span></div>';
  }
  const hours = Array.from({ length: 9 }, (_, index) => index * 3);
  return `<div class="vehicle-timeline-scroll"><div class="vehicle-timeline">
    <div class="vehicle-time-header">
      <div class="vehicle-time-corner">Vehicle</div>
      <div class="vehicle-hours">${hours.map(hour =>
        `<span style="left:${(hour / 24) * 100}%">${String(hour).padStart(2, '0')}:00</span>`
      ).join('')}</div>
    </div>
    ${vehicles.map(vehicle => {
      const rows = bookings.filter(row => String(row.vehicleId) === String(vehicle.id));
      return `<div class="vehicle-timeline-row">
        <button class="vehicle-row-label" type="button" onclick="openVehicleModal('${vehicleAttr(vehicle.id)}')">
          <strong>${vehicleEscape(vehicle.registrationNumber)}</strong>
          <span>${vehicleEscape(vehicle.name || vehicle.vehicleType)}</span>
        </button>
        <div class="vehicle-track" data-vehicle-track="${vehicleAttr(vehicle.id)}">
          ${rows.map(vehicleBookingBar).join('')}
        </div>
      </div>`;
    }).join('')}
  </div></div>`;
}

function vehicleBookingBar(booking) {
  const dayStart = new Date(`${vehiclePageState.date}T00:00:00`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const start = new Date(booking.start);
  const end = new Date(booking.end);
  const visibleStart = Math.max(start.getTime(), dayStart.getTime());
  const visibleEnd = Math.min(end.getTime(), dayEnd.getTime());
  const left = ((visibleStart - dayStart.getTime()) / 86400000) * 100;
  const width = Math.max(0.8, ((visibleEnd - visibleStart) / 86400000) * 100);
  const label = booking.eventId
    ? `#${booking.eventId} ${booking.eventName || booking.purpose}`
    : booking.purpose;
  const statusClass = booking.kind === 'event'
    ? `event-booking event-status-${vehicleEventStateSlug(booking.eventState)}`
    : 'standalone-booking';
  const statusLabel = booking.kind === 'event' && booking.eventState
    ? ` | ${booking.eventState}`
    : '';
  return `<div class="vehicle-booking ${statusClass}"
      data-vehicle-booking="${vehicleAttr(booking.id)}"
      style="left:${left}%;width:${width}%"
      title="${vehicleAttr(`${label} | ${vehicleFormatTime(booking.start)}-${vehicleFormatTime(booking.end)}${statusLabel}`)}"
      onpointerdown="vehicleTimelinePointerDown(event,'${vehicleAttr(booking.id)}','move')"
      onclick="openVehicleTimelineBooking('${vehicleAttr(booking.id)}')">
    <button class="vehicle-resize-handle start" type="button" aria-label="Adjust start time"
      onpointerdown="vehicleTimelinePointerDown(event,'${vehicleAttr(booking.id)}','start')"></button>
    <span><strong>${vehicleEscape(label)}</strong><small>${vehicleFormatTime(booking.start)}-${vehicleFormatTime(booking.end)}</small></span>
    <button class="vehicle-resize-handle end" type="button" aria-label="Adjust end time"
      onpointerdown="vehicleTimelinePointerDown(event,'${vehicleAttr(booking.id)}','end')"></button>
  </div>`;
}

function vehicleDirectoryHtml(vehicles, bookings) {
  if (!vehicles.length) {
    return '<div class="vehicles-empty"><strong>No matching vehicles</strong><span>Try a different search.</span></div>';
  }
  return `<div class="vehicle-list">
    <div class="vehicle-list-head"><span>Vehicle</span><span>Type</span><span>Status</span><span>Bookings</span><span>Actions</span></div>
    ${vehicles.map(vehicle => {
      const bookingCount = bookings.filter(row => String(row.vehicleId) === String(vehicle.id)).length;
      return `<div class="vehicle-list-row">
        <div><strong>${vehicleEscape(vehicle.registrationNumber)}</strong><small>${vehicleEscape(vehicle.name || '-')}</small></div>
        <span>${vehicleEscape(vehicle.vehicleType || '-')}</span>
        <span><i class="vehicle-status ${vehicle.active === false ? 'inactive' : 'active'}">${vehicle.active === false ? 'Inactive' : 'Active'}</i></span>
        <span>${bookingCount ? `${bookingCount} on selected day` : '-'}</span>
        <div class="vehicle-row-actions">
          <button class="vehicle-icon-button" type="button" aria-label="Edit vehicle" title="Edit vehicle" onclick="openVehicleModal('${vehicleAttr(vehicle.id)}')">Edit</button>
          <button class="vehicle-icon-button danger" type="button" aria-label="Delete vehicle" title="Delete vehicle"
            onclick="deleteVehicleFromList(event,'${vehicleAttr(vehicle.id)}','${vehicleAttr(vehicle.registrationNumber)}')">Delete</button>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function changeVehicleTimelineDate(value) {
  if (!value) return;
  vehiclePageState.date = value;
  loadVehiclesPage();
}

function showVehicleTimelineToday() {
  const today = vehicleToday();
  if (vehiclePageState.date === today) return;
  changeVehicleTimelineDate(today);
}

function shiftVehicleTimelineDate(days) {
  const parts = String(vehiclePageState.date || vehicleToday())
    .split('-')
    .map(Number);
  if (parts.length !== 3 || parts.some(value => !Number.isFinite(value))) return;
  const date = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
  date.setDate(date.getDate() + Number(days || 0));
  changeVehicleTimelineDate([
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-'));
}

function searchVehicles(value) {
  vehiclePageState.search = value;
  renderVehiclesPage();
  const input = document.querySelector('#vehicles-page-root .vehicle-search input');
  if (input) {
    input.focus();
    input.setSelectionRange(value.length, value.length);
  }
}

function ensureVehicleModals() {
  if (document.getElementById('vehicleEditorModal')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="vehicle-modal" id="vehicleEditorModal" aria-hidden="true">
      <div class="vehicle-modal-panel" role="dialog" aria-modal="true" aria-labelledby="vehicleEditorTitle">
        <header><div><p>Fleet details</p><h3 id="vehicleEditorTitle">Add vehicle</h3></div>
          <button type="button" class="vehicle-close" aria-label="Close" onclick="closeVehicleModal('vehicleEditorModal')">&times;</button></header>
        <form id="vehicleEditorForm" onsubmit="saveVehicle(event)">
          <div class="vehicle-form-grid">
            <label><span>Registration number *</span><input id="vehicleRegistration" required maxlength="30"></label>
            <label><span>Vehicle type *</span><input id="vehicleType" required maxlength="80" placeholder="14 ft lorry"></label>
            <label><span>Display name</span><input id="vehicleName" maxlength="80" placeholder="Truck 1"></label>
            <label class="full"><span>Notes</span><textarea id="vehicleNotes" maxlength="500"></textarea></label>
            <label class="vehicle-checkbox full"><input id="vehicleActive" type="checkbox" checked><span>Active and available for bookings</span></label>
          </div>
          <p class="vehicle-form-error" id="vehicleEditorError"></p>
          <footer><button class="vehicle-button danger" id="vehicleDeleteButton" type="button" onclick="deleteVehicle()" hidden>Delete</button>
            <span></span><button class="vehicle-button" type="button" onclick="closeVehicleModal('vehicleEditorModal')">Cancel</button>
            <button class="vehicle-button primary" type="submit">Save vehicle</button></footer>
        </form>
      </div>
    </div>
    <div class="vehicle-modal" id="vehicleBookingModal" aria-hidden="true">
      <div class="vehicle-modal-panel vehicle-booking-modal-panel" role="dialog" aria-modal="true" aria-labelledby="vehicleBookingTitle">
        <header><div><p>Standalone fleet use</p><h3 id="vehicleBookingTitle">Book vehicle</h3></div>
          <button type="button" class="vehicle-close" aria-label="Close" onclick="closeVehicleModal('vehicleBookingModal')">&times;</button></header>
        <form id="vehicleBookingForm" onsubmit="saveVehicleBooking(event)">
          <div class="vehicle-form-grid">
            <label class="full"><span>Purpose *</span><input id="vehicleBookingPurpose" required maxlength="120" placeholder="Warehouse collection"></label>
            <label><span>Start date *</span><input id="vehicleBookingDate" type="date" required onchange="syncVehicleBookingEndDate()"></label>
            <label><span>Start time *</span><input id="vehicleBookingStart" type="time" required onchange="scheduleVehicleBookingAvailability()"></label>
            <label><span>Return date *</span><input id="vehicleBookingEndDate" type="date" required onchange="scheduleVehicleBookingAvailability()"></label>
            <label><span>Return time *</span><input id="vehicleBookingEnd" type="time" required onchange="scheduleVehicleBookingAvailability()"></label>
            <label class="full"><span>Notes</span><textarea id="vehicleBookingNotes" maxlength="500"></textarea></label>
          </div>
          <section class="vehicle-booking-choice-section">
            <div class="vehicle-booking-choice-heading">
              <div><h4>Choose vehicle</h4><p>Availability is based on the complete usage period above.</p></div>
              <button class="vehicle-button" type="button" onclick="openVehicleModal()">Add vehicle</button>
            </div>
            <input id="vehicleBookingVehicle" type="hidden">
            <div class="vehicle-booking-choice-grid" id="vehicleBookingChoices"></div>
          </section>
          <p class="vehicle-form-error" id="vehicleBookingError"></p>
          <footer><button class="vehicle-button danger" id="vehicleBookingDeleteButton" type="button" onclick="deleteVehicleBooking()" hidden>Delete booking</button>
            <span></span><button class="vehicle-button" type="button" onclick="closeVehicleModal('vehicleBookingModal')">Cancel</button>
            <button class="vehicle-button primary" id="vehicleBookingSubmit" type="submit">Book vehicle</button></footer>
        </form>
      </div>
    </div>`);
}

function openVehicleModal(id = '') {
  ensureVehicleModals();
  const vehicle = (vehiclePageState.data?.vehicles || [])
    .find(row => String(row.id) === String(id));
  vehiclePageState.editingVehicleId = vehicle?.id || null;
  document.getElementById('vehicleEditorForm').reset();
  document.getElementById('vehicleEditorTitle').textContent =
    vehicle ? 'Edit vehicle' : 'Add vehicle';
  document.getElementById('vehicleRegistration').value = vehicle?.registrationNumber || '';
  document.getElementById('vehicleType').value = vehicle?.vehicleType || '';
  document.getElementById('vehicleName').value = vehicle?.name || '';
  document.getElementById('vehicleNotes').value = vehicle?.notes || '';
  document.getElementById('vehicleActive').checked = vehicle?.active !== false;
  document.getElementById('vehicleDeleteButton').hidden = !vehicle;
  document.getElementById('vehicleEditorError').textContent = '';
  openVehicleModalElement('vehicleEditorModal');
}

async function saveVehicle(event) {
  event.preventDefault();
  const id = vehiclePageState.editingVehicleId;
  try {
    await apiCall(id ? `/api/vehicles/${encodeURIComponent(id)}` : '/api/vehicles',
      id ? 'PUT' : 'POST', {
        registrationNumber: document.getElementById('vehicleRegistration').value,
        vehicleType: document.getElementById('vehicleType').value,
        name: document.getElementById('vehicleName').value,
        notes: document.getElementById('vehicleNotes').value,
        active: document.getElementById('vehicleActive').checked
      });
    closeVehicleModal('vehicleEditorModal');
    await loadVehiclesPage({ quiet: true });
    if (document.getElementById('vehicleBookingModal')?.classList.contains('open')) {
      scheduleVehicleBookingAvailability(true);
    }
    showNotification('success', id ? 'Vehicle updated' : 'Vehicle added');
  } catch (error) {
    document.getElementById('vehicleEditorError').textContent = error.message;
  }
}

async function deleteVehicle() {
  const id = vehiclePageState.editingVehicleId;
  if (!id || !window.confirm('Delete this vehicle from the fleet?')) return;
  await performVehicleDelete(id, 'vehicleEditorError');
}

async function deleteVehicleFromList(event, id, registration) {
  event.stopPropagation();
  if (!id || !window.confirm(`Delete ${registration || 'this vehicle'} from the fleet?`)) return;
  await performVehicleDelete(id);
}

async function performVehicleDelete(id, errorElementId = '') {
  try {
    await apiCall(`/api/vehicles/${encodeURIComponent(id)}`, 'DELETE');
    closeVehicleModal('vehicleEditorModal');
    await loadVehiclesPage({ quiet: true });
    showNotification('success', 'Vehicle deleted');
  } catch (error) {
    const errorElement = errorElementId
      ? document.getElementById(errorElementId)
      : null;
    if (errorElement) errorElement.textContent = error.message;
  }
}

function openVehicleBookingModal(id = '', preferredVehicleId = '') {
  ensureVehicleModals();
  const booking = (vehiclePageState.data?.bookings || [])
    .find(row => String(row.id) === String(id) && row.kind === 'standalone');
  const vehicles = (vehiclePageState.data?.vehicles || [])
    .filter(row => row.active !== false || String(row.id) === String(booking?.vehicleId));
  if (!vehicles.length) {
    showNotification('error', 'Add an active vehicle before making a booking.');
    return;
  }
  vehiclePageState.editingBookingId = booking?.id || null;
  document.getElementById('vehicleBookingForm').reset();
  document.getElementById('vehicleBookingTitle').textContent =
    booking ? 'Edit booking' : 'Book vehicle';
  document.getElementById('vehicleBookingVehicle').value =
    booking?.vehicleId || preferredVehicleId || '';
  document.getElementById('vehicleBookingPurpose').value = booking?.purpose || '';
  const startDate = booking?.start?.slice(0, 10) || vehiclePageState.date;
  document.getElementById('vehicleBookingDate').value = startDate;
  document.getElementById('vehicleBookingDate').dataset.previousValue = startDate;
  document.getElementById('vehicleBookingStart').value =
    booking ? vehicleFormatTime(booking.start) : '';
  document.getElementById('vehicleBookingEndDate').value =
    booking?.end?.slice(0, 10) || vehiclePageState.date;
  document.getElementById('vehicleBookingEnd').value =
    booking ? vehicleFormatTime(booking.end) : '';
  document.getElementById('vehicleBookingNotes').value = booking?.notes || '';
  document.getElementById('vehicleBookingDeleteButton').hidden = !booking;
  document.getElementById('vehicleBookingSubmit').textContent =
    booking ? 'Save changes' : 'Book vehicle';
  document.getElementById('vehicleBookingError').textContent = '';
  renderVehicleBookingChoices(vehicles, false, booking?.vehicleId || preferredVehicleId || '');
  openVehicleModalElement('vehicleBookingModal');
  scheduleVehicleBookingAvailability(true);
}

function vehicleBookingWindowValues() {
  const date = document.getElementById('vehicleBookingDate')?.value || '';
  const startTime = document.getElementById('vehicleBookingStart')?.value || '';
  const endDate = document.getElementById('vehicleBookingEndDate')?.value || date;
  const endTime = document.getElementById('vehicleBookingEnd')?.value || '';
  const start = Date.parse(`${date}T${startTime || '00:00'}:00`);
  const end = Date.parse(`${endDate}T${endTime || '00:00'}:00`);
  return {
    date,
    startTime,
    endDate,
    endTime,
    complete: Boolean(
      date &&
      startTime &&
      endDate &&
      endTime &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end > start
    )
  };
}

function renderVehicleBookingChoices(vehicles, complete, selectedId = '') {
  const root = document.getElementById('vehicleBookingChoices');
  if (!root) return;
  const rows = (vehicles || []).filter(vehicle =>
    vehicle.active !== false || String(vehicle.id) === String(selectedId)
  );
  root.innerHTML = rows.length ? rows.map(vehicle => {
    const available = complete ? Boolean(vehicle.available) : null;
    const selected = String(vehicle.id) === String(selectedId);
    const stateLabel = available === null
      ? 'Enter full usage time'
      : (available ? 'Available' : 'Unavailable');
    return `<button class="vehicle-booking-choice ${selected ? 'selected' : ''} ${available === false ? 'unavailable' : ''}"
        type="button" data-vehicle-id="${vehicleAttr(vehicle.id)}"
        ${available === false || available === null ? 'disabled' : ''}
        title="${vehicleAttr(vehicle.conflict || stateLabel)}"
        onclick="selectVehicleBookingChoice('${vehicleAttr(vehicle.id)}')">
      <span><strong>${vehicleEscape(vehicle.registrationNumber || 'Vehicle')}</strong>
        <small>${vehicleEscape(vehicle.name || vehicle.vehicleType || 'Company vehicle')}</small></span>
      <em class="${available === false ? 'unavailable' : (available ? 'available' : 'pending')}">${vehicleEscape(stateLabel)}</em>
      ${vehicle.conflict ? `<small class="vehicle-booking-conflict">${vehicleEscape(vehicle.conflict)}</small>` : ''}
    </button>`;
  }).join('') : '<div class="vehicle-booking-choice-empty">No active fleet vehicles. Add a vehicle to continue.</div>';
  updateVehicleBookingSubmitState();
}

function selectVehicleBookingChoice(vehicleId) {
  const input = document.getElementById('vehicleBookingVehicle');
  if (!input || !vehicleId) return;
  input.value = vehicleId;
  document.querySelectorAll('#vehicleBookingChoices .vehicle-booking-choice')
    .forEach(option => option.classList.toggle(
      'selected',
      String(option.dataset.vehicleId) === String(vehicleId)
    ));
  updateVehicleBookingSubmitState();
}

function updateVehicleBookingSubmitState() {
  const submit = document.getElementById('vehicleBookingSubmit');
  if (!submit) return;
  submit.disabled = !document.getElementById('vehicleBookingVehicle')?.value;
}

function syncVehicleBookingEndDate() {
  const startDate = document.getElementById('vehicleBookingDate');
  const endDate = document.getElementById('vehicleBookingEndDate');
  if (!startDate || !endDate) return;
  const previousStart = startDate.dataset.previousValue || '';
  if (!endDate.value || endDate.value === previousStart) {
    endDate.value = startDate.value;
  }
  startDate.dataset.previousValue = startDate.value;
  scheduleVehicleBookingAvailability();
}

function scheduleVehicleBookingAvailability(immediate = false) {
  clearTimeout(vehiclePageState.bookingAvailabilityTimer);
  vehiclePageState.bookingAvailabilityTimer = setTimeout(
    loadVehicleBookingAvailability,
    immediate ? 0 : 180
  );
}

async function loadVehicleBookingAvailability() {
  const values = vehicleBookingWindowValues();
  const allVehicles = (vehiclePageState.data?.vehicles || [])
    .filter(row => row.active !== false);
  const selectedId = document.getElementById('vehicleBookingVehicle')?.value || '';
  if (!values.complete) {
    document.getElementById('vehicleBookingVehicle').value = '';
    renderVehicleBookingChoices(allVehicles, false);
    return;
  }

  const requestId = ++vehiclePageState.bookingAvailabilityRequest;
  const params = new URLSearchParams({
    date: values.date,
    startTime: values.startTime,
    endDate: values.endDate,
    endTime: values.endTime
  });
  if (vehiclePageState.editingBookingId) {
    params.set('excludeBookingId', vehiclePageState.editingBookingId);
  }

  try {
    const response = await apiCall(`/api/vehicles/availability?${params}`);
    if (requestId !== vehiclePageState.bookingAvailabilityRequest) return;
    const vehicles = response.data?.vehicles || [];
    const selected = vehicles.find(row => String(row.id) === String(selectedId));
    const nextSelectedId = selected?.available ? selectedId : '';
    document.getElementById('vehicleBookingVehicle').value = nextSelectedId;
    renderVehicleBookingChoices(vehicles, true, nextSelectedId);
  } catch (error) {
    if (requestId !== vehiclePageState.bookingAvailabilityRequest) return;
    document.getElementById('vehicleBookingVehicle').value = '';
    renderVehicleBookingChoices(allVehicles, false);
    document.getElementById('vehicleBookingError').textContent =
      'Vehicle availability could not be checked. Try again.';
  }
}

async function saveVehicleBooking(event) {
  event.preventDefault();
  const id = vehiclePageState.editingBookingId;
  const vehicleId = document.getElementById('vehicleBookingVehicle').value;
  if (!vehicleId) {
    document.getElementById('vehicleBookingError').textContent =
      'Choose an available fleet vehicle.';
    return;
  }
  try {
    await apiCall(id
      ? `/api/vehicles/bookings/${encodeURIComponent(id)}`
      : '/api/vehicles/bookings', id ? 'PUT' : 'POST', {
        vehicleId,
        purpose: document.getElementById('vehicleBookingPurpose').value,
        date: document.getElementById('vehicleBookingDate').value,
        startTime: document.getElementById('vehicleBookingStart').value,
        endDate: document.getElementById('vehicleBookingEndDate').value,
        endTime: document.getElementById('vehicleBookingEnd').value,
        notes: document.getElementById('vehicleBookingNotes').value,
        selectedDate: vehiclePageState.date
      });
    closeVehicleModal('vehicleBookingModal');
    await loadVehiclesPage({ quiet: true });
    showNotification('success', id ? 'Booking updated' : 'Vehicle booked');
  } catch (error) {
    document.getElementById('vehicleBookingError').textContent = error.message;
  }
}

async function deleteVehicleBooking() {
  const id = vehiclePageState.editingBookingId;
  if (!id || !window.confirm('Delete this vehicle booking?')) return;
  try {
    await apiCall(`/api/vehicles/bookings/${encodeURIComponent(id)}`, 'DELETE', {
      selectedDate: vehiclePageState.date
    });
    closeVehicleModal('vehicleBookingModal');
    await loadVehiclesPage({ quiet: true });
    showNotification('success', 'Booking deleted');
  } catch (error) {
    document.getElementById('vehicleBookingError').textContent = error.message;
  }
}

function openVehicleModalElement(id) {
  const modal = document.getElementById(id);
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeVehicleModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

function openVehicleTimelineBooking(id) {
  if (Date.now() < vehiclePageState.suppressClickUntil) return;
  const booking = (vehiclePageState.data?.bookings || [])
    .find(row => String(row.id) === String(id));
  if (!booking) return;
  if (booking.eventId) {
    viewEvent(Number(booking.eventId), { updateHistory: false });
    return;
  }
  openVehicleBookingModal(booking.id);
}

function vehicleTimelinePointerDown(event, bookingId, mode) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const booking = (vehiclePageState.data?.bookings || [])
    .find(row => String(row.id) === String(bookingId));
  const bar = document.querySelector(`[data-vehicle-booking="${CSS.escape(String(bookingId))}"]`);
  const track = bar?.closest('[data-vehicle-track]');
  if (!booking || !bar || !track) return;
  const dayStart = new Date(`${vehiclePageState.date}T00:00:00`).getTime();
  vehiclePageState.drag = {
    booking,
    mode,
    bar,
    startX: event.clientX,
    trackWidth: track.getBoundingClientRect().width,
    startMinute: Math.max(0, (new Date(booking.start).getTime() - dayStart) / 60000),
    endMinute: Math.min(1440, (new Date(booking.end).getTime() - dayStart) / 60000),
    nextStart: null,
    nextEnd: null,
    vehicleId: booking.vehicleId,
    moved: false
  };
  document.addEventListener('pointermove', vehicleTimelinePointerMove);
  document.addEventListener('pointerup', vehicleTimelinePointerUp, { once: true });
}

function vehicleTimelinePointerMove(event) {
  const drag = vehiclePageState.drag;
  if (!drag) return;
  const delta = Math.round(((event.clientX - drag.startX) / drag.trackWidth) * 1440 / 15) * 15;
  let start = drag.startMinute;
  let end = drag.endMinute;
  if (drag.mode === 'move') {
    const duration = end - start;
    start = Math.max(0, Math.min(1440 - duration, start + delta));
    end = start + duration;
  } else if (drag.mode === 'start') {
    start = Math.max(0, Math.min(end - 15, start + delta));
  } else {
    end = Math.min(1440, Math.max(start + 15, end + delta));
  }
  const targetTrack = document.elementFromPoint(event.clientX, event.clientY)
    ?.closest?.('[data-vehicle-track]');
  if (targetTrack && drag.mode === 'move') {
    drag.vehicleId = targetTrack.dataset.vehicleTrack;
    targetTrack.appendChild(drag.bar);
  }
  drag.nextStart = start;
  drag.nextEnd = end;
  drag.moved = drag.moved || Math.abs(delta) >= 15 || drag.vehicleId !== drag.booking.vehicleId;
  drag.bar.style.left = `${(start / 1440) * 100}%`;
  drag.bar.style.width = `${Math.max(0.8, ((end - start) / 1440) * 100)}%`;
  const label = drag.bar.querySelector('small');
  if (label) label.textContent = `${vehicleMinuteLabel(start)}-${vehicleMinuteLabel(end)}`;
}

async function vehicleTimelinePointerUp() {
  document.removeEventListener('pointermove', vehicleTimelinePointerMove);
  const drag = vehiclePageState.drag;
  vehiclePageState.drag = null;
  if (!drag?.moved) return;
  vehiclePageState.suppressClickUntil = Date.now() + 300;
  const start = vehicleDateAtMinute(vehiclePageState.date, drag.nextStart);
  const end = vehicleDateAtMinute(vehiclePageState.date, drag.nextEnd);
  try {
    await apiCall(`/api/vehicles/bookings/${encodeURIComponent(drag.booking.id)}`, 'PUT', {
      vehicleId: drag.vehicleId,
      date: start.date,
      startTime: start.time,
      endDate: end.date,
      endTime: end.time,
      selectedDate: vehiclePageState.date
    });
    await loadVehiclesPage({ quiet: true });
  } catch (error) {
    showNotification('error', error.message);
    await loadVehiclesPage({ quiet: true });
  }
}

function vehicleMinuteLabel(minute) {
  const safe = Math.max(0, Math.min(1440, Math.round(minute)));
  if (safe === 1440) return '24:00';
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function vehicleDateAtMinute(dateValue, minute) {
  const date = new Date(`${dateValue}T00:00:00`);
  date.setMinutes(Math.round(minute));
  return {
    date: [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-'),
    time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  };
}
