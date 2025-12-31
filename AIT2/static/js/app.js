// Global variables
let currentUser = null;
let events = [];
let assets = [];
let containers = [];
let logs = [];
let stats = {};

// ---------- containers cache ----------
let selectedContainerAssets = new Set();
let __containersCache = null;
let __containersCacheTs = 0;

// keep cache reasonably fresh
async function refreshContainersCache(force = false) {
  const now = Date.now();
  if (!force && __containersCache && (now - __containersCacheTs) < 15000) {
    return __containersCache;
  }

  const res = await apiCall('/api/containers');
  const list = (res && res.data) ? res.data : [];
  __containersCache = {};
  list.forEach(c => { __containersCache[c.id] = c; });
  __containersCacheTs = now;
  return __containersCache;
}

async function getContainerById(containerId, force = false) {
  if (!containerId) return null;
  const cache = await refreshContainersCache(force);
  return cache[containerId] || null;
}

// used to avoid container recursion
window.__processingContainerBatch = false;

// Global utility function for HTML escaping
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// PATCH: attribute-safe HTML escaper (handles quotes too)
function escapeHtmlAttr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// status badge renderer (used by selectors)
function getAssetStatusBadge(asset) {
  const status = (asset?.status || '').toString().toLowerCase();

  let statusClass = 'status-available';
  let statusText  = 'Available';

  if (status === 'missing') {
    statusClass = 'status-missing';
    statusText  = 'Missing';
  } else if (status === 'ooc') {
    statusClass = 'status-ooc';
    statusText  = 'OOC';
  } else if (status === 'deployed') {
    statusClass = 'status-deployed';
    statusText  = 'Deployed';
  }

  return `<span class="asset-badge ${statusClass}">${statusText}</span>`;
}

/* PATCH A — Delivery Order (DO) edit helpers */
function getDoEdits(eventId) {
  const blank = { 
    overrides: {}, 
    custom: { Audio: [], Lighting: [], Video: [], MISC: [] } 
  };
  try {
    const raw = localStorage.getItem(`doEdits/${eventId}`);
    if (!raw) return blank;
    const data = JSON.parse(raw);
    data.overrides ||= {};
    data.custom ||= {};
    ['Audio','Lighting','Video','MISC'].forEach(d => data.custom[d] ||= []);
    return data;
  } catch { return blank; }
}
function saveDoEdits(eventId, data) {
  localStorage.setItem(`doEdits/${eventId}`, JSON.stringify(data));
}
function clearDoEdits(eventId) {
  localStorage.removeItem(`doEdits/${eventId}`);
}
/* stable key for model-group rows */
function makeModelKey(mg) {
  return `MG|${mg.department||''}|${mg.brand||''}|${mg.model||''}|${mg.description||''}`;
}


let isClickHandlerSetup = false;
let processingAssets = new Set();

// Universal date formatting function to handle YYYY/MM/DD format from backend
function formatDate(dateStr) {
  if (!dateStr) return '';
  
  // Handle YYYY/MM/DD format from backend
  if (dateStr.includes('/')) {
    const dateParts = dateStr.split('/');
    if (dateParts.length === 3) {
      const [year, month, day] = dateParts;
      const isoDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      return new Date(isoDate).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
  }
  
  // Fallback for other date formats
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Function to convert YYYY/MM/DD to YYYY-MM-DD for HTML date inputs
function formatDateForInput(dateStr) {
  if (!dateStr) return '';
  
  // Handle YYYY/MM/DD format from backend
  if (dateStr.includes('/')) {
    const dateParts = dateStr.split('/');
    if (dateParts.length === 3) {
      const [year, month, day] = dateParts;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }
  
  // Fallback: try parsing as regular date
  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  return '';
}

function setupSingleAssetClickHandler() {
    // Prevent multiple setups
    if (isClickHandlerSetup) {
        console.log('Click handler already setup, skipping...');
        return;
    }
    
    console.log('Setting up SINGLE asset click handler...');
    
    // Remove ALL possible existing listeners
    const oldHandler1 = document._assetClickHandler;
    const oldHandler2 = document._customAssetHandler;
    const oldHandler3 = window.handleAssetActionClick;
    const oldHandler4 = window.handleCustomAssetClick;
    
    if (oldHandler1) document.removeEventListener('click', oldHandler1);
    if (oldHandler2) document.removeEventListener('click', oldHandler2);
    if (oldHandler3) document.removeEventListener('click', oldHandler3);
    if (oldHandler4) document.removeEventListener('click', oldHandler4);
    
    // Create the ONE and ONLY click handler for ALL button types
    const singleClickHandler = function(event) {
        // Handle prepare/unprepare buttons
        if (event.target.classList.contains('asset-action-btn') || 
            event.target.classList.contains('custom-asset-btn')) {
            
            event.preventDefault();
            event.stopPropagation();
            
            const eventId = event.target.dataset.eventId;
            const assetId = decodeURIComponent(event.target.dataset.assetId);
            const action = event.target.dataset.action;
            
            // Create unique key for this asset
            const assetKey = `${eventId}-${assetId}`;
            
            // Check if already processing
            if (processingAssets.has(assetKey)) {
                console.log(`BLOCKED: Asset ${assetId} already being processed`);
                return false;
            }
            
            processingAssets.add(assetKey);
            
            if (action === 'prepare') {
                prepareSpecificAsset(eventId, assetId).finally(() => {
                    processingAssets.delete(assetKey);
                });
            } else if (action === 'unprepare') {
                unprepareSpecificAsset(eventId, assetId).finally(() => {
                    processingAssets.delete(assetKey);
                });
            } else if (action === 'editCustom') {
                editCustomAsset(eventId, assetId);
                processingAssets.delete(assetKey);
            } else if (action === 'removeCustom') {
                removeCustomAsset(eventId, assetId).finally(() => {
                    processingAssets.delete(assetKey);
                });
            }
            
            return false;
        }
        
        // Handle removal buttons (remove from event)
        if (event.target.classList.contains('asset-remove-btn') || 
            event.target.classList.contains('custom-remove-btn')) {
            
            event.preventDefault();
            event.stopPropagation();
            
            const eventId = event.target.dataset.eventId;
            const assetId = decodeURIComponent(event.target.dataset.assetId);
            
            // Create unique key for this asset
            const assetKey = `${eventId}-${assetId}`;
            
            // Check if already processing
            if (processingAssets.has(assetKey)) {
                console.log(`BLOCKED: Asset ${assetId} removal already being processed`);
                return false;
            }
            
            if (confirm(`Remove ${assetId} from this event?`)) {
                // Mark as processing
                processingAssets.add(assetKey);
                
                // Disable the button
                event.target.disabled = true;
                event.target.style.opacity = '0.5';
                
                // Process removal
                const cleanup = () => {
                    processingAssets.delete(assetKey);
                    console.log(`COMPLETED: Asset ${assetId} removal finished`);
                };
                
                removeAssetFromEvent(eventId, assetId).finally(cleanup);
            }
            
            return false;
        }

    };
    
    // Store reference and add listener
    document._singleAssetHandler = singleClickHandler;
    document.addEventListener('click', singleClickHandler, true); // Use capture phase
    
    isClickHandlerSetup = true;
    console.log('Single click handler setup complete');
}

// Global variables for maintenance functionality
let selectedMaintenanceAssets = new Set();
let selectedOOCAssets = new Set();

function removeExistingListeners() {
    // Remove any existing click handlers
    const existingHandler = document._assetClickHandler;
    if (existingHandler) {
        document.removeEventListener('click', existingHandler);
    }
}

function setupAssetClickHandler() {
    removeExistingListeners();
    
    const clickHandler = function(event) {
        if (event.target.classList.contains('asset-action-btn')) {
            event.preventDefault();
            event.stopPropagation();
            
            const eventId = event.target.dataset.eventId;
            const assetId = decodeURIComponent(event.target.dataset.assetId);
            const action = event.target.dataset.action;
            
            const assetKey = `${eventId}-${assetId}`;
            
            if (processingAssets.has(assetKey)) {
                console.log(`Click ignored - asset ${assetId} already being processed`);
                return;
            }
            
            processingAssets.add(assetKey);

            const allButtonsForAsset = document.querySelectorAll(`[data-asset-id="${encodeURIComponent(assetId)}"]`);
            allButtonsForAsset.forEach(btn => {
                btn.disabled = true;
                btn.style.opacity = '0.6';
            });
            
            console.log('Asset action clicked:', { eventId, assetId, action });

            const cleanup = () => {
                processingAssets.delete(assetKey);
            };
            
            if (action === 'prepare') {
                prepareSpecificAsset(eventId, assetId)
                    .finally(cleanup);
            } else if (action === 'unprepare') {
                unprepareSpecificAsset(eventId, assetId)
                    .finally(cleanup);
            } else {
                cleanup();
            }
            
            return;
        }
    };
    
    document._assetClickHandler = clickHandler;
    
    document.addEventListener('click', clickHandler);
}

// Global utility function for JavaScript string escaping
function escapeJs(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function escapeHtmlAttribute(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Update the overdue events counter
function updateOverdueCounter(count) {
    const counter = document.getElementById('overdue-counter');
    if (counter) {
        if (count > 0) {
            counter.textContent = count;
            counter.style.display = 'inline-block';
            counter.style.background = '#dc3545'; // Red for overdue
            counter.style.animation = 'pulse 2s infinite'; // Add pulsing animation
        } else {
            counter.style.display = 'none';
        }
    }
}

// Count overdue events from events data
function countOverdueEvents(eventsData) {
    return eventsData.filter(event => event.state === 'Overdue').length;
}

// Helper functions for event tags
function getTagStyle(tag) {
    if (tag === 'dry hire') {
        return 'background: #17a2b8; color: white;';
    }
    return 'background: #28a745; color: white;';
}

function getTagDisplay(tag) {
    return tag === 'dry hire' ? 'DRY HIRE' : 'EVENT';
}

// Navigation functions
function showSection(sectionName) {
  // Hide all sections
  document.querySelectorAll(".content-section").forEach((section) => {
    section.classList.remove("active");
  });

  // Remove active class from all nav items
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.remove("active");
  });

  // Show selected section
  document.getElementById(sectionName + "-section").classList.add("active");

  // Add active class to clicked nav item
  if (event && event.target) {
    event.target.classList.add("active");
  } else {
    // Fallback: find the nav item by section name
    document
      .querySelector(`[onclick="showSection('${sectionName}')"]`)
      ?.classList.add("active");
  }

  // Load section data
  switch (sectionName) {
    case "dashboard":
      loadDashboard();
      break;
    case "events":
      loadAllEvents();
      break;
    case "inventory":
      loadInventory();
      break;
    case "containers":
      loadContainers();
      break;
    case "logs":
      loadLogs();
      break;
    case "prepare":
      loadPrepareEvents();
      break;
    case "return":
      loadReturnEvents();
      break;
    case "transfer":
      loadTransferHistory();
      break;
    case "maintenance":
      loadMaintenanceAssets();
      // Ensure the Log Maintenance button is visible when entering maintenance section
      const logMaintenanceBtn = document.getElementById('log-maintenance-btn');
      if (logMaintenanceBtn) {
        logMaintenanceBtn.style.display = 'inline-block';
      }
      break;
    case "asset-check":
      loadAssetCheck();
      break;
    case "delivery-order":
      break;
  }
}

// Modal functions
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add("active");

    if (modalId === "editQuantityModal") {
      modal.style.zIndex = "1100";
    }
  }
}

function generateRemoveButton(eventId, assetId) {
    // Store raw asset ID - no HTML escaping here
    return `<button class="btn btn-danger btn-sm remove-asset-btn" 
                    data-event-id="${eventId}" 
                    data-asset-id="${assetId}"
                    style="padding: 4px 8px; font-size: 11px;">Remove</button>`;
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove("active");
}

// API functions
async function apiCall(endpoint, method = "GET", data = null) {
  try {
    const options = {
      method: method,
      headers: {
        "Content-Type": "application/json",
      },
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(endpoint, options);
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "API call failed");
    }

    return result;
  } catch (error) {
    console.error("API Error:", error);
    showNotification("error", error.message);
    throw error;
  }
}

// Tab switching functionality
function switchEventsTab(tabName) {
  // Remove active class from all tabs and content
  document.querySelectorAll(".events-tab").forEach((tab) => {
    tab.classList.remove("active");
  });
  document.querySelectorAll(".tab-content").forEach((content) => {
    content.classList.remove("active");
    content.style.display = "none";
  });

  // Add active class to clicked tab
  document.querySelector(`[data-tab="${tabName}"]`).classList.add("active");

  // Show corresponding content
  const contentDiv = document.getElementById(`${tabName}-events`);
  contentDiv.classList.add("active");
  contentDiv.style.display = "block";

  // Load appropriate data
  if (tabName === "ongoing") {
    loadOngoingEvents();
  } else if (tabName === "upcoming") {
    loadUpcomingEvents();
  }
}

// Load ongoing events (events that are currently active)
async function loadOngoingEvents() {
    try {
        const container = document.getElementById('ongoing-events');
        if (!container) {
            console.warn('ongoing-events container not found, retrying in 500ms...');
            setTimeout(() => loadOngoingEvents(), 500);
            return;
        }
        
        container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">Loading ongoing events...</p>';
        
        const response = await apiCall('/api/events');
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const ongoingEvents = response.data.filter(event => {
            const startDate = new Date(event.startDate);
            const endDate = new Date(event.endDate);
            startDate.setHours(0, 0, 0, 0);
            endDate.setHours(23, 59, 59, 999);
            
            return today >= startDate && today <= endDate;
        });
        
        container.innerHTML = '';
        
        if (ongoingEvents.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No ongoing events at the moment.</p>';
            return;
        }
        
        ongoingEvents.forEach(event => {
            container.appendChild(createEventCard(event));
        });
        
        console.log(`Loaded ${ongoingEvents.length} ongoing events`);
    } catch (error) {
        console.error('Error loading ongoing events:', error);
        const container = document.getElementById('ongoing-events');
        if (container) {
            container.innerHTML = '<p style="color: red; text-align: center;">Error loading ongoing events. <button onclick="loadOngoingEvents()">Retry</button></p>';
        }
    }
}

// Load upcoming events (events that start in the future)
async function loadUpcomingEvents() {
    try {
        const container = document.getElementById('upcoming-events');
        if (!container) {
            console.warn('upcoming-events container not found, retrying in 500ms...');
            setTimeout(() => loadUpcomingEvents(), 500);
            return;
        }
        
        container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">Loading upcoming events...</p>';
        
        const response = await apiCall('/api/events');
        const today = new Date();
        today.setHours(23, 59, 59, 999);
        
        const upcomingEvents = response.data
            .filter(event => {
                const startDate = new Date(event.startDate);
                return startDate > today;
            })
            .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
        
        // Update the counter
        updateUpcomingEventsCounter(upcomingEvents.length);
        
        container.innerHTML = '';
        
        if (upcomingEvents.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No upcoming events scheduled.</p>';
            return;
        }
        
        upcomingEvents.slice(0, 6).forEach(event => {
            container.appendChild(createEventCard(event));
        });
        
        console.log(`Loaded ${upcomingEvents.length} upcoming events (showing first 6)`);
    } catch (error) {
        console.error('Error loading upcoming events:', error);
        const container = document.getElementById('upcoming-events');
        if (container) {
            container.innerHTML = '<p style="color: red; text-align: center;">Error loading upcoming events. <button onclick="loadUpcomingEvents()">Retry</button></p>';
        }
        // Set counter to 0 on error
        updateUpcomingEventsCounter(0);
    }
}

// Update the upcoming events counter
function updateUpcomingEventsCounter(count) {
    const counter = document.getElementById('upcoming-events-counter');
    if (counter) {
        counter.textContent = count;
        
        // Update counter styling based on count
        if (count === 0) {
            counter.style.background = '#6c757d'; // Gray for 0
        } else if (count <= 3) {
            counter.style.background = '#28a745'; // Green for few events
        } else if (count <= 6) {
            counter.style.background = '#ffc107'; // Yellow for moderate events
        } else {
            counter.style.background = '#dc3545'; // Red for many events
        }
    }
}

// load the dashboard
async function loadDashboard() {
  try {
    await apiCall('/api/events/update-states', 'POST');
    const response = await apiCall('/api/events');
    
    // Count and update overdue events counter
    const overdueCount = countOverdueEvents(response.data);
    updateOverdueCounter(overdueCount);
    
    // Load stats
    const statsResponse = await apiCall("/api/stats");
    stats = statsResponse.data;

    // Update statistics with element checking
    const totalEventsEl = document.getElementById("total-events");
    const activeEventsEl = document.getElementById("active-events");
    const totalAssetsEl = document.getElementById("total-assets");
    const deployedAssetsEl = document.getElementById("deployed-assets");

    if (totalEventsEl) totalEventsEl.textContent = stats.totalEvents || 0;
    if (activeEventsEl) activeEventsEl.textContent = stats.activeEvents || 0;
    if (totalAssetsEl) totalAssetsEl.textContent = stats.totalAssets || 0;
    if (deployedAssetsEl)
      deployedAssetsEl.textContent = stats.deployedAssets || 0;

    // Load ongoing events with a delay to ensure elements exist
    setTimeout(async () => {
      await loadOngoingEvents();
      await loadUpcomingEvents(); // Also load upcoming events to update counter
    }, 300);
  } catch (error) {
    console.error("Error loading dashboard:", error);
  }
}

function sortEventsStartDateFutureTop(list) {
  const parseEventDate = (val) => {
    if (!val) return new Date(NaN);
    if (typeof val === "string") {
      const norm = val.includes("/")
        ? (() => {
            const [y, m, d] = val.split("/");
            return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          })()
        : val;

      // force local noon to avoid timezone edge-cases around midnight
      if (/^\d{4}-\d{2}-\d{2}$/.test(norm)) {
        return new Date(`${norm}T12:00:00`);
      }
      return new Date(norm);
    }
    return new Date(val);
  };

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

  return [...list].sort((a, b) => {
    const aStart = parseEventDate(a.startDate);
    const bStart = parseEventDate(b.startDate);

    const aFuture = aStart >= startOfToday;
    const bFuture = bStart >= startOfToday;

    // bucket: future first
    if (aFuture !== bFuture) return aFuture ? -1 : 1;

    // within the future bucket: DESC (later first => Oct above Sep)
    if (aFuture) return bStart - aStart;

    // within past/ongoing bucket: DESC (most recent past first)
    return bStart - aStart;
  });
}

async function loadAllEvents() {
  try {
    const response = await apiCall('/api/events');
    events = response.data;

    // Update overdue counter (unchanged)
    const overdueCount = countOverdueEvents(events);
    updateOverdueCounter(overdueCount);

    const container = document.getElementById('all-events');
    container.innerHTML = '';

    if (!events || events.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No events found.</p>';
      return;
    }

    // NEW: sort by start date with future events on top
    const sorted = sortEventsStartDateFutureTop(events);

    sorted.forEach(event => {
      container.appendChild(createEventCard(event));
    });
  } catch (error) {
    document.getElementById('all-events').innerHTML = '<p style="color: red; text-align: center;">Error loading events</p>';
  }
}

function createEventCard(event) {
    const card = document.createElement('div');
    card.className = `event-card state-${event.state.toLowerCase()}`;
    
    // Helper function to escape HTML
    const escapeHtml = (str) => {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    };
    
    // Helper function to get tag styling
    const getTagStyle = (tag) => {
        if (tag === 'dry hire') {
            return 'background: #17a2b8; color: white;';
        }
        return 'background: #28a745; color: white;';
    };
    
    const getTagDisplay = (tag) => {
        return tag === 'dry hire' ? 'DRY HIRE' : 'EVENT';
    };
    
    const dateRange = event.startDate === event.endDate 
        ? formatDate(event.startDate)
        : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;

    card.innerHTML = `
        <div class="event-header">
            <div style="display: flex; align-items: center; gap: 8px;">
                <div class="event-id">ID: ${event.id}</div>
                <span style="padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; ${getTagStyle(event.tag || 'events')}">
                    ${getTagDisplay(event.tag || 'events')}
                </span>
            </div>
            <div class="event-state state-${event.state.toLowerCase()}">${escapeHtml(event.state)}</div>
        </div>
        <div class="event-title">${escapeHtml(event.name)}</div>
        <div class="event-date">${escapeHtml(dateRange)}</div>
        <div style="margin: 15px 0;">
            <small style="color: #666;">${event.assetCount || 0} assets assigned</small>
        </div>
        <div class="event-actions">
            <button class="btn btn-primary" onclick="viewEvent(${event.id})">View</button>
            <button class="btn btn-warning" onclick="editEvent(${event.id})">Edit</button>
            <button class="btn btn-secondary" onclick="showForceStateModal(${event.id}, '${event.state}')">Force State</button>
            <button class="btn btn-danger" onclick="deleteEvent(${event.id})">Delete</button>
        </div>
    `;

    return card;
}

// Update all event states manually
async function updateAllEventStates() {
    try {
        const response = await apiCall('/api/events/update-states', 'POST');
        
        if (response.updatedEvents && response.updatedEvents.length > 0) {
            showNotification('success', `Updated ${response.updatedEvents.length} event(s) to current state`);
            
            // Log the changes
            response.updatedEvents.forEach(event => {
                console.log(`Event ${event.eventId} (${event.name}): ${event.oldState} → ${event.newState}`);
            });
            
            // Refresh the dashboard
            if (document.getElementById('dashboard-section').classList.contains('active')) {
                loadDashboard();
            }
        } else {
            showNotification('info', 'All events are already in the correct state');
        }
        
    } catch (error) {
        showNotification('error', `Failed to update event states: ${error.message}`);
    }
}

// Force event state
async function forceEventState(eventId, newState) {
    try {
        const response = await apiCall(`/api/events/${eventId}/force-state`, 'POST', { state: newState });
        
        showNotification('success', `Event ${eventId} state forced to ${newState}`);
        console.log(`Event ${eventId} state forced: ${response.oldState} → ${response.newState}`);
        
        // Refresh all relevant views
        setTimeout(() => {
            if (document.getElementById('prepare-section').classList.contains('active')) {
                loadPrepareEvents();
            }
            if (document.getElementById('dashboard-section').classList.contains('active')) {
                loadDashboard();
            }
            if (document.getElementById('events-section').classList.contains('active')) {
                loadAllEvents();
            }
            if (document.getElementById('return-section').classList.contains('active')) {
                loadReturnEvents();
            }
        }, 500);
        
    } catch (error) {
        showNotification('error', `Failed to force event state: ${error.message}`);
        console.error('Error forcing event state:', error);
    }
}

// Remove forced state override
async function removeForcedState(eventId) {
    try {
        const response = await apiCall(`/api/events/${eventId}/remove-force-state`, 'POST');
        
        showNotification('success', `Event ${eventId} returned to automatic state management`);
        console.log(`Event ${eventId} force override removed: ${response.oldState} → ${response.newState}`);
        
        // Refresh all relevant views
        setTimeout(() => {
            if (document.getElementById('prepare-section').classList.contains('active')) {
                loadPrepareEvents();
            }
            if (document.getElementById('dashboard-section').classList.contains('active')) {
                loadDashboard();
            }
            if (document.getElementById('events-section').classList.contains('active')) {
                loadAllEvents();
            }
            if (document.getElementById('return-section').classList.contains('active')) {
                loadReturnEvents();
            }
        }, 500);
        
    } catch (error) {
        showNotification('error', `Failed to remove forced state: ${error.message}`);
        console.error('Error removing forced state:', error);
    }
}

// Show force state modal
function showForceStateModal(eventId, currentState) {
    // Create modal HTML if it doesn't exist
    let modal = document.getElementById('forceStateModal');
    if (!modal) {
        const modalHTML = `
            <div id="forceStateModal" class="modal">
                <div class="modal-content" style="max-width: 450px;">
                    <div class="modal-header">
                        <h3>Force Event State</h3>
                    </div>
                    <div class="modal-body">
                        <div style="margin-bottom: 20px;">
                            <p><strong>Event ID:</strong> <span id="forceStateEventId"></span></p>
                            <p><strong>Current State:</strong> <span id="forceStateCurrentState"></span></p>
                        </div>
                        
                        <div class="form-group">
                            <label for="forceStateSelect">Select New State:</label>
                            <select id="forceStateSelect" class="form-input">
                                <option value="">Choose a state...</option>
                                <option value="Added">Added</option>
                                <option value="Planning">Planning</option>
                                <option value="Preparing">Preparing</option>
                                <option value="Ready">Ready</option>
                                <option value="Ongoing">Ongoing</option>
                                <option value="Returning">Returning</option>
                                <option value="Closed">Closed</option>
                                <option value="Overdue">Overdue</option>
                            </select>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" id="forceStateCancelBtn">Cancel</button>
                        <button type="button" class="btn btn-primary" id="forceStateConfirmBtn">Force State</button>
                    </div>
                </div>
            </div>
        `;
        
        // Add modal to DOM
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        modal = document.getElementById('forceStateModal');
        
        // Add click event listener to modal backdrop
        modal.addEventListener('click', function(event) {
            if (event.target === modal) {
                modal.style.display = 'none';
            }
        });
        
        // Add click event listeners to buttons
        document.getElementById('forceStateCancelBtn').addEventListener('click', function() {
            modal.style.display = 'none';
        });
        
        document.getElementById('forceStateConfirmBtn').addEventListener('click', function() {
            confirmForceState();
        });
    }
    
    // Now populate the modal
    const eventIdSpan = document.getElementById('forceStateEventId');
    const currentStateSpan = document.getElementById('forceStateCurrentState');
    const stateSelect = document.getElementById('forceStateSelect');
    
    if (eventIdSpan && currentStateSpan && stateSelect) {
        eventIdSpan.textContent = eventId;
        currentStateSpan.textContent = currentState;
        
        // Reset select to default
        stateSelect.value = '';
        
        // Store event ID for use in confirmation
        stateSelect.setAttribute('data-event-id', eventId);
        
        // Show modal
        modal.style.display = 'block';
    } else {
        console.error('Modal elements not found after creation');
        showNotification('error', 'Failed to open force state modal');
    }
}

// Show force state modal - Updated to show current force status
function showForceStateModal(eventId, currentState) {
    // Create modal HTML if it doesn't exist
    let modal = document.getElementById('forceStateModal');
    if (!modal) {
        const modalHTML = `
            <div id="forceStateModal" class="modal">
                <div class="modal-content" style="max-width: 450px;">
                    <div class="modal-header">
                        <h3>Force Event State</h3>
                    </div>
                    <div class="modal-body">
                        <div style="margin-bottom: 20px;">
                            <p><strong>Event ID:</strong> <span id="forceStateEventId"></span></p>
                            <p><strong>Current State:</strong> <span id="forceStateCurrentState"></span> <span id="forceStateIndicator"></span></p>
                        </div>
                        
                        <div class="form-group">
                            <label for="forceStateSelect">Select New State:</label>
                            <select id="forceStateSelect" class="form-input">
                                <option value="">Choose a state...</option>
                                <option value="Added">Added</option>
                                <option value="Planning">Planning</option>
                                <option value="Preparing">Preparing</option>
                                <option value="Ready">Ready</option>
                                <option value="Ongoing">Ongoing</option>
                                <option value="Returning">Returning</option>
                                <option value="Closed">Closed</option>
                                <option value="Overdue">Overdue</option>
                            </select>
                        </div>
                        <div id="removeForceSection" style="background: #e7f3ff; border: 1px solid #b3d9ff; padding: 15px; border-radius: 5px; margin: 20px 0; display: none;">
                            <strong>ℹ️ Note:</strong> This event's state is currently forced. You can return it to automatic state management.
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" id="forceStateCancelBtn">Cancel</button>
                        <button type="button" class="btn btn-warning" id="removeForceBtn" style="display: none;" onclick="handleRemoveForcedState()">Remove Force</button>
                        <button type="button" class="btn btn-primary" id="forceStateConfirmBtn">Force State</button>
                    </div>
                </div>
            </div>
        `;
        
        // Add modal to DOM and set up event listeners
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        modal = document.getElementById('forceStateModal');
        
        // Event listeners
        modal.addEventListener('click', function(event) {
            if (event.target === modal) {
                modal.style.display = 'none';
            }
        });
        
        document.getElementById('forceStateCancelBtn').addEventListener('click', function() {
            modal.style.display = 'none';
        });
        
        document.getElementById('forceStateConfirmBtn').addEventListener('click', function() {
            confirmForceState();
        });
    }
    
    // Populate the modal and check if state is forced
    const eventIdSpan = document.getElementById('forceStateEventId');
    const currentStateSpan = document.getElementById('forceStateCurrentState');
    const forceStateIndicator = document.getElementById('forceStateIndicator');
    const removeForceSection = document.getElementById('removeForceSection');
    const removeForceBtn = document.getElementById('removeForceBtn');
    const stateSelect = document.getElementById('forceStateSelect');
    
    if (eventIdSpan && currentStateSpan && stateSelect) {
        eventIdSpan.textContent = eventId;
        currentStateSpan.textContent = currentState;
        
        // Check if this event has a forced state by calling the API
        checkIfStateIsForced(eventId).then(isForced => {
            if (isForced) {
                forceStateIndicator.innerHTML = '<span style="color: #dc3545; font-weight: bold;">(FORCED)</span>';
                removeForceSection.style.display = 'block';
                removeForceBtn.style.display = 'inline-block';
            } else {
                forceStateIndicator.innerHTML = '';
                removeForceSection.style.display = 'none';
                removeForceBtn.style.display = 'none';
            }
        });
        
        // Reset select and store event ID
        stateSelect.value = '';
        stateSelect.setAttribute('data-event-id', eventId);
        
        // Show modal
        modal.style.display = 'block';
    } else {
        console.error('Modal elements not found after creation');
        showNotification('error', 'Failed to open force state modal');
    }
}

// Helper function to check if state is forced
async function checkIfStateIsForced(eventId) {
    try {
        const response = await apiCall(`/api/events/${eventId}`);
        return response.data.forceStateOverride || false;
    } catch (error) {
        console.error('Error checking force state status:', error);
        return false;
    }
}

// Handle remove forced state
function handleRemoveForcedState() {
    const stateSelect = document.getElementById('forceStateSelect');
    const eventId = parseInt(stateSelect.getAttribute('data-event-id'));
    
    if (!eventId) {
        showNotification('error', 'Event ID not found');
        return;
    }
    
    // Close modal
    const modal = document.getElementById('forceStateModal');
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Remove forced state
    removeForcedState(eventId);
}

// Handle modal backdrop clicks
function handleModalBackdropClick(event, modalId) {
    if (event.target.id === modalId) {
        closeModal(modalId);
    }
}

// Close force state modal specifically
function closeForceStateModal() {
    const modal = document.getElementById('forceStateModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Confirm force state change
function confirmForceState() {
    const stateSelect = document.getElementById('forceStateSelect');
    const modal = document.getElementById('forceStateModal');
    
    if (!stateSelect) {
        showNotification('error', 'State selection not found');
        return;
    }
    
    const eventId = parseInt(stateSelect.getAttribute('data-event-id'));
    const newState = stateSelect.value;
    
    if (!newState) {
        showNotification('warning', 'Please select a state');
        return;
    }
    
    if (!eventId) {
        showNotification('error', 'Event ID not found');
        return;
    }
    
    // Close modal
    if (modal) {
        modal.style.display = 'none';
    }
    
    // Force the state
    forceEventState(eventId, newState);
}

function getModelStatusIcon(status) {
    switch(status) {
        case 'returned': return '↩️';
        case 'ready': return '✅';
        case 'ongoing': return '🔴';
        case 'partial': return '🔄';
        case 'pending': return '📋';
        default: return '📋';
    }
}

async function loadInventory() {
  try {
    const response = await apiCall("/api/assets");
    assets = response.data;

    // Set up event listeners for filters and sorting
    setupInventoryFilters();

    // Display all assets initially
    displayFilteredInventory();
  } catch (error) {
    document.getElementById("inventory-table-container").innerHTML =
      '<p style="color: red; text-align: center;">Error loading inventory</p>';
  }
}

function setupInventoryFilters() {
  // Remove existing listeners to prevent duplicates
  const searchInput = document.getElementById("asset-search");
  const deptFilter = document.getElementById("department-filter");
  const statusFilter = document.getElementById("status-filter");
  const sortSelect = document.getElementById("sort-select");
  const sortDesc = document.getElementById("sort-descending");

  if (searchInput) {
    searchInput.removeEventListener("input", displayFilteredInventory);
    searchInput.addEventListener("input", displayFilteredInventory);
  }

  if (deptFilter) {
    deptFilter.removeEventListener("change", displayFilteredInventory);
    deptFilter.addEventListener("change", displayFilteredInventory);
  }

  if (statusFilter) {
    statusFilter.removeEventListener("change", displayFilteredInventory);
    statusFilter.addEventListener("change", displayFilteredInventory);
  }

  if (sortSelect) {
    sortSelect.removeEventListener("change", displayFilteredInventory);
    sortSelect.addEventListener("change", displayFilteredInventory);
  }

  if (sortDesc) {
    sortDesc.removeEventListener("change", displayFilteredInventory);
    sortDesc.addEventListener("change", displayFilteredInventory);
  }
}

function displayFilteredInventory() {
  const searchTerm =
    document.getElementById("asset-search")?.value.toLowerCase() || "";
  const deptFilter = document.getElementById("department-filter")?.value || "";
  const statusFilter = document.getElementById("status-filter")?.value || "";
  const sortBy = document.getElementById("sort-select")?.value || "id";
  const sortDesc = document.getElementById("sort-descending")?.checked || false;

  // Filter assets
  let filteredAssets = assets.filter((asset) => {
    // Search filter
    const searchableText = `${asset.id} ${asset.brand} ${asset.model} ${
      asset.description || ""
    }`.toLowerCase();
    const matchesSearch = !searchTerm || searchableText.includes(searchTerm);

    // Department filter
    const matchesDept = !deptFilter || asset.department === deptFilter;

    // Status filter
    const matchesStatus = !statusFilter || asset.status === statusFilter;

    return matchesSearch && matchesDept && matchesStatus;
  });

  // Sort assets
  filteredAssets.sort((a, b) => {
    let aVal = a[sortBy] || "";
    let bVal = b[sortBy] || "";

    // Convert to strings for comparison
    aVal = aVal.toString().toLowerCase();
    bVal = bVal.toString().toLowerCase();

    let comparison = aVal.localeCompare(bVal);
    return sortDesc ? -comparison : comparison;
  });

  // Update count
  const countElement = document.getElementById("asset-count");
  if (countElement) {
    countElement.textContent = `${filteredAssets.length} of ${assets.length} assets`;
  }

  // Display filtered assets
  displayInventoryTable(filteredAssets);
}

function clearFilters() {
  document.getElementById("asset-search").value = "";
  document.getElementById("department-filter").value = "";
  document.getElementById("status-filter").value = "";
  document.getElementById("sort-select").value = "id";
  document.getElementById("sort-descending").checked = false;
  displayFilteredInventory();
}

function displayInventoryTable(assetsToShow) {
  const container = document.getElementById("inventory-table-container");

  if (assetsToShow.length === 0) {
    container.innerHTML =
      '<p style="text-align: center; color: #666; padding: 40px;">No assets found.</p>';
    return;
  }

  let tableHTML = `
        <table class="table">
            <thead>
                <tr>
                    <th>Asset ID</th>
                    <th>Brand</th>
                    <th>Model</th>
                    <th>Serial</th>
                    <th>Department</th>
                    <th>Status</th>
                    <th>Location</th>
                    <th>OOC Status</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
    `;

  assetsToShow.forEach((asset) => {
    tableHTML += `
            <tr>
                <td>${asset.id}</td>
                <td>${asset.brand}</td>
                <td>${asset.model}</td>
                <td>${asset.serial || "N/A"}</td>
                <td><span class="asset-badge dept-${asset.department.toLowerCase()}">${
      asset.department
    }</span></td>
                <td><span class="asset-badge status-${asset.status}">${
      asset.status
    }</span></td>
                <td>${asset.location || "Store"}</td>
                <td>
                    <span class="asset-badge ${asset.isOOC ? 'status-ooc' : 'status-available'}">
                        ${asset.isOOC ? 'Out of Commission' : 'Available'}
                    </span>
                </td>
                <td>
                    <button class="btn btn-primary btn-sm" onclick="viewMaintenanceLog('${asset.id}')" title="View maintenance log">
                        View Log
                    </button>
                </td>
            </tr>
        `;
  });

  tableHTML += `
            </tbody>
        </table>
    `;

  container.innerHTML = tableHTML;
}

async function loadContainers() {
  const root = document.getElementById("containers-list");
  if (!root) return;
  // remove the legacy "Add Container" button (blue) if your HTML template still has one
  // (we keep the "+ New Container" button that this function renders)
  const containersSection = document.getElementById('containers-section');
  if (containersSection) {
    const legacyBtn = Array.from(containersSection.querySelectorAll('button'))
      .find(btn => btn.closest('#containers-list') === null && (
        (btn.classList.contains('btn-primary') || btn.classList.contains('btn')) &&
        (
          (btn.getAttribute('onclick') || '').includes('createContainer') ||
          (btn.getAttribute('onclick') || '').toLowerCase().includes('container') ||
          /add\s+container/i.test(btn.textContent || '') ||
          /new\s+container/i.test(btn.textContent || '')
        )
      ));
    if (legacyBtn) legacyBtn.remove();
  }

  try {
    await refreshContainersCache(true);
    const cache = await refreshContainersCache(false);
    const list = Object.values(cache);

    // toolbar + cards wrapper
    root.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div style="font-size:20px;font-weight:700;">Containers</div>
        <button class="btn btn-success" onclick="createContainer()">+ New Container</button>
      </div>
      <div id="containers-cards"></div>
    `;

    const cards = document.getElementById("containers-cards");
    if (!cards) return;

    if (list.length === 0) {
      cards.innerHTML = `<div style="padding:20px;color:#666;text-align:center;">No containers yet.</div>`;
      return;
    }

    list
      .sort((a, b) => (a.id || '').localeCompare(b.id || ''))
      .forEach(c => {
        const card = document.createElement("div");
        card.className = "card";
        card.style.marginBottom = "12px";
        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
            <div>
              <div style="font-weight:700;font-size:16px;">${escapeHtml(c.id)}</div>
              <div style="color:#666;font-size:13px;">${c.assetCount || (c.assetIds ? c.assetIds.length : 0)} assets</div>
            </div>
            <div style="display:flex;gap:8px;">
              <button class="btn btn-secondary btn-sm" onclick="viewContainer('${String(c.id).replace(/'/g, "\\'")}')">View</button>
              <button class="btn btn-primary btn-sm" onclick="editContainer('${String(c.id).replace(/'/g, "\\'")}')">Edit</button>
            </div>
          </div>
        `;
        cards.appendChild(card);
      });

  } catch (e) {
    console.error("loadContainers error:", e);
    root.innerHTML = `<div style="padding:20px;color:#a00;">Failed to load containers: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

function ensureContainerCrudModal() {
  if (document.getElementById("containerCrudModal")) return;

  const modal = document.createElement("div");
  modal.id = "containerCrudModal";
  modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-content" style="max-width:780px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div id="containerCrudModalTitle" style="font-size:18px;font-weight:700;">Container</div>
        <button class="btn btn-secondary btn-sm" onclick="closeModal('containerCrudModal')">Close</button>
      </div>
      <div id="containerCrudModalBody"></div>
    </div>
  `;
  document.body.appendChild(modal);
}

function parseAssetIdsFromTextarea(text) {
  return (text || '')
    .replace(/\r/g, '')
    .split(/\n|,/)
    .map(s => s.trim())
    .filter(Boolean);
}

// ---------------- Container Asset Selector (same UX as Maintenance selector) ----------------
// ---------------- Container Asset Selector (same UX as Maintenance selector) ----------------

// stronger loader: ensures assets are actually the full inventory list (id/brand/model present)
async function ensureAssetsLoadedForContainerSelector(force = false) {
  const looksValid =
    Array.isArray(assets) &&
    assets.length > 0 &&
    assets[0] &&
    typeof assets[0].id !== "undefined" &&
    typeof assets[0].brand !== "undefined" &&
    typeof assets[0].model !== "undefined";

  // If assets already look correct and not forcing refresh, do nothing
  if (!force && looksValid) return true;

  try {
    const res = await apiCall("/api/assets");
    assets = (res && res.data) ? res.data : [];
    return Array.isArray(assets) && assets.length > 0;
  } catch (e) {
    console.error("Failed to load assets for container selector:", e);
    showNotification("error", "Assets not loaded yet. Please refresh the page.");
    return false;
  }
}

// IMPORTANT: this prevents “typing but nothing happens” by:
// - replacing the input node to wipe any stale listeners
// - binding input events cleanly every time the modal opens

async function initContainerAssetSelector(initialAssetIds = []) {
  const resultsEl = document.getElementById("availableContainerAssets");
  const searchElInitial = document.getElementById("containerAssetSearch");

  // lock UI during load so user can’t type before assets + listeners are ready
  if (searchElInitial) {
    searchElInitial.disabled = true;
    searchElInitial.placeholder = "Loading assets…";
  }
  if (resultsEl) {
    resultsEl.innerHTML =
      '<div style="padding:20px;text-align:center;color:#666;">Loading assets…</div>';
  }

  // FORCE refresh from /api/assets so selector always has correct asset objects
  await ensureAssetsLoadedForContainerSelector(true);

  // set selected assets
  selectedContainerAssets = new Set(Array.isArray(initialAssetIds) ? initialAssetIds : []);
  updateSelectedContainerAssetsDisplay();

  // re-bind listeners reliably
  const searchEl = bindContainerAssetSearchHandlers();

  // enable once ready
  if (searchEl) {
    searchEl.disabled = false;
    searchEl.placeholder = "Search by asset ID / brand / model / serial... (Press Enter for exact ID)";
  }

  // default panel message
  if (resultsEl) {
    resultsEl.innerHTML =
      '<div style="padding:20px;text-align:center;color:#666;">Type at least 2 characters to search...</div>';
  }

  // if user already typed something quickly, render results
  try { searchContainerAssets(); } catch (err) { console.error("Container search init failed:", err); }
}

// container modal asset-search: bind once per modal open, reliably
let _containerAssetSearchAC = null;

function bindContainerAssetSearchHandlers() {
  const el = document.getElementById("containerAssetSearch");
  if (!el) return null;

  // remove any previous listeners from earlier opens
  try { _containerAssetSearchAC?.abort(); } catch (_) {}
  _containerAssetSearchAC = new AbortController();
  const { signal } = _containerAssetSearchAC;

  let t = null;
  const scheduleSearch = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      try {
        searchContainerAssets();
      } catch (err) {
        console.error("searchContainerAssets failed:", err);
        const results = document.getElementById("availableContainerAssets");
        if (results) {
          results.innerHTML =
            '<div style="padding:20px;text-align:center;color:#c00;">Search failed — check console.</div>';
        }
      }
    }, 50);
  };

  // search live while typing (same behavior as maintenance selector)
  el.addEventListener("input", scheduleSearch, { signal });
  el.addEventListener("keyup", scheduleSearch, { signal });
  el.addEventListener("paste", scheduleSearch, { signal });
  el.addEventListener("change", scheduleSearch, { signal });

  // Enter-to-add exact asset ID / serial / container ID
  el.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter") return;
      Promise.resolve(handleContainerAssetSearchKeypress(e)).catch((err) => {
        console.error("handleContainerAssetSearchKeypress failed:", err);
      });
    },
    { signal }
  );

  // run once in case there's already text in the field
  scheduleSearch();

  return el;
}

function updateSelectedContainerAssetsDisplay() {
  const countElement = document.getElementById('selectedContainerAssetsCount');
  const listElement = document.getElementById('selectedContainerAssetsList');
  if (!countElement || !listElement) return;

  countElement.textContent = selectedContainerAssets.size;

  if (selectedContainerAssets.size === 0) {
    listElement.innerHTML = '<span style="color:#666;font-style:italic;">No assets selected</span>';
    return;
  }

  let html = '<div style="display:flex;flex-wrap:wrap;gap:8px;">';
  selectedContainerAssets.forEach(assetId => {
    const asset = Array.isArray(assets) ? assets.find(a => a.id === assetId) : null;
    if (asset) {
      html += `
        <div style="background:#e7f3ff;border:1px solid #b3d9ff;border-radius:6px;padding:6px 10px;display:flex;align-items:center;gap:8px;font-size:13px;">
          <span style="font-weight:500;">${escapeHtml(assetId)}</span>
          <span style="color:#666;">- ${escapeHtml(asset.brand)} ${escapeHtml(asset.model)}</span>
          <button onclick="removeAssetFromContainer('${escapeHtmlAttr(assetId)}')" style="background:none;border:none;color:#999;cursor:pointer;padding:0;margin-left:4px;font-size:14px;" title="Remove">×</button>
        </div>
      `;
    } else {
      html += `
        <div style="background:#fff3cd;border:1px solid #ffeaa7;border-radius:6px;padding:6px 10px;display:flex;align-items:center;gap:8px;font-size:13px;">
          <span style="font-weight:500;">${escapeHtml(assetId)}</span>
          <span style="color:#666;">- Asset not found</span>
          <button onclick="removeAssetFromContainer('${escapeHtmlAttr(assetId)}')" style="background:none;border:none;color:#999;cursor:pointer;padding:0;margin-left:4px;font-size:14px;" title="Remove">×</button>
        </div>
      `;
    }
  });
  html += '</div>';
  listElement.innerHTML = html;
}

function selectAssetForContainer(assetId) {
  if (!assetId) return;
  if (!Array.isArray(assets) || assets.length === 0) {
    showNotification('error', 'Assets not loaded');
    return;
  }

  const asset = assets.find(a => a.id === assetId);
  if (!asset) {
    showNotification('error', `Asset ${assetId} not found`);
    return;
  }

  if (selectedContainerAssets.has(assetId)) {
    showNotification('warning', `Asset ${assetId} is already selected`);
    return;
  }

  selectedContainerAssets.add(assetId);
  updateSelectedContainerAssetsDisplay();

  const searchContainer = document.getElementById('availableContainerAssets');
  if (searchContainer) {
    searchContainer.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">Asset added. Search for more assets to add to this container.</div>';
  }

  showNotification('success', `Added ${assetId} to container`);
}

function removeAssetFromContainer(assetId) {
  selectedContainerAssets.delete(assetId);
  updateSelectedContainerAssetsDisplay();
  // refresh search results
  searchContainerAssets();
}

function clearContainerSelection() {
  selectedContainerAssets.clear();
  updateSelectedContainerAssetsDisplay();
  searchContainerAssets();
}

function searchContainerAssets() {
  const searchEl = document.getElementById('containerAssetSearch');
  const containerEl = document.getElementById('availableContainerAssets');
  if (!searchEl || !containerEl) return;

  const term = (searchEl.value || '').toLowerCase().trim();

  if (!term || term.length < 2) {
    containerEl.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">Type at least 2 characters to search...</div>';
    return;
  }

  if (!Array.isArray(assets) || assets.length === 0) {
    containerEl.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">No assets loaded. Please refresh the page.</div>';
    return;
  }

  const filtered = assets.filter(asset => {
    const searchableText =
      `${asset.id} ${asset.brand} ${asset.model} ${asset.serial || ''} ${escapeJs(asset.description || '')}`
        .toLowerCase();
    return searchableText.includes(term) && !selectedContainerAssets.has(asset.id);
  });

  if (filtered.length === 0) {
    containerEl.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">No matching assets found.</div>';
    return;
  }

  let html = '';
  filtered.slice(0, 50).forEach(asset => {
    const statusBadge = getAssetStatusBadge(asset);
    const locationText = asset.location || 'Store';
    html += `
      <div class="container-asset-item" style="padding:12px;border-bottom:1px solid #f1f1f1;display:flex;justify-content:space-between;align-items:center;cursor:pointer;transition:background-color 0.2s;"
           onmouseover="this.style.backgroundColor='#f8f9fa'"
           onmouseout="this.style.backgroundColor='white'"
           data-asset-id="${escapeHtml(asset.id)}">
        <div style="flex:1;">
          <div style="font-weight:500;margin-bottom:4px;">${escapeHtml(asset.id)}</div>
          <div style="color:#666;font-size:13px;margin-bottom:2px;">${escapeHtml(asset.brand)} ${escapeHtml(asset.model)}</div>
          <div style="color:#999;font-size:12px;">${escapeJs(asset.description || '')}</div>
          <div style="margin-top:4px;">
            ${statusBadge}
            <span style="color:#999;font-size:11px;margin-left:8px;">📍 ${escapeHtml(locationText)}</span>
          </div>
        </div>
        <button class="btn btn-primary select-container-btn" style="padding:6px 12px;font-size:12px;" data-asset-id="${escapeHtml(asset.id)}">Select</button>
      </div>
    `;
  });

  containerEl.innerHTML = html;
}

async function handleContainerAssetSearchKeypress(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();

  const searchTerm = (e.target.value || '').trim();
  if (!searchTerm) return;

  // load assets on demand
  await ensureAssetsLoadedForContainerSelector();
  if (!Array.isArray(assets) || assets.length === 0) return;

  // exact asset match first
  const asset = assets.find(a =>
    a.id.toLowerCase() === searchTerm.toLowerCase() ||
    (a.serial && a.serial.toLowerCase() === searchTerm.toLowerCase())
  );

  if (asset) {
    selectAssetForContainer(asset.id);
    e.target.value = '';
    return;
  }

  // container match (lets you type a container ID and add all its assets)
  try {
    const container = await getContainerById(searchTerm, true);
    if (!container) {
      showNotification('error', `Asset/Container '${searchTerm}' not found`);
      return;
    }

    let added = 0;
    let already = 0;

    for (const aid of (container.assetIds || [])) {
      if (!selectedContainerAssets.has(aid)) {
        // only add if the asset exists in inventory
        if (assets.find(a => a.id === aid)) {
          selectedContainerAssets.add(aid);
          added++;
        }
      } else {
        already++;
      }
    }

    updateSelectedContainerAssetsDisplay();
    e.target.value = '';
    showNotification('success', `Added container ${container.id}: ${added} added (${already} already selected)`);
  } catch (err) {
    showNotification('error', `Failed to load container: ${err.message}`);
  }
}

async function createContainer() {
  ensureContainerCrudModal();

  document.getElementById("containerCrudModalTitle").textContent = "Create Container";
  document.getElementById("containerCrudModalBody").innerHTML = `
    <div class="form-group">
      <label class="form-label">Container ID</label>
      <input id="containerIdInput" class="form-input" placeholder="e.g. CASE-A01" />
    </div>

    <div class="form-group">
      <label class="form-label">Assets in this container</label>
      <div style="border:1px solid #e5e5e5;border-radius:8px;padding:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div><strong>Selected Assets:</strong> <span id="selectedContainerAssetsCount">0</span></div>
          <button class="btn btn-secondary btn-sm" onclick="clearContainerSelection()">Clear</button>
        </div>
        <div id="selectedContainerAssetsList"><span style="color:#666;font-style:italic;">No assets selected</span></div>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Search & add assets</label>
      <input id="containerAssetSearch" class="form-input" placeholder="Loading assets…" disabled />
      <div id="availableContainerAssets" style="border:1px solid #eee;border-radius:8px;overflow:auto;max-height:260px;margin-top:8px;"></div>
      <div style="color:#666;font-size:12px;margin-top:6px;">Tip: type at least 2 characters to search. Press Enter to add an exact asset ID (or a container ID).</div>
    </div>

    <div style="display:flex;gap:10px;justify-content:flex-end;">
      <button class="btn btn-secondary" onclick="closeModal('containerCrudModal')">Cancel</button>
      <button class="btn btn-success" onclick="saveNewContainer()">Create</button>
    </div>
  `;

  openModal("containerCrudModal");

  await initContainerAssetSelector([]);
  const searchEl = document.getElementById('containerAssetSearch');
  if (searchEl) searchEl.focus();
}

async function saveNewContainer() {
  const id = (document.getElementById("containerIdInput").value || '').trim();
  const assetIds = Array.from(selectedContainerAssets);

  if (!id) return showNotification('error', 'Container ID is required');
  if (assetIds.length === 0) return showNotification('error', 'Add at least 1 asset ID');

  try {
    await apiCall('/api/containers', 'POST', { id, assetIds });
    showNotification('success', `Created container ${id}`);
    closeModal("containerCrudModal");
    await loadContainers();
    await refreshContainersCache(true);
  } catch (e) {
    showNotification('error', `Failed to create container: ${e.message}`);
  }
}

async function viewContainer(containerId) {
  ensureContainerCrudModal();
  try {
    const c = await getContainerById(containerId, true);
    if (!c) return showNotification('error', `Container ${containerId} not found`);

    document.getElementById("containerCrudModalTitle").textContent = `Container: ${c.id}`;
    document.getElementById("containerCrudModalBody").innerHTML = `
      <div style="color:#666;margin-bottom:10px;">${c.assetIds.length} assets</div>
      <pre style="background:#111;color:#ddd;padding:12px;border-radius:8px;overflow:auto;max-height:420px;">${escapeHtml(c.assetIds.join('\n'))}</pre>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:12px;">
        <button class="btn btn-secondary" onclick="closeModal('containerCrudModal')">Close</button>
        <button class="btn btn-primary" onclick="editContainer('${String(c.id).replace(/'/g, "\\'")}')">Edit</button>
      </div>
    `;

    openModal("containerCrudModal");
  } catch (e) {
    showNotification('error', `Failed to load container: ${e.message}`);
  }
}

async function editContainer(containerId) {
  ensureContainerCrudModal();
  try {
    const c = await getContainerById(containerId, true);
    if (!c) return showNotification('error', `Container ${containerId} not found`);

    document.getElementById("containerCrudModalTitle").textContent = `Edit Container: ${c.id}`;
    document.getElementById("containerCrudModalBody").innerHTML = `
      <div class="form-group">
        <label class="form-label">Container ID</label>
        <input id="editContainerIdInput" class="form-input" value="${escapeHtml(c.id)}" />
        <div style="color:#666;font-size:12px;margin-top:6px;">You can rename the container here. If you change the ID, the container will be renamed when you click Save.</div>
      </div>

      <div class="form-group">
        <label class="form-label">Assets in this container</label>
        <div style="border:1px solid #e5e5e5;border-radius:8px;padding:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <div><strong>Selected Assets:</strong> <span id="selectedContainerAssetsCount">0</span></div>
            <button class="btn btn-secondary btn-sm" onclick="clearContainerSelection()">Clear</button>
          </div>
          <div id="selectedContainerAssetsList"><span style="color:#666;font-style:italic;">No assets selected</span></div>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Search & add assets</label>
        <input id="containerAssetSearch" class="form-input" placeholder="Loading assets…" disabled />
        <div id="availableContainerAssets" style="border:1px solid #eee;border-radius:8px;overflow:auto;max-height:260px;margin-top:8px;"></div>
        <div style="color:#666;font-size:12px;margin-top:6px;">Tip: type at least 2 characters to search. Press Enter to add an exact asset ID (or a container ID).</div>
      </div>

      <div style="display:flex;gap:10px;justify-content:space-between;">
        <button class="btn btn-danger" onclick="deleteContainer('${String(c.id).replace(/'/g, "\\'")}')">Delete</button>
        <div style="display:flex;gap:10px;">
          <button class="btn btn-secondary" onclick="closeModal('containerCrudModal')">Cancel</button>
          <button class="btn btn-success" onclick="saveContainerEdit('${String(c.id).replace(/'/g, "\\'")}')">Save</button>
        </div>
      </div>
    `;

    openModal("containerCrudModal");

    await initContainerAssetSelector(c.assetIds || []);
    const searchEl = document.getElementById('containerAssetSearch');
    if (searchEl) searchEl.focus();
  } catch (e) {
    showNotification('error', `Failed to edit container: ${e.message}`);
  }
}

async function saveContainerEdit(containerId) {
  const newId = (document.getElementById('editContainerIdInput')?.value || '').trim();
  const assetIds = Array.from(selectedContainerAssets);

  if (!newId) return showNotification('error', 'Container ID is required');
  if (assetIds.length === 0) return showNotification('error', 'Container must include at least 1 asset ID');

  try {
    await apiCall(`/api/containers/${encodeURIComponent(containerId)}`, 'PUT', { newId, assetIds });
    if (newId !== containerId) {
      showNotification('success', `Renamed container ${containerId} → ${newId}`);
    } else {
      showNotification('success', `Updated container ${containerId}`);
    }
    closeModal("containerCrudModal");
    await refreshContainersCache(true);
    await loadContainers();
  } catch (e) {
    showNotification('error', `Failed to update container: ${e.message}`);
  }
} 

async function deleteContainer(containerId) {
  if (!confirm(`Delete container ${containerId}?`)) return;

  try {
    await apiCall(`/api/containers/${encodeURIComponent(containerId)}`, 'DELETE');
    showNotification('success', `Deleted container ${containerId}`);
    closeModal("containerCrudModal");
    await refreshContainersCache(true);
    await loadContainers();
  } catch (e) {
    showNotification('error', `Failed to delete container: ${e.message}`);
  }
}

async function loadLogs() {
  try {
    const response = await apiCall("/api/logs");
    logs = response.data;

    const container = document.getElementById("logs-container");

    if (logs.length === 0) {
      container.innerHTML =
        '<p style="text-align: center; color: #666; padding: 40px;">No logs found.</p>';
      return;
    }

    let tableHTML = `
            <table class="table">
                <thead>
                    <tr>
                        <th>Timestamp</th>
                        <th>User</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
        `;

    logs.forEach((log) => {
      tableHTML += `
                <tr>
                    <td>${log.timestamp}</td>
                    <td>${log.user}</td>
                    <td>${log.action}</td>
                </tr>
            `;
    });

    tableHTML += "</tbody></table>";
    container.innerHTML = tableHTML;
  } catch (error) {
    document.getElementById("logs-container").innerHTML =
      '<p style="color: red; text-align: center;">Error loading logs</p>';
  }
}

async function loadPrepareEvents() {
  try {
    const response = await apiCall("/api/events");
    
    // Update overdue counter
    const overdueCount = countOverdueEvents(response.data);
    updateOverdueCounter(overdueCount);
    
    const preparableEvents = response.data.filter(
      (event) =>
        event.state !== "Closed" && // Allow all events except closed ones
        event.state !== "Overdue" && // NEW: Exclude overdue events
        event.assetCount >= 0 // Include events with 0 assets too
    );

    const container = document.getElementById("prepare-events");
    container.innerHTML = "";

    if (preparableEvents.length === 0) {
      container.innerHTML =
        '<p style="text-align: center; color: #666; padding: 40px;">No events available for preparation.</p>';
      return;
    }

    preparableEvents.forEach((event) => {
      const card = createPrepareEventCard(event);
      container.appendChild(card);
    });
  } catch (error) {
    document.getElementById("prepare-events").innerHTML =
      '<p style="color: red; text-align: center;">Error loading events</p>';
  }
}

function createPrepareEventCard(event) {
  const card = document.createElement("div");
  card.className = `event-card state-${event.state.toLowerCase()}`;

  // Helper function to escape HTML
  const escapeHtml = (str) => {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };

  const dateRange =
    event.startDate === event.endDate
      ? formatDate(event.startDate)
      : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;

  // Calculate overall preparation progress from model groups
  let totalRequired = 0;
  let totalAssigned = 0;
  let modelSummary = "";

  if (event.modelGroups && Object.keys(event.modelGroups).length > 0) {
    const models = Object.values(event.modelGroups);

    models.forEach((model) => {
      totalRequired += model.requiredQuantity;
      totalAssigned += model.assignedAssets.length;
    });

    // Show first 2 models as preview
    modelSummary =
      '<div style="margin: 10px 0; font-size: 12px; color: #666;">';
    models.slice(0, 2).forEach((model) => {
      const statusIcon = getModelStatusIcon(model.status);
      const assignedCount = model.assignedAssets.length;
      modelSummary += `<div>${statusIcon} ${model.requiredQuantity}x ${escapeHtml(model.brand)} ${escapeHtml(model.model)} (${assignedCount}/${model.requiredQuantity})</div>`;
    });

    if (models.length > 2) {
      modelSummary += `<div style="font-style: italic;">... and ${
        models.length - 2
      } more</div>`;
    }
    modelSummary += "</div>";
  } else {
    // Fall back to using the event's asset counts for events without model groups (like custom assets only)
    totalRequired = event.assetCount || 0;
    totalAssigned = event.preparedCount || 0;
  }

  const progressPercent =
    totalRequired > 0 ? Math.round((totalAssigned / totalRequired) * 100) : 0;

    card.innerHTML = `
        <div class="event-header">
            <div style="display: flex; align-items: center; gap: 8px;">
                <div class="event-id">ID: ${event.id}</div>
                <span style="padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; ${event.tag === 'dry hire' ? 'background: #17a2b8; color: white;' : 'background: #28a745; color: white;'}">
                    ${event.tag === 'dry hire' ? 'DRY HIRE' : 'EVENT'}
                </span>
            </div>
            <div class="event-state state-${event.state.toLowerCase()}">${escapeHtml(event.state)}</div>
        </div>
        <div class="event-title">${escapeHtml(event.name)}</div>
        <div class="event-date">${escapeHtml(dateRange)}</div>
        ${modelSummary}
        <div style="margin: 15px 0;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <small style="color: #666;">Preparation Progress</small>
                <small style="color: #666;">${totalAssigned}/${totalRequired} assets</small>
            </div>
            <div style="background: #e9ecef; border-radius: 10px; height: 6px; overflow: hidden;">
                <div style="background: #28a745; height: 100%; width: ${progressPercent}%; transition: width 0.3s ease;"></div>
            </div>
        </div>
        <div class="event-actions">
            <button class="btn btn-success" onclick="openPrepareEventModal(${event.id})">Prepare Assets</button>
            <button class="btn btn-primary" onclick="viewEvent(${event.id})">View Details</button>
        </div>
    `;

  return card;
}

async function openPrepareEventModal(eventId) {
    try {
        const [eventResponse, availableAssetsResponse] = await Promise.all([
            apiCall(`/api/events/${eventId}`),
            apiCall(`/api/assets/available-for-event/${eventId}`)
        ]);
        
        const event = eventResponse.data;
        const availableAssets = availableAssetsResponse.data;
        
        document.getElementById('prepareEventTitle').textContent = `Prepare Assets - Event ${event.id}: ${event.name}`;
        
        let content = `
            <div class="prepare-event-interface">
                <!-- Event Summary -->
                <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
                    <h4 style="margin-bottom: 10px; color: #495057;">Event Summary</h4>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; text-align: center;">
                        <div>
                            <div style="font-size: 20px; font-weight: bold; color: #007bff;">${event.totalAssets}</div>
                            <div style="color: #666; font-size: 12px;">Required</div>
                        </div>
                        <div>
                            <div style="font-size: 20px; font-weight: bold; color: #28a745;">${event.totalPrepared}</div>
                            <div style="color: #666; font-size: 12px;">Prepared</div>
                        </div>
                        <div>
                            <div style="font-size: 20px; font-weight: bold; color: #6c757d;">${event.totalPrepared - event.totalAssets > 0 ? event.totalPrepared - event.totalAssets : 0}</div>
                            <div style="color: #666; font-size: 12px;">Extra</div>
                        </div>
                    </div>
                </div>

                <!-- Quick Asset Search Bar -->
                <div style="margin-bottom: 10px; padding: 10px; background: #e8f5e8; border-radius: 8px; border: 2px solid #28a745;">
                    <h4 style="color: #155724; margin-bottom: 15px;">Prepare or Assign Assets</h4>
                    <div class="form-group">
                        <input type="text" class="form-input" id="universalAssetInput" 
                              placeholder="Enter Asset ID or Serial Number..." 
                              onkeypress="if(event.key==='Enter') processUniversalAsset(${eventId})"
                              style="font-size: 16px; padding: 12px;">
                        <button class="btn btn-success" style="margin-top: 10px; margin-right: 10px;" onclick="processUniversalAsset(${eventId})">Process Asset</button>
                        <button class="btn btn-secondary" style="margin-top: 10px;" onclick="clearUniversalInput()">Clear</button>
                    </div>
                    <div id="universal-asset-feedback" style="margin-top: 15px; min-height: 10px;">
                        <!-- Feedback messages will appear here -->
                    </div>
                </div>

                <!-- Model Requirements -->
                <div style="margin-bottom: 30px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px; background: #f8f9fa; border-radius: 8px 8px 0 0; border-bottom: 1px solid #e9ecef; cursor: pointer;" onclick="togglePrepareSection('model-requirements')">
                        <h4 style="margin: 0; color: #495057;">Model Requirements</h4>
                        <span class="toggle-icon" style="font-size: 18px; font-weight: bold; color: #666;">▼</span>
                    </div>
                    <div id="model-requirements" style="border: 1px solid #e9ecef; border-top: none; border-radius: 0 0 8px 8px;">

                <!-- Custom Assets Preparation Section -->
                <div style="margin-bottom: 20px;">
                    <h4 style="color: #495057; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;">
                        <span>🛠️ Custom Assets</span>
                        <span class="toggle-icon" style="font-size: 14px; cursor: pointer;" onclick="togglePrepareSection('custom-assets')">▼</span>
                    </h4>
                    <div id="custom-assets" style="display: block;">
                        <!-- Quick Add Custom Asset -->
                        <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                            <h5 style="margin-bottom: 10px;">Quick Add Custom Asset</h5>
                            <div style="display: flex; gap: 10px; align-items: center;">
                                <input type="text" id="prepareCustomAssetName" placeholder="Custom asset name" 
                                      style="flex: 1; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px;">
                                <select id="prepareCustomAssetType" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px;">
                                    <option value="MISC">Misc Item</option>
                                    <option value="LOAN">Loan/Rental</option>
                                </select>
                                <button type="button" class="btn btn-success" onclick="addAndPrepareCustomAsset(${event.id})" 
                                        style="padding: 8px 16px; white-space: nowrap;">
                                    Add & Prepare
                                </button>
                            </div>
                        </div>
                        
                        <!-- Existing Custom Assets -->
                        ${generateCustomAssetsSection(event)}
                    </div>
                </div>
        `;
        
        // Process model assignments and show preparation interface
        if (event.modelGroups && Object.keys(event.modelGroups).length > 0) {
            // Group model groups by department
            const modelGroupsByDept = {};
            Object.values(event.modelGroups).forEach(modelGroup => {
                const dept = modelGroup.department;
                if (!modelGroupsByDept[dept]) {
                    modelGroupsByDept[dept] = [];
                }
                modelGroupsByDept[dept].push(modelGroup);
            });

            Object.keys(modelGroupsByDept).forEach(dept => {
                const modelGroups = modelGroupsByDept[dept];
                
                // Count total assets for this department
                let totalRequired = 0;
                let totalAssigned = 0;

                modelGroups.forEach(modelGroup => {
                    totalRequired += modelGroup.requiredQuantity;
                    totalAssigned += modelGroup.assignedAssets.length;
                });

                const progressPercent = totalRequired > 0 ? Math.round((totalAssigned / totalRequired) * 100) : 0;
                const progressColor = totalAssigned >= totalRequired ? '#28a745' : '#ffc107';

                content += `
                    <div class="dept-section" style="margin-bottom: 20px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #f1f3f4; border-radius: 6px; cursor: pointer; margin-bottom: 10px;" onclick="togglePrepareSection('dept-${dept}')">
                            <h5 style="margin: 0; color: #495057; font-size: 14px;">${dept} Department</h5>
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <div style="text-align: right;">
                                    <div style="font-size: 12px; font-weight: 500; color: ${progressColor};">
                                        ${totalAssigned}/${totalRequired} assigned
                                    </div>
                                    <div style="background: #e9ecef; border-radius: 8px; height: 3px; width: 100px; overflow: hidden; margin-top: 2px;">
                                        <div style="background: ${progressColor}; height: 100%; width: ${Math.min(progressPercent, 100)}%; transition: width 0.3s ease;"></div>
                                    </div>
                                </div>
                                <span class="toggle-icon" style="font-size: 14px; font-weight: bold; color: #666;">▼</span>
                            </div>
                        </div>
                        <div id="dept-${dept}" style="display: block; padding: 0 10px;">
                `;
                
                modelGroups.forEach(modelGroup => {
                    // Find available assets of this model
                    const modelAvailableAssets = availableAssets.filter(a => 
                        a.brand === modelGroup.brand && 
                        a.model === modelGroup.model && 
                        a.department === modelGroup.department &&
                        (a.description || '') === (modelGroup.description || '')
                    );
                    
                    // Get assigned assets for this model
                    const assignedAssets = modelGroup.assignedAssets;

                    content += createModelPreparationSection(
                        eventId, modelGroup.brand, modelGroup.model, modelGroup.description, 
                        modelGroup.requiredQuantity, modelAvailableAssets, assignedAssets
                    );
                });
                
                content += '</div></div>';
            });
        }
        
        // Only use assetsByDepartment fallback if modelGroups is empty or doesn't exist
        if ((!event.modelGroups || Object.keys(event.modelGroups).length === 0) && 
            event.assetsByDepartment && Object.keys(event.assetsByDepartment).length > 0) {
            
            Object.keys(event.assetsByDepartment).forEach(dept => {
                const assets = event.assetsByDepartment[dept];
                
                const modelAssets = assets.filter(asset => asset.id && asset.id.startsWith('[MODEL]'));
                
                if (modelAssets.length > 0) {
                    let hasAddedDeptHeader = false;
                    
                    modelAssets.forEach(asset => {
                        try {
                            const parts = asset.id.substring(7).split('|');
                            if (parts.length >= 4) {
                                const brand = parts[1];
                                const model = parts[2];
                                const requiredQty = parseInt(parts[3]) || 1;
                                const description = parts[4] || '';
                                
                                if (!hasAddedDeptHeader) {
                                    content += `
                                        <div style="margin-bottom: 25px;">
                                            <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px; background: #f8f9fa; border-radius: 8px 8px 0 0; border-bottom: 1px solid #e9ecef;">
                                                <h4 style="margin: 0; color: #495057;">${dept} Department</h4>
                                            </div>
                                            <div style="border: 1px solid #e9ecef; border-top: none; border-radius: 0 0 8px 8px;">
                                    `;
                                    hasAddedDeptHeader = true;
                                }

                                const modelAvailableAssets = availableAssets.filter(a => 
                                    a.brand === brand && a.model === model && a.department === dept &&
                                    (a.description || '') === description
                                );

                                const assignedAssets = event.actuallyPrepared ? 
                                  event.actuallyPrepared.filter(assetId => {
                                      const availableAsset = availableAssets.find(a => a.id === assetId);
                                      return availableAsset && availableAsset.brand === brand && availableAsset.model === model && 
                                            (availableAsset.description || '') === description;
                                  }) : [];

                                content += createModelPreparationSection(
                                    eventId, brand, model, description, requiredQty, 
                                    modelAvailableAssets, assignedAssets
                                );
                            }
                        } catch (e) {
                            console.error('Error parsing model assignment:', e);
                        }
                    });
                    
                    if (hasAddedDeptHeader) {
                        content += '</div></div>';
                    }
                }
            });
        }
        
        if (!event.modelGroups || Object.keys(event.modelGroups).length === 0) {
            content += '<p style="text-align: center; color: #666; padding: 40px;">No model assignments found for this event.</p>';
        }
        
        content += `
                    </div>
                </div>
                    <!-- All Assets Assigned to Event -->
                    <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #e9ecef;">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px; background: #f8f9fa; border-radius: 8px 8px 0 0; border-bottom: 1px solid #e9ecef; cursor: pointer;" onclick="togglePrepareSection('all-assigned-assets')">
                        <h4 style="margin: 0; color: #495057;">All Assets Assigned to Event</h4>
                        <span class="toggle-icon" style="font-size: 18px; font-weight: bold; color: #666;">▼</span>
                    </div>
                    <div id="all-assigned-assets" style="border: 1px solid #e9ecef; border-top: none; border-radius: 0 0 8px 8px; max-height: 400px; overflow-y: auto;">
        `;

        // Show all assigned assets with their preparation status
        if (event.assetsByDepartment && Object.keys(event.assetsByDepartment).length > 0) {
            Object.keys(event.assetsByDepartment).forEach(dept => {
                const assets = event.assetsByDepartment[dept];
                
                // Add department header if there are non-model assets
                const nonModelAssets = assets.filter(asset => !asset.id.startsWith('[MODEL]'));
                if (nonModelAssets.length > 0) {
                    content += `
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #f1f3f4; border-bottom: 1px solid #e9ecef; cursor: pointer;" onclick="togglePrepareSection('assigned-dept-${dept}')">
                            <div style="font-weight: 500; font-size: 13px;">${dept} Department (${nonModelAssets.length} assets)</div>
                            <span class="toggle-icon" style="font-size: 14px; font-weight: bold; color: #666;">▼</span>
                        </div>
                        <div id="assigned-dept-${dept}" style="display: block;">
                    `;
                }
                
                assets.forEach(asset => {
                    if (!asset.id.startsWith('[MODEL]')) {
                        const isPrepared = event.actuallyPrepared && event.actuallyPrepared.includes(asset.id);
                        const statusIcon = isPrepared ? '✅' : '⏳';
                        const statusColor = isPrepared ? '#28a745' : '#ffc107';
                        const statusText = isPrepared ? 'Prepared' : 'Pending';
                        const isExtra = event.extraAssets && event.extraAssets.includes(asset.id);
                        console.log(`Asset ${asset.id}: extraAssets=`, event.extraAssets, `isExtra=${isExtra}`);
                        const extraBadge = isExtra ? 
                            '<span style="background: #fff3cd; color: #856404; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 10px;">EXTRA</span>' : '';
                        const safeAssetId = encodeURIComponent(asset.id);
                        const actionButton = isPrepared ? 
                            `<button class="btn btn-warning asset-action-btn" 
                                    data-event-id="${eventId}" 
                                    data-asset-id="${safeAssetId}" 
                                    data-action="unprepare"
                                    style="padding: 4px 8px; font-size: 11px;">Unprepare</button>` :
                            `<button class="btn btn-success asset-action-btn" 
                                    data-event-id="${eventId}" 
                                    data-asset-id="${safeAssetId}" 
                                    data-action="prepare"
                                    style="padding: 4px 8px; font-size: 11px;">Prepare</button>`;

                        let isProcessingClick = false;
                        content += `
                            <div style="padding: 8px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <span style="font-weight: 500;">${statusIcon} ${asset.id}</span>
                                    <span style="color: #666; font-size: 12px; margin-left: 10px;">${asset.name || ''}</span>
                                    ${extraBadge}
                                    <div style="color: ${statusColor}; font-size: 11px; margin-top: 2px;">${statusText}</div>
                                </div>
                                <div>
                                    ${actionButton}
                                </div>
                            </div>
                        `;
                    }
                });
                
                if (nonModelAssets.length > 0) {
                    content += '</div>';
                }
            });
        } else {
            content += '<p style="text-align: center; color: #666; padding: 20px; border: 1px solid #e9ecef; border-radius: 8px; margin-top: 15px;">No individual assets assigned to this event.</p>';
        }

        content += `
                    </div>
                </div>
                
                <!-- Actions -->
                <div style="margin-top: 20px; text-align: right; padding-top: 20px; border-top: 2px solid #e9ecef;">
                    <button class="btn btn-secondary" onclick="closeModal('prepareEventModal')">Close</button>
                    <button class="btn btn-primary" onclick="finishEventPreparation(${eventId})">Finish Preparation</button>
                </div>
            </div>
        `;
        
        document.getElementById('prepareEventContent').innerHTML = content;
        openModal('prepareEventModal');
        
        // Store available assets for the additional asset search
        window.currentAdditionalAssets = availableAssets;
        
    } catch (error) {
        showNotification('error', 'Failed to load event preparation interface');
        console.error('Error loading prepare event modal:', error);
    }
    setupAssetClickHandler();
}
// All Events Tab System
function switchAllEventsTab(tabName) {
  // Remove active class from all tabs
  document.querySelectorAll('.all-events-tab').forEach(tab => {
    tab.classList.remove('active');
  });
  
  // Hide all tab content
  document.querySelectorAll('.all-events-content').forEach(content => {
    content.classList.remove('active');
    content.style.display = 'none';
  });
  
  // Add active class to clicked tab
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
  
  // Show corresponding content
  const contentDiv = document.getElementById(`all-events-${tabName}-view`);
  contentDiv.classList.add('active');
  contentDiv.style.display = 'block';
  
  // Load appropriate data
  if (tabName === "list") {
    loadAllEvents();
  } else if (tabName === "calendar") {
    loadCalendarView();
  }
}

// Calendar functionality
let currentCalendarDate = new Date();

async function loadCalendarView() {
  try {
    const response = await apiCall('/api/events');
    const events = response.data;
    
    renderCalendar(events);
  } catch (error) {
    document.getElementById('calendar-container').innerHTML = 
      '<p style="color: red; text-align: center;">Error loading calendar</p>';
  }
}

function renderCalendar(events) {
  const container = document.getElementById('calendar-container');
  const currentMonth = currentCalendarDate.getMonth();
  const currentYear = currentCalendarDate.getFullYear();
  
  // Calendar header
  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  
  const headerHTML = `
    <div class="calendar-header">
      <h3>${monthNames[currentMonth]} ${currentYear}</h3>
      <div class="calendar-nav">
        <button onclick="navigateCalendar(-1)">‹ Previous</button>
        <button onclick="goToToday()">Today</button>
        <button onclick="navigateCalendar(1)">Next ›</button>
      </div>
    </div>
  `;
  
  // Days of week header
  const daysOfWeek = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const headerRowHTML = daysOfWeek.map(day => 
    `<div class="calendar-day-header">${day}</div>`
  ).join('');
  
  // Calculate calendar grid
  const firstDay = new Date(currentYear, currentMonth, 1);
  const lastDay = new Date(currentYear, currentMonth + 1, 0);
  const firstDayOfWeek = (firstDay.getDay() + 6) % 7;
  const daysInMonth = lastDay.getDate();
  
  // Previous month days
  const prevMonth = new Date(currentYear, currentMonth, 0);
  const daysInPrevMonth = prevMonth.getDate();
  
  // Create calendar grid data structure
  const calendarDays = [];
  
  // Previous month's trailing days
  for (let i = firstDayOfWeek - 1; i >= 0; i--) {
    const dayNum = daysInPrevMonth - i;
    const date = new Date(currentYear, currentMonth - 1, dayNum);
    calendarDays.push({
      date,
      dayNum,
      isCurrentMonth: false,
      isToday: false
    });
  }
  
  // Current month days
  const today = new Date();
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(currentYear, currentMonth, day);
    const isToday = date.toDateString() === today.toDateString();
    
    calendarDays.push({
      date,
      dayNum: day,
      isCurrentMonth: true,
      isToday
    });
  }
  
  // Next month's leading days
  const totalCells = 35; // 5 rows × 7 days (changed from 42)
  const usedCells = calendarDays.length;
  const remainingCells = totalCells - usedCells;

  for (let day = 1; day <= remainingCells; day++) {
    const date = new Date(currentYear, currentMonth + 1, day);
    calendarDays.push({
      date,
      dayNum: day,
      isCurrentMonth: false,
      isToday: false
    });
  }
  
  // Process events for the calendar with proper row assignment
  const eventPlacements = processEventsForCalendar(events, calendarDays);
  
  // Generate calendar HTML
  let calendarDaysHTML = '';
  
  calendarDays.forEach((dayData, dayIndex) => {
    const dayPlacements = eventPlacements.filter(p => p.dayIndex === dayIndex);
    
    // Create event layers HTML (max 4 visible)
    const eventLayersHTML = [];
    for (let row = 0; row < 4; row++) {
      const placement = dayPlacements.find(p => p.row === row);
      if (placement) {
        const eventClass = `calendar-event state-${placement.event.state.toLowerCase()}${placement.event.tag === 'dry hire' ? ' dry-hire' : ''} ${placement.spanClass}`;
        
        // Only show text on the first day of the event span or if it's a single day event
        let eventText = '';
        if (placement.spanClass === 'span-single' || placement.spanClass === 'span-start') {
          eventText = placement.event.name;
        }

        eventLayersHTML.push(`
          <div class="calendar-event-layer" style="top: ${20 + (row * 18)}px; z-index: ${placement.spanClass === 'span-start' ? 10 : 5};">
            <div class="${eventClass}" onclick="editEvent(${placement.event.id})" title="${placement.event.name}" style="z-index: ${placement.spanClass === 'span-start' ? 10 : 5}; position: relative;">
              ${eventText}
            </div>
          </div>
        `);
      }
    }
    
    // Count total events for this day (for "more" indicator)
    const allDayEvents = events.filter(event => {
      const eventStart = new Date(event.startDate);
      const eventEnd = new Date(event.endDate);
      const dayDate = new Date(dayData.date);
      eventStart.setHours(0, 0, 0, 0);
      eventEnd.setHours(23, 59, 59, 999);
      dayDate.setHours(0, 0, 0, 0);
      return dayDate >= eventStart && dayDate <= eventEnd;
    });
    
    const hiddenEventCount = Math.max(0, allDayEvents.length - 4);
    
    // More events indicator
    const moreEventsHTML = hiddenEventCount > 0 ? 
      `<div class="more-events" onclick="showDayEvents(event, ${dayIndex}, '${dayData.date.toDateString()}')">${hiddenEventCount} more</div>` : '';
    
    const dayClass = `calendar-day ${!dayData.isCurrentMonth ? 'other-month' : ''} ${dayData.isToday ? 'today' : ''}`;
    
    calendarDaysHTML += `
      <div class="${dayClass}">
        <div class="calendar-day-number">${dayData.dayNum}</div>
        <div class="calendar-events-container">
          ${eventLayersHTML.join('')}
          ${moreEventsHTML}
        </div>
      </div>
    `;
  });
  
  container.innerHTML = `
    ${headerHTML}
    <div class="calendar-grid">
      ${headerRowHTML}
      ${calendarDaysHTML}
    </div>
  `;
  
  // Store events data for popup
  window.calendarAllEvents = events;
  window.calendarDays = calendarDays;
}

function processEventsForCalendar(events, calendarDays) {
  const eventPlacements = [];
  const rowOccupancy = {}; // Track which rows are occupied on which days
  
  // Initialize row occupancy tracking
  calendarDays.forEach((_, dayIndex) => {
    rowOccupancy[dayIndex] = new Set();
  });
  
  // Sort events by start date, then by duration (longer events first)
  const sortedEvents = [...events].sort((a, b) => {
    const startA = new Date(a.startDate);
    const startB = new Date(b.startDate);
    if (startA.getTime() === startB.getTime()) {
      const durationA = new Date(a.endDate) - new Date(a.startDate);
      const durationB = new Date(b.endDate) - new Date(b.startDate);
      return durationB - durationA; // Longer events first
    }
    return startA - startB;
  });
  
  sortedEvents.forEach(event => {
    const eventStart = new Date(event.startDate);
    const eventEnd = new Date(event.endDate);
    eventStart.setHours(0, 0, 0, 0);
    eventEnd.setHours(23, 59, 59, 999);
    
    // Find all days this event spans
    const spanningDays = [];
    calendarDays.forEach((dayData, dayIndex) => {
      const dayDate = new Date(dayData.date);
      dayDate.setHours(0, 0, 0, 0);
      
      if (dayDate >= eventStart && dayDate <= eventEnd) {
        spanningDays.push({
          dayIndex,
          date: dayDate,
          calendarRow: Math.floor(dayIndex / 7),
          calendarCol: dayIndex % 7
        });
      }
    });
    
    if (spanningDays.length === 0) return;
    
    // Find the first available row that works for ALL spanning days
    let assignedRow = -1;
    for (let row = 0; row < 4; row++) {
      let rowAvailable = true;
      for (let day of spanningDays) {
        if (rowOccupancy[day.dayIndex].has(row)) {
          rowAvailable = false;
          break;
        }
      }
      if (rowAvailable) {
        assignedRow = row;
        break;
      }
    }
    
    // If no row available in visible area, skip this event
    if (assignedRow === -1) return;
    
    // Mark this row as occupied on all spanning days
    spanningDays.forEach(day => {
      rowOccupancy[day.dayIndex].add(assignedRow);
    });
    
    // Group spanning days by calendar row to handle week breaks
    const daysByCalendarRow = {};
    spanningDays.forEach(day => {
      if (!daysByCalendarRow[day.calendarRow]) {
        daysByCalendarRow[day.calendarRow] = [];
      }
      daysByCalendarRow[day.calendarRow].push(day);
    });
    
    // Create placements for each calendar row
    Object.values(daysByCalendarRow).forEach(rowDays => {
      rowDays.sort((a, b) => a.calendarCol - b.calendarCol);
      
      // Group consecutive days
      const consecutiveGroups = [];
      let currentGroup = [rowDays[0]];
      
      for (let i = 1; i < rowDays.length; i++) {
        if (rowDays[i].calendarCol === rowDays[i-1].calendarCol + 1) {
          currentGroup.push(rowDays[i]);
        } else {
          consecutiveGroups.push(currentGroup);
          currentGroup = [rowDays[i]];
        }
      }
      consecutiveGroups.push(currentGroup);
      
      // Create placements for each consecutive group
      consecutiveGroups.forEach(group => {
        group.forEach((day, dayIndexInGroup) => {
          let spanClass = 'span-single';
          
          if (group.length > 1) {
            if (dayIndexInGroup === 0) {
              spanClass = 'span-start';
            } else if (dayIndexInGroup === group.length - 1) {
              spanClass = 'span-end';
            } else {
              spanClass = 'span-middle';
            }
          }
          
          eventPlacements.push({
            event,
            dayIndex: day.dayIndex,
            row: assignedRow,
            spanClass
          });
        });
      });
    });
  });
  
  return eventPlacements;
}

function showDayEvents(event, dayIndex, dateString) {
  event.stopPropagation();
  
  // Remove any existing popup
  const existingPopup = document.querySelector('.day-events-popup');
  if (existingPopup) {
    existingPopup.remove();
  }
  
  // Get all events for this day
  const dayDate = window.calendarDays[dayIndex].date;
  const dayEvents = window.calendarAllEvents.filter(event => {
    const eventStart = new Date(event.startDate);
    const eventEnd = new Date(event.endDate);
    const checkDate = new Date(dayDate);
    eventStart.setHours(0, 0, 0, 0);
    eventEnd.setHours(23, 59, 59, 999);
    checkDate.setHours(0, 0, 0, 0);
    return checkDate >= eventStart && checkDate <= eventEnd;
  });
  
  // Create popup
  const popup = document.createElement('div');
  popup.className = 'day-events-popup';
  
  const eventsHTML = dayEvents.map(event => {
    const eventClass = `day-event-item state-${event.state.toLowerCase()}${event.tag === 'dry hire' ? ' dry-hire' : ''}`;
    return `<div class="${eventClass}" onclick="viewEvent(${event.id}); closeDayEventsPopup();" title="${event.name}">${event.name}</div>`;
  }).join('');
  
  popup.innerHTML = `
    <div class="day-events-header">
      <span>${dateString}</span>
      <button class="day-events-close" onclick="closeDayEventsPopup()">×</button>
    </div>
    ${eventsHTML}
  `;
  
  // Position popup near the click
  const rect = event.target.getBoundingClientRect();
  popup.style.left = `${rect.left}px`;
  popup.style.top = `${rect.bottom + 5}px`;
  
  // Adjust if popup goes off screen
  document.body.appendChild(popup);
  const popupRect = popup.getBoundingClientRect();
  if (popupRect.right > window.innerWidth) {
    popup.style.left = `${window.innerWidth - popupRect.width - 10}px`;
  }
  if (popupRect.bottom > window.innerHeight) {
    popup.style.top = `${rect.top - popupRect.height - 5}px`;
  }
  
  // Close popup when clicking outside
  setTimeout(() => {
    document.addEventListener('click', closeDayEventsPopup);
  }, 100);
}

function closeDayEventsPopup() {
  const popup = document.querySelector('.day-events-popup');
  if (popup) {
    popup.remove();
  }
  document.removeEventListener('click', closeDayEventsPopup);
}

function navigateCalendar(direction) {
  currentCalendarDate.setMonth(currentCalendarDate.getMonth() + direction);
  loadCalendarView();
}

function goToToday() {
  currentCalendarDate = new Date();
  loadCalendarView();
}

function handleAssetActionClick(event) {
    if (event.target.classList.contains('asset-action-btn')) {
        event.preventDefault();
        
        const eventId = event.target.dataset.eventId;
        const assetId = event.target.dataset.assetId.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const action = event.target.dataset.action;
        
        if (action === 'prepare') {
            prepareSpecificAsset(eventId, assetId);
        } else if (action === 'unprepare') {
            unprepareSpecificAsset(eventId, assetId);
        }
    }
}

function generateCustomAssetsSection(event) {
    let content = '';
    
    if (event.assetsByDepartment) {
        ['LOAN', 'MISC'].forEach(dept => {
            if (event.assetsByDepartment[dept] && event.assetsByDepartment[dept].length > 0) {
                const customAssets = event.assetsByDepartment[dept];
                const deptDisplayName = dept === 'LOAN' ? '🏪 Loan/Rental Items' : '🔧 Misc Items';
                
                content += `
                    <div style="border: 1px solid #e9ecef; border-radius: 8px; margin-bottom: 10px;">
                        <div style="background: #f8f9fa; padding: 10px; font-weight: bold; border-radius: 8px 8px 0 0;">
                            ${deptDisplayName} (${customAssets.length})
                        </div>
                        <div style="padding: 10px;">
                `;
                
                customAssets.forEach(asset => {
                    // Use the same logic as regular assets - check actuallyPrepared array
                    const isPrepared = event.actuallyPrepared && event.actuallyPrepared.includes(asset.id);
                    const isReturned = event.returnedItems && event.returnedItems.includes(asset.id);
                    
                    let statusIcon, statusText;
                    if (isReturned) {
                        statusIcon = "↩️";
                        statusText = "Returned";
                    } else if (isPrepared) {
                        statusIcon = "✅";
                        statusText = "Prepared";
                    } else {
                        statusIcon = "📋";
                        statusText = "Pending";
                    }
                    
                    const safeAssetId = encodeURIComponent(asset.id);
                    
                    // Generate action button based on actual status
                    let actionButton;
                    if (isReturned) {
                        actionButton = '<span style="color: #dc3545; font-size: 11px;">Returned</span>';
                    } else if (isPrepared) {
                        actionButton = `<button class="btn btn-warning btn-sm asset-action-btn" 
                                               data-event-id="${event.id}" 
                                               data-asset-id="${safeAssetId}" 
                                               data-action="unprepare"
                                               style="margin-right: 5px;">Unprepare</button>`;
                    } else {
                        actionButton = `<button class="btn btn-success btn-sm asset-action-btn" 
                                               data-event-id="${event.id}" 
                                               data-asset-id="${safeAssetId}" 
                                               data-action="prepare"
                                               style="margin-right: 5px;">Prepare</button>`;
                    }
                    
                    content += `
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; margin-bottom: 5px; border: 1px solid #e9ecef; border-radius: 4px;">
                            <span>${statusIcon} ${escapeHtml(asset.name)}</span>
                            <div>
                                ${actionButton}
                            </div>
                        </div>
                    `;
                });
                
                content += `
                        </div>
                    </div>
                `;
            }
        });
    }
    
    if (!content) {
        content = '<div style="text-align: center; color: #666; padding: 20px;">No custom assets assigned to this event.</div>';
    }
    
    return content;
}

function handleCustomAssetClick(event) {
    if (event.target.classList.contains('custom-asset-btn')) {
        event.preventDefault();
        
        const eventId = event.target.dataset.eventId;
        const assetId = event.target.dataset.assetId.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const action = event.target.dataset.action;
        
        if (action === 'prepare') {
            prepareSpecificAsset(eventId, assetId);
        } else if (action === 'unprepare') {
            unprepareSpecificAsset(eventId, assetId);
        }
    }
}

function generateActionButton(eventId, asset, isPrepared) {
    const safeAssetId = encodeURIComponent(asset.id);
    
    if (isPrepared) {
        return `<button class="btn btn-warning asset-action-btn" 
                        data-event-id="${eventId}" 
                        data-asset-id="${safeAssetId}" 
                        data-action="unprepare"
                        style="padding: 4px 8px; font-size: 11px; margin-right: 5px;">Unprepare</button>`;
    } else {
        return `<button class="btn btn-success asset-action-btn" 
                        data-event-id="${eventId}" 
                        data-asset-id="${safeAssetId}" 
                        data-action="prepare"
                        style="padding: 4px 8px; font-size: 11px; margin-right: 5px;">Prepare</button>`;
    }
}

// Add function to handle adding custom assets in prepare modal
async function addAndPrepareCustomAsset(eventId) {
    const nameInput = document.getElementById("prepareCustomAssetName");
    const typeSelect = document.getElementById("prepareCustomAssetType");
    
    const name = nameInput.value.trim();
    const type = typeSelect.value;
    
    if (!name) {
        showNotification("error", "Please enter a custom asset name");
        return;
    }
    
    // Validate asset name - check for problematic characters
    if (name.includes('"') || name.includes("'") || name.includes(';') || name.includes('`')) {
        showNotification("error", "Asset name cannot contain quotes, semicolons, or backticks");
        return;
    }
    
    try {
        // Create single custom asset (quantity 1 for quick add)
        await apiCall(`/api/events/${eventId}/custom-assets`, "POST", {
            name: name,
            quantity: 1,
            type: type
        });
        
        showNotification("success", `Custom asset "${name}" added and prepared`);
        
        // Clear inputs
        nameInput.value = "";
        
        // Refresh the modal
        setTimeout(() => {
            openPrepareEventModal(eventId);
        }, 500);
        
    } catch (error) {
        showNotification("error", `Failed to add custom asset: ${error.message}`);
    }
}

function togglePrepareSection(sectionId) {
    const section = document.getElementById(sectionId);
    const toggleIcon = event.target.closest('[onclick]').querySelector('.toggle-icon');
    
    if (section && toggleIcon) {
        if (section.style.display === 'none') {
            section.style.display = 'block';
            toggleIcon.textContent = '▼';
        } else {
            section.style.display = 'none';
            toggleIcon.textContent = '▶';
        }
    }
}

function searchAdditionalAssets(eventId) {
    const searchInput = document.getElementById('additionalAssetSearch');
    const resultsContainer = document.getElementById('additional-assets-results');
    const searchTerm = searchInput.value.toLowerCase().trim();
    
    if (!searchTerm || searchTerm.length < 2) {
        resultsContainer.innerHTML = '<p style="text-align: center; color: #666; padding: 20px;">Type at least 2 characters to search...</p>';
        return;
    }
    
    const availableAssets = window.currentAdditionalAssets || [];
    const filteredAssets = availableAssets.filter(asset => 
        asset.id.toLowerCase().includes(searchTerm) ||
        asset.brand.toLowerCase().includes(searchTerm) ||
        asset.model.toLowerCase().includes(searchTerm) ||
        (asset.description && asset.description.toLowerCase().includes(searchTerm))
    );
    
    if (filteredAssets.length === 0) {
        resultsContainer.innerHTML = '<p style="text-align: center; color: #666; padding: 20px;">No matching assets found.</p>';
        return;
    }
    
    let content = '';
    filteredAssets.slice(0, 20).forEach(asset => { // Limit to 20 results
        content += `
            <div style="padding: 10px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <div style="font-weight: 500;">${asset.id}</div>
                    <div style="color: #666; font-size: 12px;">${asset.brand} ${asset.model}</div>
                    <div style="color: #999; font-size: 11px;">${escapeJs(asset.description || '')}</div>
                    <span class="asset-badge dept-${asset.department.toLowerCase()}">${asset.department}</span>
                </div>
                <button class="btn btn-warning" style="padding: 4px 8px; font-size: 11px; background: #ff8c00;" onclick="assignAdditionalAsset(${eventId}, '${asset.id}')">Assign as Extra</button>
            </div>
        `;
    });
    
    resultsContainer.innerHTML = content;
}

/**
 * ASSIGN additional asset from search results
 * Used by: "Assign as Extra" buttons in additional asset search
 * Maintains exact same function signature as before
 */
async function assignAdditionalAsset(eventId, assetId) {
    console.log(`=== assignAdditionalAsset CALLED ===`);
    console.log('eventId:', eventId, 'assetId:', assetId);
    
    try {
        await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId });
        showNotification('success', `Assigned ${assetId} as additional asset`);
        
        // Remove from search results
        const assetElement = document.querySelector(`[onclick*="assignAdditionalAsset(${eventId}, '${assetId}')"]`).closest('div');
        if (assetElement) {
            assetElement.remove();
        }
        
        // Update available assets cache
        if (window.currentAdditionalAssets) {
            window.currentAdditionalAssets = window.currentAdditionalAssets.filter(a => a.id !== assetId);
        }
        
        console.log('About to refresh modal with state preservation...');
        // Refresh modal while preserving UI state
        setTimeout(() => {
            preserveModalState(() => {
                openPrepareEventModal(eventId);
            });
        }, 200);
        
    } catch (error) {
        console.error('Error in assignAdditionalAsset:', error);
        showNotification('error', `Failed to assign asset: ${error.message}`);
    }
}

/**
 * PREPARE asset from manual input field
 * Used by: Input field with "Prepare Asset" button
 * Maintains exact same function signature as before
 */
async function prepareAssignedAsset(eventId) {
    const input = document.getElementById('assignedAssetPrepare');
    const assetId = input.value.trim();
    
    if (!assetId) {
        showNotification('warning', 'Please enter an asset ID');
        return;
    }
    
    console.log(`=== prepareAssignedAsset CALLED ===`);
    console.log('eventId:', eventId, 'assetId:', assetId);
    
    try {
        await apiCall(`/api/events/${eventId}/prepare`, 'POST', { assetId });
        showNotification('success', `${assetId} marked as prepared`);
        
        // Clear input
        input.value = '';
        
        console.log('About to refresh modal with state preservation...');
        // Refresh modal while preserving UI state
        setTimeout(() => {
            preserveModalState(() => {
                openPrepareEventModal(eventId);
            });
        }, 200);
        
    } catch (error) {
        console.error('Error in prepareAssignedAsset:', error);
        showNotification('error', `Failed to prepare asset: ${error.message}`);
    }
}

async function prepareSpecificAsset(eventId, assetId) {
    console.log(`=== SINGLE prepareSpecificAsset CALLED ===`);
    console.log('eventId:', eventId, 'assetId:', assetId);
    
    try {
        await apiCall(`/api/events/${eventId}/prepare`, 'POST', { assetId });
        showNotification('success', `${assetId} marked as prepared`);
        updateAllButtonsForAsset(assetId, true);
        
    } catch (error) {
        console.error('Error in prepareSpecificAsset:', error);
        showNotification('error', `Failed to prepare asset: ${error.message}`);
        updateAllButtonsForAsset(assetId, false);
    }
}

function updateAllButtonsForAsset(assetId, isPrepared) {
    const encodedAssetId = encodeURIComponent(assetId);
    const buttons = document.querySelectorAll(`[data-asset-id="${encodedAssetId}"]`);
    
    console.log(`Updating ${buttons.length} buttons for asset ${assetId}, isPrepared: ${isPrepared}`);
    
    buttons.forEach(button => {
        // Re-enable the button and restore opacity
        button.disabled = false;
        button.style.opacity = '1';
        
        // Update button appearance and action
        if (isPrepared) {
            button.textContent = 'Unprepare';
            button.className = button.className.replace('btn-success', 'btn-warning');
            button.dataset.action = 'unprepare';
        } else {
            button.textContent = 'Prepare';
            button.className = button.className.replace('btn-warning', 'btn-success');
            button.dataset.action = 'prepare';
        }
        
        // Update status icons and text in the same row
        const assetRow = button.closest('div[style*="display: flex"]');
        if (assetRow) {
            // Update status icon in the asset name
            const assetNameSpan = assetRow.querySelector('span');
            if (assetNameSpan && assetNameSpan.textContent.includes(assetId)) {
                const icon = isPrepared ? '✅' : '📋';
                // Replace any existing icon at the start
                assetNameSpan.innerHTML = assetNameSpan.innerHTML.replace(/^[✅📋↩️]\s/, `${icon} `);
            }
            
            // Update status text if it exists
            const statusText = assetRow.querySelector('div[style*="margin-top: 2px"]');
            if (statusText) {
                statusText.textContent = isPrepared ? 'Prepared' : 'Pending';
                statusText.style.color = isPrepared ? '#28a745' : '#ffc107';
            }
        }
    });
}

async function unprepareSpecificAsset(eventId, assetId) {
    console.log(`=== SINGLE unprepareSpecificAsset CALLED ===`);
    console.log('eventId:', eventId, 'assetId:', assetId);
    
    try {
        await apiCall(`/api/events/${eventId}/unprepare`, 'POST', { assetId });
        showNotification('success', `${assetId} unprepared`);
        updateAllButtonsForAsset(assetId, false);
        
    } catch (error) {
        console.error('Error in unprepareSpecificAsset:', error);
        showNotification('error', `Failed to unprepare asset: ${error.message}`);
        updateAllButtonsForAsset(assetId, true);
    }
}

async function updateAssetStatusInModal(eventId, assetId, action) {
    try {
        if (action === 'unprepared') {
            // Asset was completely removed, so remove it from both sections
            removeAssetFromModal(assetId);
            
            // Get fresh event data AFTER the removal to update counters
            await new Promise(resolve => setTimeout(resolve, 100)); // Small delay to ensure backend is updated
            const response = await apiCall(`/api/events/${eventId}`);
            const event = response.data;
            
            // Update the event summary counts
            updateEventSummaryInModal(event);
            
            // Update model progress bars
            updateModelProgressBars(event);
            
            // Update department progress bars
            updateDepartmentProgressBars(event);
            
        } else {
            // Get fresh event data for other actions
            const response = await apiCall(`/api/events/${eventId}`);
            const event = response.data;
            
            if (action === 'prepared') {
                // Update the asset's status in the "All Assets" section
                await updateAssetInAllAssetsSection(eventId, assetId, true);
                
                // Move asset from available to assigned in model sections AND check for extra status
                await moveAssetInModelSectionWithExtraCheck(eventId, assetId, event);
            } else if (action === 'assigned') {
                // Asset was assigned and prepared, move from available to assigned
                moveAssetFromAvailableToAssigned(eventId, assetId);
                
                // Add to "All Assets Assigned" section
                addAssetToAllAssetsSection(eventId, assetId, event);
            }
            
            // Update the event summary counts
            updateEventSummaryInModal(event);
            
            // Update model progress bars
            updateModelProgressBars(event);
            
            // Update department progress bars
            updateDepartmentProgressBars(event);
        }
        
    } catch (error) {
        console.error('Error updating asset status:', error);
        showNotification('error', 'Failed to update interface. Please try again.');
    }
}

function updateButtonState(eventId, assetId, isPrepared) {
    const encodedAssetId = encodeURIComponent(assetId);
    const buttons = document.querySelectorAll(`[data-asset-id="${encodedAssetId}"]`);
    
    buttons.forEach(button => {
        // Re-enable the button
        button.disabled = false;
        
        // Update button appearance and action
        if (isPrepared) {
            button.textContent = 'Unprepare';
            button.className = 'btn btn-warning asset-action-btn';
            button.dataset.action = 'unprepare';
            button.style.cssText = 'padding: 4px 8px; font-size: 11px; margin-right: 5px;';
        } else {
            button.textContent = 'Prepare';
            button.className = 'btn btn-success asset-action-btn';
            button.dataset.action = 'prepare';
            button.style.cssText = 'padding: 4px 8px; font-size: 11px; margin-right: 5px;';
        }
        
        // Update status icons and text in the same row
        const assetRow = button.closest('div[style*="display: flex"]');
        if (assetRow) {
            // Update status icon
            const statusSpan = assetRow.querySelector('span');
            if (statusSpan && statusSpan.textContent.includes(assetId)) {
                const icon = isPrepared ? '✅' : '📋';
                statusSpan.innerHTML = statusSpan.innerHTML.replace(/^[✅📋]\s/, `${icon} `);
            }
            
            // Update status text
            const statusText = assetRow.querySelector('div[style*="margin-top: 2px"]');
            if (statusText) {
                statusText.textContent = isPrepared ? 'Prepared' : 'Pending';
                statusText.style.color = isPrepared ? '#28a745' : '#ffc107';
            }
        }
    });
}

function moveAssetFromAvailableToAssigned(eventId, assetId) {
    // Find the asset in the available section
    const availableButtons = document.querySelectorAll(`[onclick*="assignSpecificAsset"][onclick*="'${assetId}'"]`);
    
    availableButtons.forEach(button => {
        const assetDiv = button.closest('div[style*="display: flex"]');
        if (assetDiv) {
            // Get asset details from the existing div
            const assetIdElement = assetDiv.querySelector('[style*="font-weight: 500"]');
            const serialElement = assetDiv.querySelector('[style*="color: #666"]');
            
            if (assetIdElement && serialElement) {
                const assetIdText = assetIdElement.textContent;
                const serialText = serialElement.textContent;
                
                // Find the model section this asset belongs to
                const modelSection = assetDiv.closest('.model-prep-section');
                if (modelSection) {
                    // Remove from available section
                    assetDiv.remove();
                    
                    // Find or create the assigned section
                    let assignedSection = modelSection.querySelector('[style*="background: #d4edda"][style*="border-radius: 6px"]');
                    if (!assignedSection) {
                        // Create assigned section if it doesn't exist
                        const assignedContainer = modelSection.querySelector('div[id*="model-"] > div:last-child');
                        if (assignedContainer) {
                            assignedContainer.innerHTML = `
                                <div>
                                    <h6 style="color: #495057; margin-bottom: 10px; font-size: 13px;">Assigned Assets (1)</h6>
                                    <div style="background: #d4edda; border-radius: 6px; padding: 12px;"></div>
                                </div>
                            `;
                            assignedSection = assignedContainer.querySelector('[style*="background: #d4edda"]');
                        }
                    }
                    
                    if (assignedSection) {
                        // Create new assigned asset element
                        const newAssetHTML = `
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding: 10px 12px; background: #d4edda; border-radius: 4px; border: 1px solid #c3e6cb;">
                                <div>
                                    <span style="color: #155724; font-weight: 500; font-size: 15px;">
                                        ✅ ${assetIdText}
                                    </span>
                                    <div style="color: #155724; font-size: 13px; margin-top: 3px;">${serialText} • Required</div>
                                </div>
                                <button class="btn btn-warning" style="padding: 6px 12px; font-size: 12px;" onclick="unprepareSpecificAsset(${eventId}, '${assetId}')">Unprepare</button>
                            </div>
                        `;
                        
                        assignedSection.insertAdjacentHTML('beforeend', newAssetHTML);
                    }
                    
                    // Update counts
                    updateModelSectionCounts(modelSection, 'add');
                }
            }
        }
    });
}

async function addAssetToAllAssetsSection(eventId, assetId, event) {
    // Get fresh event data to find the asset details
    try {
        const response = await apiCall(`/api/events/${eventId}`);
        const freshEvent = response.data;
        
        // Find the asset details from the fresh event data
        let assetDetails = null;
        let department = null;
        let isExtra = false;
        
        // First check if it's in the fresh event's extraAssets array
        isExtra = freshEvent.extraAssets && freshEvent.extraAssets.includes(assetId);
        
        if (freshEvent.assetsByDepartment) {
            Object.keys(freshEvent.assetsByDepartment).forEach(dept => {
                const deptAssets = freshEvent.assetsByDepartment[dept];
                const found = deptAssets.find(asset => asset.id === assetId);
                if (found) {
                    assetDetails = found;
                    department = dept;
                    // Use the extraAssets array check, not the asset.isExtra property
                }
            });
        }
        
        // If not found in assetsByDepartment, try to get from available assets
        if (!assetDetails) {
            const availableResponse = await apiCall('/api/assets/available');
            const availableAssets = availableResponse.data;
            const availableAsset = availableAssets.find(a => a.id === assetId);
            
            if (availableAsset) {
                assetDetails = availableAsset;
                department = availableAsset.department;
                // isExtra is already set from extraAssets array above
            }
        }
        
        // Fallback: if still no department found, default to 'Unknown'
        if (!department) {
            department = 'Unknown';
        }
        
        if (assetDetails) {
            // Find the appropriate department section in "All Assets Assigned"
            const allAssetsContainer = document.getElementById('all-assigned-assets');
            if (!allAssetsContainer) return;
            
            // Look for existing department header and its content section
            let targetDeptSection = null;
            const deptHeaderDivs = allAssetsContainer.querySelectorAll('[onclick*="togglePrepareSection"]');

            deptHeaderDivs.forEach(headerDiv => {
                const deptText = headerDiv.querySelector('div[style*="font-weight: 500"]');
                if (deptText && deptText.textContent.includes(`${department} Department`)) {
                    // Get the ID from the onclick attribute to find the content section
                    const onclickAttr = headerDiv.getAttribute('onclick');
                    const match = onclickAttr.match(/togglePrepareSection\('([^']+)'\)/);
                    if (match) {
                        const sectionId = match[1];
                        targetDeptSection = document.getElementById(sectionId);
                    }
                }
            });
            
            // If no department section exists, create it
            if (!targetDeptSection) {
                const deptId = `assigned-dept-${department}`;
                const newDeptHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #f1f3f4; border-bottom: 1px solid #e9ecef; cursor: pointer;" onclick="togglePrepareSection('${deptId}')">
                        <div style="font-weight: 500; font-size: 13px;">${department} Department (1 assets)</div>
                        <span class="toggle-icon" style="font-size: 14px; font-weight: bold; color: #666;">▼</span>
                    </div>
                    <div id="${deptId}" style="display: block;">
                    </div>
                `;
                
                allAssetsContainer.insertAdjacentHTML('beforeend', newDeptHTML);
                targetDeptSection = document.getElementById(deptId);
            } else {
                // Update the count in existing header
                const deptHeader = targetDeptSection.previousElementSibling;
                if (deptHeader) {
                    const headerDiv = deptHeader.querySelector('div[style*="font-weight: 500"]');
                    if (headerDiv) {
                        const match = headerDiv.textContent.match(/(\d+) assets/);
                        if (match) {
                            const currentCount = parseInt(match[1]);
                            headerDiv.textContent = `${department} Department (${currentCount + 1} assets)`;
                        }
                    }
                }
            }
            
            if (targetDeptSection) {
                // Use the extraAssets array check for the badge
                const extraBadge = isExtra ? 
                    '<span style="background: #fff3cd; color: #856404; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 10px;">EXTRA</span>' : '';
                
                const newAssetHTML = `
                    <div style="padding: 8px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <span style="font-weight: 500;">✅ ${assetId}</span>
                            <span style="color: #666; font-size: 12px; margin-left: 10px;">${escapeJs(assetDetails.name || assetDetails.description || '')}</span>
                            ${extraBadge}
                            <div style="color: #28a745; font-size: 11px; margin-top: 2px;">Prepared</div>
                        </div>
                        <div>
                            <button class="btn btn-warning" style="padding: 4px 8px; font-size: 11px;" onclick="unprepareSpecificAsset(${eventId}, '${escapeJs(assetId)}')">Unprepare</button>
                        </div>
                    </div>
                `;
                
                // Find the correct position to insert the asset (sorted by asset ID)
                const existingAssets = targetDeptSection.querySelectorAll('div[style*="padding: 8px 12px"]');
                let insertPosition = null;
                
                for (let i = 0; i < existingAssets.length; i++) {
                    const existingAssetSpan = existingAssets[i].querySelector('span[style*="font-weight: 500"]');
                    if (existingAssetSpan) {
                        const existingAssetId = existingAssetSpan.textContent.replace(/^[✅⏳]\s/, '').trim();
                        
                        // Compare asset IDs to find correct insertion point
                        if (assetId.localeCompare(existingAssetId, undefined, { numeric: true, sensitivity: 'base' }) < 0) {
                            insertPosition = existingAssets[i];
                            break;
                        }
                    }
                }
                
                // Insert in the correct position
                if (insertPosition) {
                    insertPosition.insertAdjacentHTML('beforebegin', newAssetHTML);
                } else {
                    // Insert at the end if no position found (asset ID is largest)
                    targetDeptSection.insertAdjacentHTML('beforeend', newAssetHTML);
                }
            }
        }
    } catch (error) {
        console.error('Error adding asset to all assets section:', error);
    }
}

async function updateAssetInAllAssetsSection(eventId, assetId, isPrepared) {
    // Get fresh event data to check if asset is extra
    try {
        const response = await apiCall(`/api/events/${eventId}`);
        const freshEvent = response.data;
        
        // Check if asset is in extraAssets array
        const isExtra = freshEvent.extraAssets && freshEvent.extraAssets.includes(assetId);
        
        // Find the asset in the "All Assets" section and update its status
        const allAssetsElements = document.querySelectorAll(`[onclick*="'${assetId}'"]`);
        allAssetsElements.forEach(element => {
            const assetDiv = element.closest('div[style*="padding: 8px 12px"]');
            if (assetDiv && assetDiv.textContent.includes(assetId)) {
                // Update the status icon and text
                const statusSpan = assetDiv.querySelector('span[style*="font-weight: 500"]');
                if (statusSpan) {
                    const icon = isPrepared ? '✅' : '⏳';
                    statusSpan.innerHTML = statusSpan.innerHTML.replace(/^[✅⏳]\s/, `${icon} `);
                }
                
                // Update the status text
                const statusText = assetDiv.querySelector('div[style*="margin-top: 2px"]');
                if (statusText) {
                    statusText.textContent = isPrepared ? 'Prepared' : 'Pending';
                    statusText.style.color = isPrepared ? '#28a745' : '#ffc107';
                }
                
                // Update or add the EXTRA badge
                const assetContainer = assetDiv.querySelector('div:first-child');
                if (assetContainer) {
                    // Remove existing EXTRA badge if it exists
                    const existingBadge = assetContainer.querySelector('span[style*="background: #fff3cd"]');
                    if (existingBadge) {
                        existingBadge.remove();
                    }
                    
                    // Add EXTRA badge if asset is extra
                    if (isExtra) {
                        const assetNameSpan = assetContainer.querySelector('span[style*="color: #666"]');
                        if (assetNameSpan) {
                            const extraBadge = document.createElement('span');
                            extraBadge.style.cssText = 'background: #fff3cd; color: #856404; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 10px;';
                            extraBadge.textContent = 'EXTRA';
                            assetNameSpan.insertAdjacentElement('afterend', extraBadge);
                        }
                    }
                }
                
                // Update the button
                const button = assetDiv.querySelector('button');
                if (button) {
                    if (isPrepared) {
                        button.textContent = 'Unprepare';
                        button.className = 'btn btn-warning';
                        button.style.cssText = 'padding: 4px 8px; font-size: 11px;';
                        button.onclick = () => unprepareSpecificAsset(eventId, assetId);
                    } else {
                        button.textContent = 'Prepare';
                        button.className = 'btn btn-success';
                        button.style.cssText = 'padding: 4px 8px; font-size: 11px;';
                        button.onclick = () => prepareSpecificAsset(eventId, assetId);
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error updating asset status:', error);
        // Fallback to original logic if API call fails
        const allAssetsElements = document.querySelectorAll(`[onclick*="'${assetId}'"]`);
        allAssetsElements.forEach(element => {
            const assetDiv = element.closest('div[style*="padding: 8px 12px"]');
            if (assetDiv && assetDiv.textContent.includes(assetId)) {
                // Update the status icon and text
                const statusSpan = assetDiv.querySelector('span[style*="font-weight: 500"]');
                if (statusSpan) {
                    const icon = isPrepared ? '✅' : '⏳';
                    statusSpan.innerHTML = statusSpan.innerHTML.replace(/^[✅⏳]\s/, `${icon} `);
                }
                
                // Update the status text
                const statusText = assetDiv.querySelector('div[style*="margin-top: 2px"]');
                if (statusText) {
                    statusText.textContent = isPrepared ? 'Prepared' : 'Pending';
                    statusText.style.color = isPrepared ? '#28a745' : '#ffc107';
                }
                
                // Update the button
                const button = assetDiv.querySelector('button');
                if (button) {
                    if (isPrepared) {
                        button.textContent = 'Unprepare';
                        button.className = 'btn btn-warning';
                        button.style.cssText = 'padding: 4px 8px; font-size: 11px;';
                        button.onclick = () => unprepareSpecificAsset(eventId, assetId);
                    } else {
                        button.textContent = 'Prepare';
                        button.className = 'btn btn-success';
                        button.style.cssText = 'padding: 4px 8px; font-size: 11px;';
                        button.onclick = () => prepareSpecificAsset(eventId, assetId);
                    }
                }
            }
        });
    }
}

function removeAssetFromModal(assetId) {
    // Remove from "All Assets Assigned" section
    const allAssetsSection = document.getElementById('all-assigned-assets');
    if (allAssetsSection) {
        const assetElements = allAssetsSection.querySelectorAll('div[style*="padding: 8px 12px"]');
        assetElements.forEach(element => {
            const assetSpan = element.querySelector('span[style*="font-weight: 500"]');
            if (assetSpan && assetSpan.textContent.includes(assetId)) {
                element.remove();
            }
        });
    }
    
    // Remove from model sections (assigned section)
    const modelSections = document.querySelectorAll('.model-prep-section');
    modelSections.forEach(modelSection => {
        const assignedContainer = modelSection.querySelector('[style*="background: #d4edda"]');
        if (assignedContainer) {
            const assignedAssets = assignedContainer.querySelectorAll('div[style*="display: flex"]');
            assignedAssets.forEach(assetDiv => {
                const assetSpan = assetDiv.querySelector('span[style*="font-weight: 500"]');
                if (assetSpan && assetSpan.textContent.includes(assetId)) {
                    // Get asset details before removing
                    const assetIdText = assetId;
                    const serialMatch = assetDiv.textContent.match(/SN: ([^•]+)/);
                    const serialText = serialMatch ? serialMatch[1].trim() : 'N/A';
                    
                    // Remove from assigned section
                    assetDiv.remove();
                    
                    // Add back to available section
                    addAssetBackToAvailable(modelSection, assetIdText, serialText);
                    
                    // Update counts
                    updateModelSectionCounts(modelSection, 'remove');
                }
            });
        }
    });
}

function updateAssetInAllAssetsSection(eventId, assetId, isPrepared) {
    // Find the asset in the "All Assets" section and update its status
    const allAssetsElements = document.querySelectorAll(`[onclick*="'${assetId}'"]`);
    allAssetsElements.forEach(element => {
        const assetDiv = element.closest('div[style*="padding: 8px 12px"]');
        if (assetDiv && assetDiv.textContent.includes(assetId)) {
            // Update the status icon and text
            const statusSpan = assetDiv.querySelector('span[style*="font-weight: 500"]');
            if (statusSpan) {
                const icon = isPrepared ? '✅' : '⏳';
                statusSpan.innerHTML = statusSpan.innerHTML.replace(/^[✅⏳]\s/, `${icon} `);
            }
            
            // Update the status text
            const statusText = assetDiv.querySelector('div[style*="margin-top: 2px"]');
            if (statusText) {
                statusText.textContent = isPrepared ? 'Prepared' : 'Pending';
                statusText.style.color = isPrepared ? '#28a745' : '#ffc107';
            }
            
            // Update the button
            const button = assetDiv.querySelector('button');
            if (button) {
                if (isPrepared) {
                    button.textContent = 'Unprepare';
                    button.className = 'btn btn-warning';
                    button.style.cssText = 'padding: 4px 8px; font-size: 11px;';
                    button.onclick = () => unprepareSpecificAsset(eventId, assetId);
                } else {
                    button.textContent = 'Prepare';
                    button.className = 'btn btn-success';
                    button.style.cssText = 'padding: 4px 8px; font-size: 11px;';
                    button.onclick = () => prepareSpecificAsset(eventId, assetId);
                }
            }
        }
    });
}

async function moveAssetInModelSection(eventId, assetId) {
    try {
        // Get fresh event data to check if asset is extra
        const response = await apiCall(`/api/events/${eventId}`);
        const freshEvent = response.data;
        
        // Find the asset in available section and move it to assigned section
        const availableAssetElements = document.querySelectorAll(`[onclick*="prepareSpecificAsset(${eventId}, '${assetId}')"]`);
        
        availableAssetElements.forEach(button => {
            const assetDiv = button.closest('div[style*="display: flex"]');
            if (assetDiv) {
                const modelSection = assetDiv.closest('.model-prep-section');
                if (modelSection) {
                    // Get asset details before removing from available
                    const assetIdText = assetId;
                    const serialMatch = assetDiv.textContent.match(/SN: ([^•]+)/);
                    const serialText = serialMatch ? serialMatch[1].trim() : 'N/A';
                    
                    // Remove from available section
                    assetDiv.remove();
                    
                    // Find the assigned section
                    const assignedSection = modelSection.querySelector('[style*="background: #d4edda"]');
                    if (assignedSection) {
                        // Count how many assets are already assigned to determine if this one is extra
                        const existingAssets = assignedSection.querySelectorAll('div[style*="display: flex"]');
                        const currentAssignedCount = existingAssets.length;
                        
                        // Find the required quantity from the section title
                        const titleElement = modelSection.querySelector('h5');
                        const titleMatch = titleElement ? titleElement.textContent.match(/(\d+)x/) : null;
                        const requiredQty = titleMatch ? parseInt(titleMatch[1]) : 1;
                        
                        // Determine if this asset is extra
                        const isExtra = currentAssignedCount >= requiredQty;
                        const bgColor = isExtra ? '#fff3cd' : '#d4edda';
                        const textColor = isExtra ? '#856404' : '#155724';
                        const statusIcon = isExtra ? '➕' : '✅';
                        const statusText = isExtra ? 'Extra' : 'Required';
                        const borderColor = isExtra ? '#ffeaa7' : '#c3e6cb';
                        
                        // Create new assigned asset element with proper styling
                        const newAssetHTML = `
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding: 10px 12px; background: ${bgColor}; border-radius: 4px; border: 1px solid ${borderColor};">
                                <div>
                                    <span style="color: ${textColor}; font-weight: 500; font-size: 15px;">
                                        ${statusIcon} ${assetIdText}
                                    </span>
                                    <div style="color: ${textColor}; font-size: 13px; margin-top: 3px;">SN: ${serialText} • ${statusText}</div>
                                </div>
                                <button class="btn btn-warning" style="padding: 6px 12px; font-size: 12px;" onclick="unprepareSpecificAsset(${eventId}, '${assetId}')">Unprepare</button>
                            </div>
                        `;
                        
                        assignedSection.insertAdjacentHTML('beforeend', newAssetHTML);
                    }
                    
                    // Update counts
                    updateModelSectionCounts(modelSection, 'add');
                }
            }
        });
    } catch (error) {
        console.error('Error moving asset in model section:', error);
    }
}

function updateEventSummaryInModal(event) {
    // Update the summary numbers at the top
    const summaryDivs = document.querySelectorAll('.prepare-event-interface div[style*="font-size: 20px"]');
    if (summaryDivs.length >= 3) {
        summaryDivs[0].textContent = event.totalAssets || 0; // Required
        summaryDivs[1].textContent = event.totalPrepared || 0; // Prepared
        summaryDivs[2].textContent = Math.max(0, (event.totalPrepared || 0) - (event.totalAssets || 0)); // Extra
    }
}

function updateModelProgressBars(event) {
    // Update progress bars in model sections
    if (event.modelGroups) {
        Object.values(event.modelGroups).forEach(modelGroup => {
            const assignedCount = modelGroup.assignedAssets.length;
            const requiredQty = modelGroup.requiredQuantity;
            const progressPercent = Math.round((assignedCount / requiredQty) * 100);
            
            // Find the model section by looking for the model name
            const modelName = `${modelGroup.brand} ${modelGroup.model}`;
            const modelHeaders = document.querySelectorAll('h5, h6');
            
            modelHeaders.forEach(header => {
                if (header.textContent.includes(modelName)) {
                    const progressContainer = header.closest('div').parentElement;
                    
                    // Update the assigned count text
                    const assignedText = progressContainer.querySelector('[style*="font-size: 14px"][style*="font-weight: 500"]');
                    if (assignedText) {
                        const color = assignedCount >= requiredQty ? '#28a745' : '#ffc107';
                        assignedText.style.color = color;
                        assignedText.textContent = `${assignedCount}/${requiredQty} assigned${assignedCount > requiredQty ? ` (+${assignedCount - requiredQty} extra)` : ''}`;
                    }
                    
                    // Update the progress bar
                    const progressBar = progressContainer.querySelector('[style*="background: #e9ecef"] div');
                    if (progressBar) {
                        const color = assignedCount >= requiredQty ? '#28a745' : '#ffc107';
                        progressBar.style.background = color;
                        progressBar.style.width = `${Math.min(progressPercent, 100)}%`;
                    }
                }
            });
        });
    }
}

function addAssetBackToAvailable(modelSection, assetId, serial) {
    // Find the available section container
    let availableContainer = modelSection.querySelector('[style*="background: #e8f5e8"]');
    
    if (!availableContainer) {
        // If no available section exists, create it
        const modelContent = modelSection.querySelector('div[id*="model-"]');
        if (modelContent) {
            const availableSectionHTML = `
                <div style="margin-bottom: 20px;">
                    <h6 style="color: #495057; margin-bottom: 10px; font-size: 13px;">Available Assets (1)</h6>
                    <div style="background: #e8f5e8; border-radius: 6px; padding: 10px; max-height: 200px; overflow-y: auto;"></div>
                </div>
            `;
            modelContent.insertAdjacentHTML('afterbegin', availableSectionHTML);
            availableContainer = modelContent.querySelector('[style*="background: #e8f5e8"]');
        }
    }
    
    if (availableContainer) {
        // Extract eventId from the model section
        let eventId = null;
        const existingButton = modelSection.querySelector('[onclick*="assignSpecificAsset"]');
        if (existingButton) {
            const onclickAttr = existingButton.getAttribute('onclick');
            const eventIdMatch = onclickAttr.match(/assignSpecificAsset\((\d+),/);
            if (eventIdMatch) {
                eventId = eventIdMatch[1];
            }
        }
        
        // If we can't find eventId from existing buttons, try to extract from unprepare buttons
        if (!eventId) {
            const unprepareButton = modelSection.querySelector('[onclick*="unprepareSpecificAsset"]');
            if (unprepareButton) {
                const onclickAttr = unprepareButton.getAttribute('onclick');
                const eventIdMatch = onclickAttr.match(/unprepareSpecificAsset\((\d+),/);
                if (eventIdMatch) {
                    eventId = eventIdMatch[1];
                }
            }
        }
        
        if (eventId) {
            const newAssetHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; background: white; border-radius: 4px; margin-bottom: 5px; border: 1px solid #c3e6cb;">
                    <div>
                        <div style="font-weight: 500; font-size: 14px;">${assetId}</div>
                        <div style="color: #666; font-size: 12px;">SN: ${serial}</div>
                    </div>
                    <button class="btn btn-success" style="padding: 4px 10px; font-size: 11px;" onclick="assignSpecificAsset(${eventId}, '${escapeJs(assetId)}', '', '')">Prepare</button>
                </div>
            `;
            
            // Find the correct position to insert the asset (sorted by asset ID)
            const existingAssets = availableContainer.querySelectorAll('div[style*="display: flex"]');
            let insertPosition = null;
            
            for (let i = 0; i < existingAssets.length; i++) {
                const existingAssetId = existingAssets[i].querySelector('[style*="font-weight: 500"]').textContent;
                
                // Compare asset IDs to find correct insertion point
                if (assetId.localeCompare(existingAssetId, undefined, { numeric: true, sensitivity: 'base' }) < 0) {
                    insertPosition = existingAssets[i];
                    break;
                }
            }
            
            // Insert in the correct position
            if (insertPosition) {
                insertPosition.insertAdjacentHTML('beforebegin', newAssetHTML);
            } else {
                // Insert at the end if no position found
                availableContainer.insertAdjacentHTML('beforeend', newAssetHTML);
            }
        }
    }
}

function updateModelSectionCounts(modelSection, action) {
    // Update Available Assets count
    const availableHeaders = modelSection.querySelectorAll('h6[style*="color: #495057"]');
    availableHeaders.forEach(header => {
        if (header.textContent.includes('Available Assets')) {
            const match = header.textContent.match(/Available Assets \((\d+)\)/);
            if (match) {
                const currentCount = parseInt(match[1]);
                const newCount = action === 'remove' ? currentCount + 1 : currentCount - 1;
                header.textContent = `Available Assets (${Math.max(0, newCount)})`;
            }
        }
    });
    
    // Update Assigned Assets count
    const assignedHeaders = modelSection.querySelectorAll('h6[style*="color: #495057"]');
    assignedHeaders.forEach(header => {
        if (header.textContent.includes('Assigned Assets')) {
            const match = header.textContent.match(/Assigned Assets \((\d+)\)/);
            if (match) {
                const currentCount = parseInt(match[1]);
                const newCount = action === 'remove' ? currentCount - 1 : currentCount + 1;
                header.textContent = `Assigned Assets (${Math.max(0, newCount)})`;
            }
        }
    });
}

function updateDepartmentProgressBars(event) {
    // Update progress bars for model requirements departments
    if (event.modelGroups) {
        const deptProgress = {};
        
        // Calculate progress by department
        Object.values(event.modelGroups).forEach(modelGroup => {
            const dept = modelGroup.department;
            if (!deptProgress[dept]) {
                deptProgress[dept] = { required: 0, assigned: 0 };
            }
            deptProgress[dept].required += modelGroup.requiredQuantity;
            deptProgress[dept].assigned += modelGroup.assignedAssets.length;
        });
        
        // Update the department progress bars
        Object.keys(deptProgress).forEach(dept => {
            const { required, assigned } = deptProgress[dept];
            const progressPercent = required > 0 ? Math.round((assigned / required) * 100) : 0;
            const progressColor = assigned >= required ? '#28a745' : '#ffc107';
            
            // Find the department header - try multiple selectors
            let deptHeader = document.querySelector(`[onclick*="togglePrepareSection('dept-${dept}')"]`);
            if (!deptHeader) {
                deptHeader = document.querySelector(`[onclick*="dept-${dept}"]`);
            }
            
            if (deptHeader) {
                // Update the progress text
                const progressText = deptHeader.querySelector('[style*="font-size: 12px"][style*="font-weight: 500"]');
                if (progressText) {
                    progressText.style.color = progressColor;
                    progressText.textContent = `${assigned}/${required} assigned`;
                }
                
                // Update the progress bar
                const progressBar = deptHeader.querySelector('[style*="background: #e9ecef"] div');
                if (progressBar) {
                    progressBar.style.background = progressColor;
                    progressBar.style.width = `${Math.min(progressPercent, 100)}%`;
                }
            }
        });
    }
}

async function assignSpecificAsset(eventId, assetId, brand, model) {
    try {
        await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId });
        showNotification('success', `Assigned ${assetId} to event`);
        
        // Force refresh the preparation modal to show updated status
        setTimeout(() => {
            openPrepareEventModal(eventId);
        }, 500);
        
        // Also refresh other views if they're active
        setTimeout(() => {
            if (document.getElementById('prepare-section').classList.contains('active')) {
                loadPrepareEvents();
            }
            if (document.getElementById('dashboard-section').classList.contains('active')) {
                loadDashboard();
            }
            if (document.getElementById('events-section').classList.contains('active')) {
                loadAllEvents();
            }
        }, 700);
        
    } catch (error) {
        showNotification('error', `Failed to assign asset: ${error.message}`);
    }
}

async function unassignSpecificAsset(eventId, assetId, brand, model) {
  try {
    // Use the new unassign-specific endpoint
    await apiCall(`/api/events/${eventId}/unassign-specific`, "POST", {
      assetId,
    });
    showNotification("success", `Unassigned ${assetId} from event`);

    // Refresh the preparation modal with state preservation
    setTimeout(() => {
      preserveModalState(() => {
        openPrepareEventModal(eventId);
      });
    }, 200);
  } catch (error) {
    showNotification("error", `Failed to unassign asset: ${error.message}`);
  }
}

function finishEventPreparation(eventId) {
    closeModal('prepareEventModal');
    showNotification('success', 'Event preparation completed');
    
    // Refresh multiple views
    if (document.getElementById('prepare-section').classList.contains('active')) {
        loadPrepareEvents();
    }
    if (document.getElementById('dashboard-section').classList.contains('active')) {
        loadDashboard();
    }
    if (document.getElementById('events-section').classList.contains('active')) {
        loadAllEvents();
    }
}

async function processUniversalAsset(eventId) {
    const input = document.getElementById('universalAssetInput');
    const feedbackDiv = document.getElementById('universal-asset-feedback');
    const assetId = input.value.trim();
    
    if (!assetId) {
        showFeedback(feedbackDiv, 'warning', 'Please enter an asset ID');
        return;
    }

    if (!window.__processingContainerBatch) {
      const container = await getContainerById(assetId, true);
      if (container) {
        await processUniversalContainer(eventId, container.id);
        return;
      }
    }
    
    try {
        // Get event details and available assets to check asset existence and model matching
        const [eventResponse, availableAssetsResponse] = await Promise.all([
            apiCall(`/api/events/${eventId}`),
            apiCall('/api/assets/available')
        ]);
        
        const event = eventResponse.data;
        const allAssets = availableAssetsResponse.data;
        
        // Find the asset in available assets or check if it exists in inventory
        let assetDetails = allAssets.find(a => a.id === assetId);
        
        // If not in available assets, try to get asset details from the event's actually_prepared list
        if (!assetDetails && event.actuallyPrepared && event.actuallyPrepared.includes(assetId)) {
            // Asset might already be prepared, we need to check its details differently
            // For now, we'll create a basic asset object
            assetDetails = { id: assetId };
        }
        
        let isDirectlyAssigned = false;
        let isAlreadyPrepared = false;
        let isReturned = false;
        let fulfillsModelRequirement = false;
        
        // Check if asset is directly in prepared_items (assigned)
        if (event.preparedItems && event.preparedItems.includes(assetId)) {
            isDirectlyAssigned = true;
        }
        
        // Check if asset is already prepared
        if (event.actuallyPrepared && event.actuallyPrepared.includes(assetId)) {
            isAlreadyPrepared = true;
        }
        
        // Check if asset is returned
        if (event.returnedItems && event.returnedItems.includes(assetId)) {
            isReturned = true;
        }
        
        // Check if asset fulfills any model requirement
        if (assetDetails && event.preparedItems) {
            for (const preparedItem of event.preparedItems) {
                if (preparedItem.startsWith('[MODEL]')) {
                    try {
                        const parts = preparedItem.substring(7).split('|');
                        if (parts.length >= 4) {
                            const reqDept = parts[0];
                            const reqBrand = parts[1];
                            const reqModel = parts[2];
                            const reqDescription = parts[4] || '';
                            
                            // Check if this asset matches the model requirement (including description)
                            if (assetDetails.department === reqDept && 
                                assetDetails.brand === reqBrand && 
                                assetDetails.model === reqModel &&
                                (assetDetails.description || '') === reqDescription) {
                                fulfillsModelRequirement = true;
                                break;
                            }
                        }
                    } catch (e) {
                        console.error('Error parsing model assignment:', e);
                    }
                }
            }
        }
        
        // Determine if asset is considered "assigned" (either directly or through model requirement)
        const isAssigned = isDirectlyAssigned || fulfillsModelRequirement;
        
        if (isReturned) {
            showFeedback(feedbackDiv, 'error', `${assetId} has already been returned from this event`);
            return;
        }
        
        if (isAssigned) {
            if (isAlreadyPrepared) {
                showFeedback(feedbackDiv, 'info', `${assetId} is already prepared for this event`);
            } else {
                // Asset is assigned but not prepared - prepare it
                await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId });
                showFeedback(feedbackDiv, 'success', `✅ ${assetId} assigned and prepared`);
                
                // Clear input and focus back on it
                input.value = '';
                input.focus();
                
                // Update just the asset list section without full refresh
                setTimeout(() => {
                    updateAssetListSection(eventId);
                }, 500);
            }
        } else {
            // Asset is not assigned - ask if they want to assign it
            if (!assetDetails) {
                showFeedback(feedbackDiv, 'error', `${assetId} not found in inventory or not available`);
                return;
            }
            
            showFeedback(feedbackDiv, 'warning', 
                `${assetId} is not assigned to this event. 
                <button class="btn btn-warning" style="margin-left: 10px; padding: 4px 8px; font-size: 12px;" onclick="assignAndPrepareAsset(${eventId}, '${assetId}')">
                    Assign & Prepare
                </button>
                <button class="btn btn-secondary" style="margin-left: 5px; padding: 4px 8px; font-size: 12px;" onclick="clearUniversalFeedback()">
                    Cancel
                </button>`
            );
        }
        
    } catch (error) {
        showFeedback(feedbackDiv, 'error', `Failed to process asset: ${error.message}`);
    }
}

async function processUniversalContainer(eventId, containerId) {
  const feedbackDiv = document.getElementById('universal-asset-feedback');
  const input = document.getElementById('universalAssetInput');

  const container = await getContainerById(containerId, true);
  if (!container) {
    if (feedbackDiv) showFeedback(feedbackDiv, 'error', `Container ${containerId} not found`);
    return;
  }

  const assetIds = (container.assetIds || [])
    .map(a => String(a || '').trim())
    .filter(Boolean);

  if (assetIds.length === 0) {
    if (feedbackDiv) showFeedback(feedbackDiv, 'warning', `Container ${containerId} has no assets`);
    return;
  }

  if (feedbackDiv) {
    showFeedback(
      feedbackDiv,
      'info',
      `Processing container <strong>${escapeHtml(containerId)}</strong> (${assetIds.length} assets)…<br/>` +
      `• Any assets not originally assigned to the event will be added as extra and prepared.`
    );
  }

  // Pull current event state once, then keep local sets updated as we go
  let event;
  try {
    const eventRes = await apiCall(`/api/events/${eventId}`);
    event = eventRes.data || {};
  } catch (e) {
    if (feedbackDiv) showFeedback(feedbackDiv, 'error', `Failed to load event: ${escapeHtml(e.message || String(e))}`);
    return;
  }

  const preparedSet = new Set(event.actuallyPrepared || []);
  const returnedSet = new Set(event.returnedItems || []);

  const results = {
    prepared: [],
    skippedPrepared: [],
    skippedReturned: [],
    failed: []
  };

  window.__processingContainerBatch = true;
  try {
    for (const aid of assetIds) {
      // Skip returned assets (same behavior as manual processing)
      if (returnedSet.has(aid)) {
        results.skippedReturned.push(aid);
        continue;
      }

      // Skip already prepared assets (avoid /assign-specific "already assigned" error)
      if (preparedSet.has(aid)) {
        results.skippedPrepared.push(aid);
        continue;
      }

      try {
        // This endpoint both assigns (adds to prepared_items if missing) and prepares (adds to actually_prepared)
        await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId: aid });
        results.prepared.push(aid);
        preparedSet.add(aid);
      } catch (err) {
        results.failed.push({ id: aid, error: err?.message || String(err) });
      }
    }
  } finally {
    window.__processingContainerBatch = false;

    if (input) {
      input.value = '';
      input.focus();
    }
  }

  // Build a compact summary + expandable details
  const total = assetIds.length;
  const ok = results.prepared.length;
  const already = results.skippedPrepared.length;
  const returned = results.skippedReturned.length;
  const failed = results.failed.length;

  let detailsHtml = `
    <div style="margin-top:6px;">
      <div><strong>Summary</strong> (Container ${escapeHtml(containerId)}):</div>
      <div>✅ Prepared: <strong>${ok}</strong> / ${total}</div>
      <div>ℹ️ Already prepared (skipped): <strong>${already}</strong></div>
      <div>↩️ Returned in this event (skipped): <strong>${returned}</strong></div>
      <div style="${failed ? 'color:#a00;' : ''}">⚠️ Failed: <strong>${failed}</strong></div>
    </div>
  `;

  const listToHtml = (title, arr) => {
    if (!arr || arr.length === 0) return '';
    const items = arr.slice(0, 50).map(x => `<li>${escapeHtml(String(x))}</li>`).join('');
    const more = arr.length > 50 ? `<div style="color:#666;font-size:12px;">…and ${arr.length - 50} more</div>` : '';
    return `
      <div style="margin-top:10px;">
        <div style="font-weight:700;">${escapeHtml(title)}</div>
        <ul style="margin:6px 0 0 18px;">${items}</ul>
        ${more}
      </div>
    `;
  };

  const failuresToHtml = (arr) => {
    if (!arr || arr.length === 0) return '';
    const rows = arr.slice(0, 30).map(f =>
      `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;">${escapeHtml(f.id)}</td>` +
      `<td style="padding:4px 8px;border-bottom:1px solid #eee;color:#a00;">${escapeHtml(f.error)}</td></tr>`
    ).join('');
    const more = arr.length > 30 ? `<div style="color:#666;font-size:12px;margin-top:6px;">…and ${arr.length - 30} more failures</div>` : '';
    return `
      <div style="margin-top:10px;">
        <div style="font-weight:700;color:#a00;">Failures</div>
        <div style="border:1px solid #eee;border-radius:6px;overflow:hidden;">
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#f8f9fa;">
                <th style="text-align:left;padding:6px 8px;">Asset ID</th>
                <th style="text-align:left;padding:6px 8px;">Reason</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${more}
      </div>
    `;
  };

  detailsHtml += `
    <details style="margin-top:10px;">
      <summary style="cursor:pointer;">Show details</summary>
      ${listToHtml('Prepared', results.prepared)}
      ${listToHtml('Skipped (already prepared)', results.skippedPrepared)}
      ${listToHtml('Skipped (returned)', results.skippedReturned)}
      ${failuresToHtml(results.failed)}
    </details>
  `;

  if (feedbackDiv) {
    showFeedback(feedbackDiv, failed ? 'warning' : 'success', detailsHtml);
  }

  // Refresh just the asset list section once at the end (same UX as manual input)
  setTimeout(() => {
    try { updateAssetListSection(eventId); } catch (e) {}
  }, 400);
}

/**
 * ASSIGN + PREPARE in one step for extra assets
 * Used by: Universal asset input and "Assign & Prepare" buttons
 * Maintains exact same function signature as before
 */
async function assignAndPrepareAsset(eventId, assetId) {
    console.log(`=== assignAndPrepareAsset CALLED ===`);
    console.log('eventId:', eventId, 'assetId:', assetId);
    
    const feedbackDiv = document.getElementById('universal-asset-feedback');
    const input = document.getElementById('universalAssetInput');
    
    try {
        await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId });
        
        if (feedbackDiv) {
            showFeedback(feedbackDiv, 'success', `✅ ${assetId} assigned and prepared as extra asset`);
        } else {
            showNotification('success', `${assetId} assigned and prepared as extra asset`);
        }
        
        // Clear input and focus back on it
        if (input) {
            input.value = '';
            input.focus();
        }
        
        console.log('About to refresh modal with state preservation...');
        // Refresh modal while preserving UI state
        setTimeout(() => {
            preserveModalState(() => {
                openPrepareEventModal(eventId);
            });
        }, 200);
        
    } catch (error) {
        console.error('Error in assignAndPrepareAsset:', error);
        if (feedbackDiv) {
            showFeedback(feedbackDiv, 'error', `Failed to assign asset: ${error.message}`);
        } else {
            showNotification('error', `Failed to assign and prepare asset: ${error.message}`);
        }
    }
}

function updateEventSummary(event) {
    // Update the event summary numbers
    const requiredEl = document.querySelector('.prepare-event-interface .stats-grid div:nth-child(1) .stat-number');
    const preparedEl = document.querySelector('.prepare-event-interface .stats-grid div:nth-child(2) .stat-number');
    const extraEl = document.querySelector('.prepare-event-interface .stats-grid div:nth-child(3) .stat-number');
    
    if (requiredEl) requiredEl.textContent = event.totalAssets;
    if (preparedEl) preparedEl.textContent = event.totalPrepared;
    if (extraEl) extraEl.textContent = Math.max(0, event.totalPrepared - event.totalAssets);
}

function updateModelGroupsSection(event, eventId) {
    // Find all model requirement sections and update their status
    const modelSections = document.querySelectorAll('.model-prep-section');
    
    modelSections.forEach(section => {
        // Extract model info from the section
        const titleElement = section.querySelector('h5');
        if (!titleElement) return;
        
        const titleText = titleElement.textContent;
        const match = titleText.match(/(\d+)x (.+)/);
        if (!match) return;
        
        const requiredQty = parseInt(match[1]);
        const modelName = match[2];
        
        // Find matching model group in event data
        if (event.modelGroups) {
            Object.values(event.modelGroups).forEach(modelGroup => {
                const groupModelName = `${modelGroup.brand} ${modelGroup.model}`;
                if (groupModelName === modelName) {
                    updateModelSection(section, modelGroup, eventId);
                }
            });
        }
    });
}

function updateModelSection(section, modelGroup, eventId) {
    const assignedCount = modelGroup.assignedAssets.length;
    const requiredQty = modelGroup.requiredQuantity;
    const progressPercent = Math.round((assignedCount / requiredQty) * 100);
    
    // Update the progress info
    const statusDiv = section.querySelector('div[style*="text-align: right"] div:first-child');
    if (statusDiv) {
        const color = assignedCount >= requiredQty ? '#28a745' : '#ffc107';
        statusDiv.innerHTML = `
            <div style="font-size: 14px; font-weight: 500; color: ${color};">
                ${assignedCount}/${requiredQty} assigned
                ${assignedCount > requiredQty ? ` (+${assignedCount - requiredQty} extra)` : ''}
            </div>
        `;
    }
    
    // Update the progress bar
    const progressBar = section.querySelector('div[style*="background: #e9ecef"] div');
    if (progressBar) {
        const color = assignedCount >= requiredQty ? '#28a745' : '#ffc107';
        progressBar.style.background = color;
        progressBar.style.width = `${Math.min(progressPercent, 100)}%`;
    }
    
    // Update assigned assets list
    const assignedContainer = section.querySelector('div[style*="background: #d4edda"]');
    if (assignedContainer && modelGroup.assignedAssets.length > 0) {
        let content = '';
        modelGroup.assignedAssets.forEach((asset, index) => {
            const isExtra = index >= requiredQty;
            const bgColor = isExtra ? '#fff3cd' : '#d4edda';
            const textColor = isExtra ? '#856404' : '#155724';
            
            content += `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; padding: 4px 8px; background: ${bgColor}; border-radius: 3px;">
                    <span style="color: ${textColor};">
                        ${isExtra ? '➕' : '✅'} ${asset.id} (SN: ${asset.serial || 'N/A'})
                        ${isExtra ? ' <span style="font-size: 10px;">(EXTRA)</span>' : ''}
                    </span>
                    <button class="btn btn-warning" style="padding: 2px 6px; font-size: 10px;" onclick="unassignSpecificAsset(${eventId}, '${asset.id}', '${modelGroup.brand}', '${modelGroup.model}')">Unprepare</button>
                </div>
            `;
        });
        assignedContainer.innerHTML = content;
    }
}

function updateAllAssetsSection(event, eventId) {
  // This container DOES exist in your modal markup:
  // <div id="all-assigned-assets" ...></div>
  const container = document.getElementById("all-assigned-assets");
  if (!container) return;

  let content = "";

  // Rebuild the “All Assets Assigned to Event” inner list (header stays outside this div)
  if (event.assetsByDepartment && Object.keys(event.assetsByDepartment).length > 0) {
    Object.keys(event.assetsByDepartment).forEach((dept) => {
      const deptAssets = event.assetsByDepartment[dept] || [];

      // Only show real assets here (ignore [MODEL] rows)
      const nonModelAssets = deptAssets.filter(
        (a) => a && a.id && !a.id.startsWith("[MODEL]")
      );

      if (nonModelAssets.length > 0) {
        content += `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#f1f3f4;border-bottom:1px solid #e9ecef;cursor:pointer;"
               onclick="togglePrepareSection('assigned-dept-${dept}')">
            <div style="font-weight:500;font-size:13px;">${dept} Department (${nonModelAssets.length} assets)</div>
            <span class="toggle-icon" style="font-size:14px;font-weight:bold;color:#666;">▼</span>
          </div>
          <div id="assigned-dept-${dept}" style="display:block;">
        `;
      }

      nonModelAssets.forEach((asset) => {
        const assetId = asset.id;

        const isPrepared = Array.isArray(event.actuallyPrepared) && event.actuallyPrepared.includes(assetId);
        const isReturned = Array.isArray(event.returnedItems) && event.returnedItems.includes(assetId);
        const isExtra = Array.isArray(event.extraAssets) && event.extraAssets.includes(assetId);

        const statusIcon = isReturned ? "↩️" : (isPrepared ? "✅" : "⏳");
        const statusColor = isReturned ? "#dc3545" : (isPrepared ? "#28a745" : "#ffc107");
        const statusText = isReturned ? "Returned" : (isPrepared ? "Prepared" : "Pending");

        const extraBadge = isExtra
          ? '<span style="background:#fff3cd;color:#856404;padding:2px 6px;border-radius:3px;font-size:10px;margin-left:10px;">EXTRA</span>'
          : "";

        const safeAssetId = encodeURIComponent(assetId);

        let actionButton = "";
        if (isReturned) {
          actionButton = '<span style="color:#dc3545;font-size:11px;">Returned</span>';
        } else if (isPrepared) {
          actionButton = `
            <button class="btn btn-warning asset-action-btn"
                    data-event-id="${eventId}"
                    data-asset-id="${safeAssetId}"
                    data-action="unprepare"
                    style="padding:4px 8px;font-size:11px;">Unprepare</button>
          `;
        } else {
          actionButton = `
            <button class="btn btn-success asset-action-btn"
                    data-event-id="${eventId}"
                    data-asset-id="${safeAssetId}"
                    data-action="prepare"
                    style="padding:4px 8px;font-size:11px;">Prepare</button>
          `;
        }

        content += `
          <div style="padding:8px 12px;border-bottom:1px solid #f1f1f1;display:flex;justify-content:space-between;align-items:center;">
            <div>
              <span style="font-weight:500;">${statusIcon} ${assetId}</span>
              <span style="color:#666;font-size:12px;margin-left:10px;">${asset.name || ""}</span>
              ${extraBadge}
              <div style="color:${statusColor};font-size:11px;margin-top:2px;">${statusText}</div>
            </div>
            <div>${actionButton}</div>
          </div>
        `;
      });

      if (nonModelAssets.length > 0) {
        content += `</div>`;
      }
    });
  } else {
    content =
      '<p style="text-align:center;color:#666;padding:20px;">No individual assets assigned to this event.</p>';
  }

  container.innerHTML = content;
}

async function updateAssetListSection(eventId) {
    try {
        const response = await apiCall(`/api/events/${eventId}`);
        const event = response.data;
        
        // Update Event Summary
        updateEventSummary(event);
        
        // Update Model Groups sections
        updateModelGroupsSection(event, eventId);
        
        // Update the "All Assets Assigned to Event" section
        updateAllAssetsSection(event, eventId);
        
        // Ensure the input stays focused
        const input = document.getElementById('universalAssetInput');
        if (input) {
            setTimeout(() => input.focus(), 100);
        }
        
    } catch (error) {
        console.error('Error updating asset list section:', error);
    }
}


function showFeedback(feedbackDiv, type, message) {
    const colors = {
        'success': { bg: '#d4edda', color: '#155724', border: '#c3e6cb' },
        'error': { bg: '#f8d7da', color: '#721c24', border: '#f5c6cb' },
        'warning': { bg: '#fff3cd', color: '#856404', border: '#ffeaa7' },
        'info': { bg: '#d1ecf1', color: '#0c5460', border: '#bee5eb' }
    };
    
    const style = colors[type] || colors.info;
    
    feedbackDiv.innerHTML = `
        <div style="
            background: ${style.bg}; 
            color: ${style.color}; 
            border: 1px solid ${style.border}; 
            padding: 10px; 
            border-radius: 4px; 
            font-size: 14px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        ">
            <span>${message}</span>
        </div>
    `;
}

function clearUniversalInput() {
    const input = document.getElementById('universalAssetInput');
    const feedbackDiv = document.getElementById('universal-asset-feedback');
    
    input.value = '';
    feedbackDiv.innerHTML = '';
    input.focus();
}

function clearUniversalFeedback() {
    const feedbackDiv = document.getElementById('universal-asset-feedback');
    feedbackDiv.innerHTML = '';
}

async function loadReturnEvents() {
  try {
    const response = await apiCall('/api/events');
    
    // Update overdue counter
    const overdueCount = countOverdueEvents(response.data);
    updateOverdueCounter(overdueCount);
    
    const returnableEvents = response.data.filter((event) => {
      // Check for regular prepared assets
      const hasPreparedAssets = event.preparedCount > 0;
      const hasUnreturnedAssets = event.preparedCount > event.returnedCount;
      
      // Also check for custom assets (LOAN/MISC)
      let hasCustomAssets = false;
      let hasUnreturnedCustomAssets = false;
      
      if (event.assetsByDepartment) {
        ['LOAN', 'MISC'].forEach(dept => {
          if (event.assetsByDepartment[dept] && event.assetsByDepartment[dept].length > 0) {
            hasCustomAssets = true;
            const unreturnedCustom = event.assetsByDepartment[dept].filter(asset => 
              asset.status !== 'returned'
            );
            if (unreturnedCustom.length > 0) {
              hasUnreturnedCustomAssets = true;
            }
          }
        });
      }
      
      // Include events that have assets that can be returned, regardless of state
      const isReturnable = (hasPreparedAssets && hasUnreturnedAssets) || 
                          (hasCustomAssets && hasUnreturnedCustomAssets);
      
      return isReturnable && event.state !== 'Closed';
    });

    const container = document.getElementById("return-events");
    container.innerHTML = "";

    if (returnableEvents.length === 0) {
      container.innerHTML =
        '<p style="text-align: center; color: #666; padding: 40px;">No events with assets to return.</p>';
      return;
    }

    returnableEvents.forEach((event) => {
      const card = createReturnEventCard(event);
      container.appendChild(card);
    });
  } catch (error) {
    document.getElementById("return-events").innerHTML =
      '<p style="color: red; text-align: center;">Error loading events</p>';
  }
}

function createReturnEventCard(event) {
  const card = document.createElement("div");
  card.className = `event-card state-${event.state.toLowerCase()}`;

  // Helper function to escape HTML
  const escapeHtml = (str) => {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };

  const dateRange =
    event.startDate === event.endDate
      ? formatDate(event.startDate)
      : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;

  // Calculate total counts including custom assets
  let returnedCount = event.returnedCount || 0;
  let totalCount = event.preparedCount || 0;
  
  // Add custom assets to the counts
  if (event.assetsByDepartment) {
    ['LOAN', 'MISC'].forEach(dept => {
      if (event.assetsByDepartment[dept]) {
        const deptAssets = event.assetsByDepartment[dept];
        totalCount += deptAssets.length;
        const returnedCustom = deptAssets.filter(asset => asset.status === 'returned');
        returnedCount += returnedCustom.length;
      }
    });
  }

  card.innerHTML = `
      <div class="event-header">
          <div style="display: flex; align-items: center; gap: 8px;">
              <div class="event-id">ID: ${event.id}</div>
              <span style="padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; ${event.tag === 'dry hire' ? 'background: #17a2b8; color: white;' : 'background: #28a745; color: white;'}">
                  ${event.tag === 'dry hire' ? 'DRY HIRE' : 'EVENT'}
              </span>
          </div>
          <div class="event-state state-${event.state.toLowerCase()}">${escapeHtml(event.state)}</div>
      </div>
      <div class="event-title">${escapeHtml(event.name)}</div>
      <div class="event-date">${escapeHtml(dateRange)}</div>
      <div style="margin: 15px 0;">
          <small style="color: #666;">${returnedCount}/${totalCount} assets returned</small>
      </div>
      <div class="event-actions">
          <button class="btn btn-primary" onclick="viewEvent(${event.id})">View Assets</button>
          <button class="btn btn-warning" onclick="openReturnAssetsModalWithEvent(${event.id})">Return</button>
      </div>
  `;

  return card;
}

async function openReturnAssetsModalWithEvent(eventId) {
    try {
        // Open the return assets modal
        await openReturnAssetsModal();
        
        // Wait a short moment for the modal to render
        setTimeout(() => {
            // Pre-select the event in the dropdown
            const eventSelect = document.getElementById('returnEventSelect');
            if (eventSelect) {
                eventSelect.value = eventId;
                // Trigger the change event to load the assets
                loadEventAssetsForReturn();
            }
        }, 100);
        
    } catch (error) {
        showNotification('error', 'Failed to open return modal');
        console.error('Error opening return modal with pre-selected event:', error);
    }
}

async function openReturnAssetsModal() {
    try {
        const response = await apiCall('/api/events');
        
        // Debug: Log all events to see their structure
        console.log('All events from API:', response.data);
        
        const returnableEvents = response.data.filter(event => {
            // Debug: Log each event's key properties
            console.log(`Event ${event.id}:`, {
                preparedCount: event.preparedCount,
                returnedCount: event.returnedCount,
                state: event.state,
                assetsByDepartment: event.assetsByDepartment,
                preparedItems: event.preparedItems,
                actuallyPrepared: event.actuallyPrepared,
                returnedItems: event.returnedItems
            });
            
            // Check for regular prepared assets
            const hasPreparedAssets = event.preparedCount > 0;
            const hasUnreturnedAssets = event.preparedCount > event.returnedCount;
            
            // Check for custom assets in multiple places
            let hasCustomAssets = false;
            let hasUnreturnedCustomAssets = false;
            
            // Check 1: assetsByDepartment
            if (event.assetsByDepartment) {
                ['LOAN', 'MISC'].forEach(dept => {
                    if (event.assetsByDepartment[dept] && event.assetsByDepartment[dept].length > 0) {
                        hasCustomAssets = true;
                        const unreturnedCustom = event.assetsByDepartment[dept].filter(asset => 
                            asset.status !== 'returned'
                        );
                        if (unreturnedCustom.length > 0) {
                            hasUnreturnedCustomAssets = true;
                        }
                    }
                });
            }
            
            // Check 2: preparedItems for custom assets
            if (event.preparedItems && event.preparedItems.length > 0) {
                const customItemsInPrepared = event.preparedItems.filter(item => 
                    item.startsWith('[LOAN]') || item.startsWith('[MISC]')
                );
                if (customItemsInPrepared.length > 0) {
                    hasCustomAssets = true;
                    
                    // Check if any are not returned
                    const unreturnedCustomItems = customItemsInPrepared.filter(item => 
                        !event.returnedItems || !event.returnedItems.includes(item)
                    );
                    if (unreturnedCustomItems.length > 0) {
                        hasUnreturnedCustomAssets = true;
                    }
                }
            }
            
            // Check 3: actuallyPrepared for custom assets
            if (event.actuallyPrepared && event.actuallyPrepared.length > 0) {
                const customItemsActuallyPrepared = event.actuallyPrepared.filter(item => 
                    item.startsWith('[LOAN]') || item.startsWith('[MISC]')
                );
                if (customItemsActuallyPrepared.length > 0) {
                    hasCustomAssets = true;
                    
                    // Check if any are not returned
                    const unreturnedCustomItems = customItemsActuallyPrepared.filter(item => 
                        !event.returnedItems || !event.returnedItems.includes(item)
                    );
                    if (unreturnedCustomItems.length > 0) {
                        hasUnreturnedCustomAssets = true;
                    }
                }
            }
            
            console.log(`Event ${event.id} analysis:`, {
                hasPreparedAssets,
                hasUnreturnedAssets,
                hasCustomAssets,
                hasUnreturnedCustomAssets
            });
            
            // Event is returnable if it has unreturned regular assets OR unreturned custom assets
            const isReturnable = (hasPreparedAssets && hasUnreturnedAssets) || 
                                (hasCustomAssets && hasUnreturnedCustomAssets);
            
            console.log(`Event ${event.id} is returnable: ${isReturnable}`);
            
            return isReturnable && event.state !== 'Closed';
        });

        console.log('Filtered returnable events:', returnableEvents);

        let content = `
            <div class="return-assets-interface">
                <!-- Event Selection -->
                <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 25px;">
                    <h4 style="margin-bottom: 15px; color: #495057;">Select Event to Return Assets From</h4>
                    <div class="form-group">
                        <select class="form-input" id="returnEventSelect" onchange="loadEventAssetsForReturn()">
                            <option value="">Select an event...</option>
        `;

        returnableEvents.forEach(event => {
            const dateRange = event.startDate === event.endDate 
                ? new Date(event.startDate).toLocaleDateString()
                : `${new Date(event.startDate).toLocaleDateString()} - ${new Date(event.endDate).toLocaleDateString()}`;
            
            const statusBadge = event.state === 'Overdue' ? ' 🔴 OVERDUE' : '';
            
            // Calculate total unreturned (including custom assets)
            let totalUnreturned = (event.preparedCount || 0) - (event.returnedCount || 0);
            
            // Add custom assets count from various sources
            if (event.assetsByDepartment) {
                ['LOAN', 'MISC'].forEach(dept => {
                    if (event.assetsByDepartment[dept]) {
                        const unreturnedCustom = event.assetsByDepartment[dept].filter(asset => 
                            asset.status !== 'returned'
                        );
                        totalUnreturned += unreturnedCustom.length;
                    }
                });
            }
            
            // Also count from preparedItems and actuallyPrepared
            if (event.preparedItems) {
                const customInPrepared = event.preparedItems.filter(item => 
                    (item.startsWith('[LOAN]') || item.startsWith('[MISC]')) &&
                    (!event.returnedItems || !event.returnedItems.includes(item))
                );
                // Don't double count if already counted in assetsByDepartment
                if (!event.assetsByDepartment || !event.assetsByDepartment.LOAN && !event.assetsByDepartment.MISC) {
                    totalUnreturned += customInPrepared.length;
                }
            }
            
            content += `
                <option value="${event.id}">
                    Event ${event.id}: ${event.name} (${totalUnreturned} assets to return) ${statusBadge}
                </option>
            `;
        });

        content += `
                        </select>
                    </div>
                    <div id="event-summary" style="display: none; margin-top: 15px; padding: 15px; background: white; border-radius: 6px; border: 1px solid #e9ecef;">
                        <!-- Event summary will be populated when event is selected -->
                    </div>
                </div>

                <!-- Assets to Return (hidden until event is selected) -->
                <div id="assets-return-section" style="display: none;">
                    <h4 style="color: #495057; margin-bottom: 15px;">Assets Available for Return</h4>
                    <div id="return-assets-list">
                        <!-- Assets will be populated when event is selected -->
                    </div>

                    <!-- Manual Return -->
                    <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #e9ecef;">
                        <h4 style="color: #495057; margin-bottom: 15px;">Manual Return</h4>
                        <p style="color: #666; font-size: 14px; margin-bottom: 15px;">Scan or enter any asset ID to return it</p>
                        <div class="form-group" style="display: flex; gap: 10px;">
                            <input type="text" class="form-input" id="manualReturnAssetIdNew" 
                                   placeholder="Enter Asset ID or Serial Number..." 
                                   onkeypress="if(event.key==='Enter') returnManualAssetNew()"
                                   style="flex: 1;">
                            <button class="btn btn-warning" onclick="returnManualAssetNew()">Return Asset</button>
                        </div>
                    </div>
                </div>

                <!-- Actions -->
                <div style="margin-top: 30px; text-align: right; padding-top: 20px; border-top: 2px solid #e9ecef;">
                    <button class="btn btn-secondary" onclick="closeModal('returnAssetsModalNew')">Close</button>
                </div>
            </div>
        `;

        document.getElementById('returnAssetsContentNew').innerHTML = content;
        openModal('returnAssetsModalNew');
        
    } catch (error) {
        showNotification('error', 'Failed to load return assets interface');
        console.error('Error loading return assets modal:', error);
    }
}

async function loadEventAssetsForReturn() {
    const selectElement = document.getElementById('returnEventSelect');
    const eventId = selectElement.value;
    
    if (!eventId) {
        document.getElementById('event-summary').style.display = 'none';
        document.getElementById('assets-return-section').style.display = 'none';
        return;
    }

    try {
        const response = await apiCall(`/api/events/${eventId}`);
        const event = response.data;
        
        console.log(`Loading assets for event ${eventId}:`, event);

        // Calculate total counts including custom assets from preparedItems
        let totalPrepared = event.preparedCount || 0;
        let totalReturned = event.returnedCount || 0;
        
        // Count custom assets from preparedItems
        let customAssetsCount = 0;
        let customReturnedCount = 0;
        
        if (event.preparedItems) {
            const customItems = event.preparedItems.filter(item => 
                item.startsWith('[LOAN]') || item.startsWith('[MISC]')
            );
            customAssetsCount = customItems.length;
            
            if (event.returnedItems) {
                customReturnedCount = customItems.filter(item => 
                    event.returnedItems.includes(item)
                ).length;
            }
        }
        
        // Add custom assets to totals
        const totalAssetsIncludingCustom = totalPrepared + customAssetsCount;
        const totalReturnedIncludingCustom = totalReturned + customReturnedCount;
        const remaining = totalAssetsIncludingCustom - totalReturnedIncludingCustom;

        // Show event summary
        const summaryDiv = document.getElementById('event-summary');
        summaryDiv.style.display = 'block';
        summaryDiv.innerHTML = `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 15px; text-align: center;">
                <div>
                    <div style="font-size: 24px; font-weight: bold; color: #007bff;">${totalAssetsIncludingCustom}</div>
                    <div style="color: #6c757d; font-size: 12px;">Total Assets</div>
                </div>
                <div>
                    <div style="font-size: 24px; font-weight: bold; color: #28a745;">${totalReturnedIncludingCustom}</div>
                    <div style="color: #6c757d; font-size: 12px;">Returned</div>
                </div>
                <div>
                    <div style="font-size: 24px; font-weight: bold; color: #ffc107;">${remaining}</div>
                    <div style="color: #6c757d; font-size: 12px;">Remaining</div>
                </div>
            </div>
        `;

        // Show assets return section
        const assetsSection = document.getElementById('assets-return-section');
        assetsSection.style.display = 'block';

        let assetsContent = '';
        // Department quick actions: compute unreturned counts per department
        if (event.assetsByDepartment) {
          const depts = Object.keys(event.assetsByDepartment);
          const rows = [];
          depts.forEach((dept) => {
              const items = event.assetsByDepartment[dept] || [];
              const unreturned = items.filter(a => a.status !== 'returned');
              if (unreturned.length > 0) {
                  rows.push(`
                      <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border:1px solid #e9ecef; border-radius:8px; margin-bottom:8px;">
                          <div style="font-weight:600;">${dept}</div>
                          <div style="display:flex; align-items:center; gap:10px;">
                              <span style="font-size:12px; color:#6c757d;">${unreturned.length} to return</span>
                              <button class="btn btn-success btn-sm" onclick="returnAllForDepartment(${eventId}, '${dept.replace(/'/g, "\\'")}')">Return all</button>
                          </div>
                      </div>
                  `);
              }
          });
          if (rows.length > 0) {
              assetsContent += `
                  <div style="margin-bottom:16px;">
                      <div style="font-weight:600; margin-bottom:6px;">Department quick actions</div>
                      ${rows.join('')}
                  </div>
              `;
          }
        }

        // Process regular assets (from preparedAssets if available)
        if (event.preparedAssets && event.preparedAssets.length > 0) {
            // Group regular assets by type
            const assetGroups = {};
            
            event.preparedAssets.forEach(asset => {
                if (!asset.id.startsWith('[LOAN]') && !asset.id.startsWith('[MISC]')) {
                    const assetType = asset.id.split('#')[0];
                    if (!assetGroups[assetType]) {
                        assetGroups[assetType] = {
                            type: assetType,
                            assets: [],
                            brand: asset.brand,
                            model: asset.model,
                            description: asset.description
                        };
                    }
                    assetGroups[assetType].assets.push(asset);
                }
            });

            Object.values(assetGroups).forEach(group => {
                const unreturnedAssets = group.assets.filter(asset => asset.status !== 'returned');
                if (unreturnedAssets.length > 0) {
                    assetsContent += `
                        <div class="asset-type-group" style="margin-bottom: 25px; border: 1px solid #e9ecef; border-radius: 8px;">
                            <div style="background: #f8f9fa; padding: 15px; border-radius: 8px 8px 0 0; border-bottom: 1px solid #e9ecef;">
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <div>
                                        <h5 style="margin: 0; color: #495057;">${group.brand} ${group.model}</h5>
                                        <small style="color: #6c757d;">${group.description || ''}</small>
                                    </div>
                                    <div style="text-align: right;">
                                        <div style="font-size: 18px; font-weight: bold; color: #ffc107;">${unreturnedAssets.length}</div>
                                        <small style="color: #6c757d;">to return</small>
                                    </div>
                                </div>
                            </div>
                            <div style="padding: 15px;">
                    `;

                    unreturnedAssets.forEach((asset, index) => {
                        assetsContent += `
                            <div class="return-asset-item" style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: ${index % 2 === 0 ? '#f8f9fa' : 'white'}; border-radius: 6px; margin-bottom: 8px;">
                                <div>
                                    <div style="font-weight: 500; font-size: 14px;">${asset.id}</div>
                                    ${asset.serial ? `<div style="color: #999; font-size: 11px;">SN: ${asset.serial}</div>` : ''}
                                    ${asset.location ? `<div style="color: #007bff; font-size: 11px;">📍 ${asset.location}</div>` : ''}
                                </div>
                                <div style="margin-left: 15px;">
                                    <button class="btn btn-warning return-asset-btn" style="padding: 6px 12px; font-size: 12px;" onclick="returnSpecificAssetNew(${eventId}, '${asset.id}')">
                                        Return
                                    </button>
                                </div>
                            </div>
                        `;
                    });
                    assetsContent += '</div></div>';
                }
            });
        }
        
        // Process custom assets from preparedItems
        if (event.preparedItems && event.preparedItems.length > 0) {
            const customItems = event.preparedItems.filter(item => 
                item.startsWith('[LOAN]') || item.startsWith('[MISC]')
            );
            
            if (customItems.length > 0) {
                // Group custom items by type
                const loanItems = customItems.filter(item => item.startsWith('[LOAN]'));
                const miscItems = customItems.filter(item => item.startsWith('[MISC]'));
                
                [
                    { items: loanItems, title: '🏪 Loan/Rental Items', type: 'LOAN' },
                    { items: miscItems, title: '🔧 Misc Items', type: 'MISC' }
                ].forEach(({ items, title, type }) => {
                    if (items.length > 0) {
                        // Filter out returned items
                        const unreturnedItems = items.filter(item => 
                            !event.returnedItems || !event.returnedItems.includes(item)
                        );
                        
                        if (unreturnedItems.length > 0) {
                            assetsContent += `
                                <div class="asset-type-group" style="margin-bottom: 25px; border: 1px solid #e9ecef; border-radius: 8px;">
                                    <div style="background: #f8f9fa; padding: 15px; border-radius: 8px 8px 0 0; border-bottom: 1px solid #e9ecef;">
                                        <div style="display: flex; justify-content: space-between; align-items: center;">
                                            <div>
                                                <h5 style="margin: 0; color: #495057;">${title}</h5>
                                                <small style="color: #6c757d;">Custom assets</small>
                                            </div>
                                            <div style="text-align: right;">
                                                <div style="font-size: 18px; font-weight: bold; color: #ffc107;">${unreturnedItems.length}</div>
                                                <small style="color: #6c757d;">to return</small>
                                            </div>
                                        </div>
                                    </div>
                                    <div style="padding: 15px;">
                            `;

                            unreturnedItems.forEach((item, index) => {
                                // Parse custom asset format: [LOAN]name;quantity or [MISC]name;quantity
                                const prefix = `[${type}]`;
                                const itemContent = item.substring(prefix.length);
                                const [name, quantity] = itemContent.split(';');
                                const displayName = quantity ? `${name} (Qty: ${quantity})` : name;
                                
                                assetsContent += `
                                    <div class="return-asset-item" style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: ${index % 2 === 0 ? '#f8f9fa' : 'white'}; border-radius: 6px; margin-bottom: 8px;">
                                        <div>
                                            <div style="font-weight: 500; font-size: 14px;">${displayName}</div>
                                            <div style="color: #666; font-size: 11px;">Custom Asset ID: ${item}</div>
                                        </div>
                                        <div style="margin-left: 15px;">
                                            <button class="btn btn-warning return-asset-btn" style="padding: 6px 12px; font-size: 12px;" onclick="returnSpecificAssetNew(${eventId}, '${item}')">
                                                Return
                                            </button>
                                        </div>
                                    </div>
                                `;
                            });
                            
                            assetsContent += '</div></div>';
                        }
                    }
                });
            }
        }
        
        if (!assetsContent) {
            assetsContent = '<p style="text-align: center; color: #666; padding: 40px;">No assets available for return.</p>';
        }

        document.getElementById('return-assets-list').innerHTML = assetsContent;
        
    } catch (error) {
        showNotification('error', 'Failed to load event assets');
        console.error('Error loading event assets for return:', error);
    }
}

async function returnAssetsByType(eventId, assetType) {
    if (!confirm(`Are you sure you want to return all ${assetType} assets from this event?`)) {
        return;
    }
    
    try {
        // Get current event data to find assets of this type
        const response = await apiCall(`/api/events/${eventId}`);
        const event = response.data;
        const preparedAssets = event.preparedAssets || [];
        
        // Filter unreturned assets of the specified type
        const assetsToReturn = preparedAssets.filter(asset => {
            const assetTypeFromId = asset.id.split('#')[0];
            return assetTypeFromId === assetType && asset.status !== 'returned';
        });
        
        if (assetsToReturn.length === 0) {
            showNotification('info', `No ${assetType} assets available for return`);
            return;
        }
        
        // Return each asset
        let successCount = 0;
        let failCount = 0;
        
        for (const asset of assetsToReturn) {
            try {
                await apiCall(`/api/events/${eventId}/return`, 'POST', { assetId: asset.id });
                successCount++;
            } catch (error) {
                console.error(`Failed to return ${asset.id}:`, error);
                failCount++;
            }
        }
        
        // Show results
        if (successCount > 0) {
            showNotification('success', `Successfully returned ${successCount} ${assetType} asset(s)`);
        }
        if (failCount > 0) {
            showNotification('warning', `Failed to return ${failCount} asset(s)`);
        }
        
        // Refresh the interface
        setTimeout(() => {
            loadEventAssetsForReturn();
        }, 500);
        
        // Update overdue counter
        const eventsResponse = await apiCall('/api/events');
        const overdueCount = countOverdueEvents(eventsResponse.data);
        updateOverdueCounter(overdueCount);
        
    } catch (error) {
        showNotification('error', `Failed to return ${assetType} assets: ${error.message}`);
        console.error('Error returning assets by type:', error);
    }
}

async function returnSpecificAssetNew(eventId, assetId) {
    // Prevent multiple clicks
    const buttonElement = document.querySelector(`[onclick*="returnSpecificAssetNew(${eventId}, '${assetId}')"]`);
    if (buttonElement && buttonElement.disabled) {
        return;
    }
    
    try {
        // Disable the button immediately
        if (buttonElement) {
            buttonElement.disabled = true;
            buttonElement.style.opacity = '0.5';
            buttonElement.textContent = 'Returning...';
        }
        
        await apiCall(`/api/events/${eventId}/return`, 'POST', { assetId });
        showNotification('success', `${assetId} returned successfully`);
        
        // Remove the asset from the UI with animation
        const parentItem = buttonElement ? buttonElement.closest('.return-asset-item') : null;
        if (parentItem) {
            parentItem.style.transition = 'opacity 0.3s ease';
            parentItem.style.opacity = '0.3';
            parentItem.style.pointerEvents = 'none';
            
            setTimeout(() => {
                if (parentItem.parentNode) {
                    parentItem.parentNode.removeChild(parentItem);
                }
                // Refresh the event summary after removal
                setTimeout(() => {
                    loadEventAssetsForReturn();
                }, 100);
            }, 300);
        } else {
            // Fallback refresh if we can't find the specific element
            setTimeout(() => {
                loadEventAssetsForReturn();
            }, 500);
        }
        
        // Update overdue counter
        const response = await apiCall('/api/events');
        const overdueCount = countOverdueEvents(response.data);
        updateOverdueCounter(overdueCount);
        
    } catch (error) {
        showNotification('error', `Failed to return asset: ${error.message}`);
        console.error('Error returning asset:', error);
        
        // Re-enable button on error
        if (buttonElement) {
            buttonElement.disabled = false;
            buttonElement.style.opacity = '1';
            buttonElement.textContent = 'Return';
        }
    }
}

async function returnAllForDepartment(eventId, department) {
  try {
      // Best-effort disable of the clicked button
      const btn = document.querySelector(`[onclick*="returnAllForDepartment(${eventId}, '${department.replace("'", "\\'")}')"]`);
      if (btn) {
          btn.disabled = true;
          btn.textContent = 'Returning...';
          btn.style.opacity = '0.6';
      }

      const res = await apiCall(`/api/events/${eventId}/return-department`, 'POST', { department });

      // Prefer explicit count, then top-level returned[], then data.returned[]
      const returnedList =
        Array.isArray(res?.returned) ? res.returned :
        Array.isArray(res?.data?.returned) ? res.data.returned : [];

      const count =
        Number.isFinite(res?.count) ? res.count :
        Number.isFinite(res?.data?.count) ? res.data.count :
        returnedList.length;

      // Use a consistent success message
      showNotification('success', `${count} item(s) returned for ${department}`);


      // Refresh views
      loadEventAssetsForReturn();
      if (document.getElementById('return-section').classList.contains('active')) {
          loadReturnEvents();
      }
      if (document.getElementById('dashboard-section').classList.contains('active')) {
          loadDashboard();
      }
      if (document.getElementById('events-section').classList.contains('active')) {
          loadAllEvents();
      }
  } catch (error) {
      console.error('Error returning department assets:', error);
      showNotification('error', `Failed to return all for ${department}`);
  }
}

async function returnManualAssetNew() {
    const eventSelect = document.getElementById('returnEventSelect');
    const assetInput = document.getElementById('manualReturnAssetIdNew');
    const eventId = eventSelect.value;
    const assetId = assetInput.value.trim();
    
    if (!eventId) {
        showNotification('warning', 'Please select an event first');
        return;
    }
    
    if (!assetId) {
        showNotification('warning', 'Please enter an asset ID');
        return;
    }
    
    try {
        await apiCall(`/api/events/${eventId}/return`, 'POST', { assetId });
        showNotification('success', `${assetId} returned successfully`);
        
        // Clear input and focus back on it
        assetInput.value = '';
        assetInput.focus();
        
        // Refresh the event assets display
        loadEventAssetsForReturn();
        
        // Update overdue counter
        const response = await apiCall('/api/events');
        const overdueCount = countOverdueEvents(response.data);
        updateOverdueCounter(overdueCount);
        
    } catch (error) {
        showNotification('error', `Failed to return asset: ${error.message}`);
    }
}

async function loadTransferHistory() {
  try {
    const response = await apiCall("/api/events");
    const overdueCount = countOverdueEvents(response.data);
    updateOverdueCounter(overdueCount);
    const activeEvents = response.data.filter((event) => {
      // An event is transferable if:
      // 1. It's not closed
      // 2. It has assets assigned
      // 3. It has unreturned assets (prepared but not returned)
      const hasAssets = event.assetCount > 0;
      const hasUnreturnedAssets = event.preparedCount > event.returnedCount;
      
      return event.state !== "Closed" && hasAssets && hasUnreturnedAssets;
    });

    const container = document.getElementById("transfer-history");
    container.innerHTML = `
            <h3 style="margin-bottom: 20px; color: #764ba2;">Active Events Available for Transfer</h3>
            <div class="events-grid" id="transfer-events-list"></div>
        `;

    const eventsList = document.getElementById("transfer-events-list");

    if (activeEvents.length === 0) {
      eventsList.innerHTML =
        '<p style="text-align: center; color: #666; padding: 40px;">No active events with unreturned assets available for transfer.</p>';
      return;
    }

    activeEvents.forEach((event) => {
      const card = createTransferEventCard(event);
      eventsList.appendChild(card);
    });

    // Populate transfer modal dropdowns
    populateTransferDropdowns(activeEvents);
  } catch (error) {
    document.getElementById("transfer-history").innerHTML =
      '<p style="color: red; text-align: center;">Error loading events</p>';
  }
}

function createTransferEventCard(event) {
  const card = document.createElement("div");
  card.className = `event-card state-${event.state.toLowerCase()}`;

  // Helper function to escape HTML
  const escapeHtml = (str) => {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };

  const dateRange =
    event.startDate === event.endDate
      ? formatDate(event.startDate)
      : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;

  card.innerHTML = `
        <div class="event-header">
            <div class="event-id">ID: ${event.id}</div>
            <div class="event-state state-${event.state.toLowerCase()}">${escapeHtml(event.state)}</div>
        </div>
        <div class="event-title">${escapeHtml(event.name)}</div>
        <div class="event-date">${escapeHtml(dateRange)}</div>
        <div style="margin: 15px 0;">
            <small style="color: #666;">${event.assetCount || 0} assets assigned</small>
        </div>
        <div class="event-actions">
            <button class="btn btn-primary" onclick="viewEvent(${event.id})">View Assets</button>
        </div>
    `;

  return card;
}

async function viewEvent(eventId) {
  try {
    const response = await apiCall(`/api/events/${eventId}`);
    const event = response.data;
    
    // Store the current event ID and data for the delivery order button
    window.currentEventId = eventId;
    window.currentEventData = event;
    

    document.getElementById(
      "eventDetailsTitle"
    ).textContent = `${event.tag === 'dry hire' ? 'Dry Hire' : 'Event'} ${event.id}: ${event.name}`;

    const formatDate = (dateStr) => {
      // Fix: Convert YYYY/MM/DD format to a format that Date constructor can understand
      if (dateStr && dateStr.includes('/')) {
        // Convert YYYY/MM/DD to YYYY-MM-DD for proper parsing
        const dateParts = dateStr.split('/');
        if (dateParts.length === 3) {
          const [year, month, day] = dateParts;
          const isoDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
          return new Date(isoDate).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          });
        }
      }
      // Fallback for other date formats
      return new Date(dateStr).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    };

    const dateRange =
      event.startDate === event.endDate
        ? formatDate(event.startDate)
        : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;

    // Helper function to escape HTML
    const escapeHtml = (str) => {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    };

    let content = `
        <!-- Event Summary Card -->
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; margin-bottom: 25px;">
            <div style="display: grid; grid-template-columns: 1fr auto auto; gap: 20px; align-items: center;">
                <div>
                    <h3 style="margin: 0 0 8px 0; font-size: 1.4rem;">${escapeHtml(event.name)}</h3>
                    <div style="opacity: 0.9; font-size: 14px;">📅 ${dateRange}</div>
                </div>
                <div style="text-align: center;">
                    <div style="font-size: 24px; font-weight: bold; margin-bottom: 4px;">${event.totalPrepared}/${event.totalAssets}</div>
                    <div style="font-size: 12px; opacity: 0.9;">Assets Ready</div>
                </div>
                <div style="text-align: center;">
                    <span style="background: rgba(255,255,255,0.2); padding: 8px 16px; border-radius: 20px; font-size: 13px; font-weight: 500;">
                        ${event.state}
                    </span>
                </div>
            </div>
        </div>

        <!-- Progress Overview -->
        <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 25px;">
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; text-align: center;">
                <div>
                    <div style="font-size: 20px; font-weight: bold; color: #007bff;">${event.totalAssets}</div>
                    <div style="font-size: 12px; color: #666;">Required</div>
                </div>
                <div>
                    <div style="font-size: 20px; font-weight: bold; color: #28a745;">${event.totalPrepared}</div>
                    <div style="font-size: 12px; color: #666;">Prepared</div>
                </div>
                <div>
                    <div style="font-size: 20px; font-weight: bold; color: #dc3545;">${event.totalReturned}</div>
                    <div style="font-size: 12px; color: #666;">Returned</div>
                </div>
            </div>
        </div>
    `;

    // Model Requirements Section (Compact)
    if (event.modelGroups && Object.keys(event.modelGroups).length > 0) {
      content += '<div style="margin-bottom: 25px;"><h4 style="color: #495057; margin-bottom: 15px; font-size: 16px;">📦 Model Requirements</h4>';

      // Group by department
      const modelsByDept = {};
      Object.values(event.modelGroups).forEach((model) => {
        if (!modelsByDept[model.department]) {
          modelsByDept[model.department] = [];
        }
        modelsByDept[model.department].push(model);
      });

      Object.keys(modelsByDept).sort().forEach((dept) => {
        const models = modelsByDept[dept];
        
        content += `
            <div style="border: 1px solid #e9ecef; border-radius: 8px; margin-bottom: 15px; overflow: hidden;">
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 15px; background: #f8f9fa; border-bottom: 1px solid #e9ecef; cursor: pointer;" onclick="toggleViewSection('model-dept-${dept}')">
                    <div style="font-weight: 500; font-size: 14px;">${escapeHtml(dept)} Department</div>
                    <span class="toggle-icon" style="font-size: 14px; font-weight: bold; color: #666;">▼</span>
                </div>
                <div id="model-dept-${dept}" style="display: block;">
        `;

        models.forEach((model, index) => {
          const statusIcon = getModelStatusIcon(model.status);
          const assignedCount = model.assignedAssets.length;
          const modelId = `model-${dept}-${index}`;
          const progressPercent = model.requiredQuantity > 0 ? Math.round((assignedCount / model.requiredQuantity) * 100) : 0;
          
          // Fix status determination - if we have enough or more assets, it should be READY
          let statusColor = '#6c757d';
          let displayStatus = model.status;
          
          if (assignedCount >= model.requiredQuantity && model.status !== 'returned') {
            displayStatus = 'ready';
            statusColor = '#28a745';
          } else if (model.status === 'ready') {
            statusColor = '#28a745';
          } else if (model.status === 'partial') {
            statusColor = '#ffc107';
          } else if (model.status === 'returned') {
            statusColor = '#dc3545';
          }

          content += `
                <div style="padding: 12px 15px; border-bottom: 1px solid #f1f1f1; cursor: pointer; transition: background-color 0.2s;"
                     class="model-toggle" data-model-id="${modelId}" 
                     onmouseover="this.style.backgroundColor='#f8f9fa'" 
                     onmouseout="this.style.backgroundColor='white'">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="flex: 1;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                                <span style="font-weight: 500; font-size: 14px;">${statusIcon} ${model.requiredQuantity}x ${escapeHtml(model.brand)} ${escapeHtml(model.model)}</span>
                                <span style="color: ${statusColor}; font-size: 11px; font-weight: 500; text-transform: uppercase;">${displayStatus}</span>
                            </div>
                            ${model.description ? `<div style="color: #666; font-size: 12px; margin-bottom: 6px;">${escapeHtml(model.description)}</div>` : ''}
                            <div style="display: flex; align-items: center; gap: 15px;">
                                <div style="flex: 1; max-width: 200px;">
                                    <div style="background: #e9ecef; height: 4px; border-radius: 2px; overflow: hidden;">
                                        <div style="background: ${statusColor}; height: 100%; width: ${Math.min(progressPercent, 100)}%; transition: width 0.3s ease;"></div>
                                    </div>
                                </div>
                                <span style="font-size: 12px; color: #666; white-space: nowrap;">${assignedCount}/${model.requiredQuantity}</span>
                            </div>
                        </div>
                        <div style="margin-left: 15px;">
                            <span class="toggle-icon" data-model-id="${modelId}" style="font-size: 14px; color: #999; cursor: pointer; padding: 4px; border-radius: 3px; transition: background-color 0.2s;" onmouseover="this.style.backgroundColor='rgba(0,0,0,0.1)'" onmouseout="this.style.backgroundColor='transparent'">▼</span>
                        </div>
                    </div>
                    
                    <div id="${modelId}" class="model-details" style="display: none; margin-top: 12px; padding-top: 12px; border-top: 1px solid #f1f1f1;">
          `;

          if (model.assignedAssets.length > 0) {
            content += '<div style="display: flex; flex-wrap: wrap; gap: 6px;">';
            model.assignedAssets.forEach((asset) => {
              // Check if this specific asset is returned
              const assetStatusIcon = (asset.status === "returned" || (event.returnedItems && event.returnedItems.includes(asset.id))) ? "↩️" : "✅";
              const assetBgColor = (asset.status === "returned" || (event.returnedItems && event.returnedItems.includes(asset.id))) ? "#fff3cd" : "#d4edda";
              const assetTextColor = (asset.status === "returned" || (event.returnedItems && event.returnedItems.includes(asset.id))) ? "#856404" : "#155724";

              content += `
                    <span style="background: ${assetBgColor}; color: ${assetTextColor}; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 500;">
                        ${assetStatusIcon} ${escapeHtml(asset.id)}
                    </span>
              `;
            });
            content += '</div>';
          } else {
            content += '<div style="color: #999; font-style: italic; font-size: 12px;">No assets assigned yet</div>';
          }

          content += '</div></div>';
        });

        content += '</div><div>';
      });

      content += '</div>';
    }

    // Individual Assets Section (Compact)
    if (event.assetsByDepartment && Object.keys(event.assetsByDepartment).length > 0) {
      // Check if there are any individual assets (non-model)
      let hasIndividualAssets = false;
      Object.values(event.assetsByDepartment).forEach(assets => {
        if (assets.some(asset => !asset.id.startsWith('[MODEL]'))) {
          hasIndividualAssets = true;
        }
      });

      if (hasIndividualAssets) {
        content += `
          <div style="margin-bottom: 25px;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px; background: #f8f9fa; border-radius: 8px 8px 0 0; border-bottom: 1px solid #e9ecef; cursor: pointer;" onclick="toggleViewSection('individual-assets')">
              <h4 style="margin: 0; color: #495057; font-size: 16px;">📋 Individual Assets</h4>
              <span class="toggle-icon" style="font-size: 18px; font-weight: bold; color: #666;">▶</span>
            </div>
            <div id="individual-assets" style="display: none; border: 1px solid #e9ecef; border-top: none; border-radius: 0 0 8px 8px;">
        `;

        Object.keys(event.assetsByDepartment).sort().forEach((dept) => {
          const assets = event.assetsByDepartment[dept];
          const individualAssets = assets.filter(asset => !asset.id.startsWith('[MODEL]'));
          
          if (individualAssets.length > 0) {
            content += `
                <div style="border-bottom: 1px solid #f1f1f1; overflow: hidden;">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 15px; background: #f8f9fa; border-bottom: 1px solid #e9ecef; cursor: pointer;" onclick="toggleViewSection('dept-${dept}')">
                        <div style="font-weight: 500; font-size: 14px;">${escapeHtml(dept)} Department (${individualAssets.length})</div>
                        <span class="toggle-icon" style="font-size: 14px; font-weight: bold; color: #666;">▼</span>
                    </div>
                    <div id="dept-${dept}" style="display: block; padding: 10px 15px;">
                        <div style="display: grid; gap: 8px;">
            `;

            individualAssets.forEach((asset) => {
              let statusIcon = '📋';
              let statusColor = '#6c757d';
              let statusText = 'Assigned';
              
              // Check status in the correct order: returned first, then prepared
              if (asset.status === 'returned' || (event.returnedItems && event.returnedItems.includes(asset.id))) {
                statusIcon = '↩️';
                statusColor = '#dc3545';
                statusText = 'Returned';
              } else if (asset.status === 'prepared' || (event.actuallyPrepared && event.actuallyPrepared.includes(asset.id))) {
                statusIcon = '✅';
                statusColor = '#28a745';
                statusText = 'Prepared';
              }

              const extraBadge = asset.isExtra ? 
                '<span style="background: #fff3cd; color: #856404; padding: 2px 6px; border-radius: 3px; font-size: 9px; margin-left: 8px; font-weight: 500;">EXTRA</span>' : '';

              content += `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #f8f9fa; border-radius: 6px;">
                        <div style="flex: 1;">
                            <div style="font-weight: 500; font-size: 13px; margin-bottom: 2px;">
                                ${statusIcon} ${escapeHtml(asset.id)}${extraBadge}
                            </div>
                            <div style="color: #666; font-size: 11px;">${escapeHtml(asset.name || '')}</div>
                            ${asset.serial ? `<div style="color: #999; font-size: 10px;">SN: ${escapeHtml(asset.serial)}</div>` : ''}
                        </div>
                        <div style="text-align: right;">
                            <span style="color: ${statusColor}; font-size: 11px; font-weight: 500;">${statusText}</span>
                            ${asset.location ? `<div style="color: #999; font-size: 10px;">📍 ${escapeHtml(asset.location)}</div>` : ''}
                        </div>
                    </div>
              `;
            });

            content += '</div></div></div>';
          }
        });

        content += '</div>';
      }
    }

    document.getElementById("eventDetailsContent").innerHTML = content;

    // Add event listeners for model toggles with better event handling
    const eventDetailsContent = document.getElementById("eventDetailsContent");
    
    // Remove any existing listeners to prevent duplicates
    const existingListener = eventDetailsContent.handleModelToggle;
    if (existingListener) {
      eventDetailsContent.removeEventListener('click', existingListener);
    }
    
    function handleModelToggle(e) {
      // Check if clicked on toggle icon specifically
      if (e.target.classList.contains('toggle-icon')) {
        const modelId = e.target.getAttribute('data-model-id');
        if (modelId) {
          e.preventDefault();
          e.stopPropagation();
          toggleModelDetailsInView(modelId);
          return;
        }
      }
      
      // Check if clicked on model toggle area
      let toggleElement = null;
      if (e.target.classList.contains('model-toggle')) {
        toggleElement = e.target;
      } else if (e.target.closest('.model-toggle')) {
        toggleElement = e.target.closest('.model-toggle');
      }
      
      if (toggleElement) {
        const modelId = toggleElement.getAttribute('data-model-id');
        if (modelId) {
          e.preventDefault();
          e.stopPropagation();
          toggleModelDetailsInView(modelId);
        }
      }
    }
    
    // Store the listener reference for cleanup
    eventDetailsContent.handleModelToggle = handleModelToggle;
    eventDetailsContent.addEventListener('click', handleModelToggle);

    const logHTML = await createEventLogViewer(event.id, event.name);
    eventDetailsContent.innerHTML += logHTML;
    
    openModal("eventDetailsModal");
  } catch (error) {
    showNotification("error", "Failed to load event details");
  }
}

function toggleViewSection(sectionId) {
    const section = document.getElementById(sectionId);
    const toggleIcon = event.target.closest('[onclick]').querySelector('.toggle-icon');
    
    if (section && toggleIcon) {
        if (section.style.display === 'none') {
            section.style.display = 'block';
            toggleIcon.textContent = '▼';
        } else {
            section.style.display = 'none';
            toggleIcon.textContent = '▶';
        }
    }
}

function toggleModelDetailsInView(modelId) {
  const detailsDiv = document.getElementById(modelId);
  const toggleIcon = document.querySelector(`[data-model-id="${modelId}"].toggle-icon`);

  if (detailsDiv && toggleIcon) {
    if (detailsDiv.style.display === "none" || detailsDiv.style.display === "") {
      detailsDiv.style.display = "block";
      toggleIcon.textContent = "▲";
    } else {
      detailsDiv.style.display = "none";
      toggleIcon.textContent = "▼";
    }
  } else {
    console.warn(`Could not find elements for modelId: ${modelId}`);
    console.warn(`DetailsDiv:`, detailsDiv);
    console.warn(`ToggleIcon:`, toggleIcon);
  }
}

// Add the toggle function for expanding/collapsing model details
function toggleModelDetails(modelId) {
  const detailsDiv = document.getElementById(modelId);
  const toggleIcon = document.getElementById(`toggle-${modelId}`);

  if (detailsDiv.style.display === "none") {
    detailsDiv.style.display = "block";
    toggleIcon.textContent = "▲";
  } else {
    detailsDiv.style.display = "none";
    toggleIcon.textContent = "▼";
  }
}

async function loadMaintenanceAssets() {
  try {
    const response = await apiCall("/api/assets");
    
    // Update the global assets variable
    assets = response.data;
    
    // Check which tab is active and load appropriate content
    const activeTab = document.querySelector(".maintenance-tab.active");
    if (activeTab && activeTab.getAttribute('data-tab') === 'ooc') {
      loadOOCAssets();
    } else {
      displayMaintenanceAssets(response.data);
    }
  } catch (error) {
    document.getElementById("maintenance-assets").innerHTML =
      '<p style="color: red; text-align: center;">Error loading assets</p>';
  }
}

function displayMaintenanceAssets(assetsToShow) {
  const container = document.getElementById("maintenance-assets");

  if (assetsToShow.length === 0) {
    container.innerHTML =
      '<p style="text-align: center; color: #666; padding: 40px;">No assets found.</p>';
    return;
  }

  let tableHTML = `
        <table class="table">
            <thead>
                <tr>
                    <th>Asset ID</th>
                    <th>Brand</th>
                    <th>Model</th>
                    <th>Status</th>
                    <th>Location</th>
                    <th>Last Maintenance</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
    `;

  assetsToShow.forEach((asset) => {
    const lastMaintenance =
      asset.maintenanceLogs && asset.maintenanceLogs.length > 0
        ? asset.maintenanceLogs[asset.maintenanceLogs.length - 1].split("\t")[0]
        : "Never";

    tableHTML += `
            <tr>
                <td>${asset.id}</td>
                <td>${asset.brand}</td>
                <td>${asset.model}</td>
                <td><span class="asset-badge status-${asset.status}">${
      asset.status
    }</span></td>
                <td>${asset.location || "Store"}</td>
                <td>${lastMaintenance}</td>
                <td>
                    <button class="btn btn-primary" onclick="viewMaintenanceLog('${
                      asset.id
                    }')">View Log</button>
                </td>
            </tr>
        `;
  });

  tableHTML += "</tbody></table>";
  container.innerHTML = tableHTML;
}

function loadAssetCheck() {
  const container = document.getElementById("asset-check-content");
  container.innerHTML = `
        <div style="text-align: center; padding: 20px;">
            <h3>Asset Check Process</h3>
            <p>Verify physical inventory by scanning or entering asset IDs.</p>
            <button class="btn btn-success" onclick="startAssetCheck()" style="margin: 20px;">Start Asset Check</button>
        </div>
    `;
}

// Event handler functions
function openReturnAssetModal(eventId) {
  document.getElementById("returnEventId").value = eventId;
  document.getElementById(
    "returnAssetTitle"
  ).textContent = `Return Asset from Event ${eventId}`;
  openModal("returnAssetModal");
}

async function returnSpecificAsset(eventId, assetId) {
    try {
        await apiCall(`/api/events/${eventId}/return`, 'POST', { assetId });
        showNotification('success', `${assetId} returned successfully`);
        
        // Remove the asset from the return list
        const assetElement = document.querySelector(`[onclick*="returnSpecificAsset(${eventId}, '${assetId}')"]`);
        if (assetElement) {
            assetElement.style.transition = 'opacity 0.3s ease';
            assetElement.style.opacity = '0.5';
            assetElement.style.pointerEvents = 'none';
            
            setTimeout(() => {
                if (assetElement.parentNode) {
                    assetElement.parentNode.removeChild(assetElement);
                }
            }, 300);
        }
        
        // Refresh the return events list if it's active
        if (document.getElementById('return-section').classList.contains('active')) {
            setTimeout(() => {
                loadReturnEvents();
            }, 500);
        }
        
    } catch (error) {
        showNotification('error', `Failed to return asset: ${error.message}`);
    }
}

async function returnManualAsset(eventId) {
    const input = document.getElementById('manualReturnAssetId');
    const assetId = input.value.trim();
    
    if (!assetId) {
        showNotification('warning', 'Please enter an asset ID');
        return;
    }
    
    try {
        await apiCall(`/api/events/${eventId}/return`, 'POST', { assetId });
        showNotification('success', `${assetId} returned successfully`);
        
        // Clear input and focus back on it
        input.value = '';
        input.focus();
        
        // Remove the asset from the return list with animation
        const assetElement = document.querySelector(`[onclick*="returnSpecificAsset(${eventId}, '${assetId}')"]`);
        if (assetElement) {
            assetElement.style.transition = 'opacity 0.3s ease';
            assetElement.style.opacity = '0.5';
            assetElement.style.pointerEvents = 'none';
            
            setTimeout(() => {
                if (assetElement.parentNode) {
                    assetElement.parentNode.removeChild(assetElement);
                }
            }, 300);
        }
        
        // Refresh the return events list if it's active (but don't refresh modal)
        if (document.getElementById('return-section').classList.contains('active')) {
            setTimeout(() => {
                loadReturnEvents();
            }, 500);
        }
        
    } catch (error) {
        showNotification('error', `Failed to return asset: ${error.message}`);
    }
}

function finishReturningAssets(eventId) {
    closeModal('returnAssetsModal');
    showNotification('success', 'Return process completed');
    
    // Refresh views
    if (document.getElementById('return-section').classList.contains('active')) {
        loadReturnEvents();
    }
    if (document.getElementById('dashboard-section').classList.contains('active')) {
        loadDashboard();
    }
    if (document.getElementById('events-section').classList.contains('active')) {
        loadAllEvents();
    }
}

function openMaintenanceModalForAsset(assetId) {
  openMaintenanceModal();
  
  setTimeout(() => {
    if (assets && assets.length > 0) {
      selectAssetForMaintenance(assetId);
    } else {
      console.warn('Assets not loaded yet, cannot pre-select asset');
    }
  }, 200);
}

function populateTransferDropdowns(events) {
  const fromSelect = document.getElementById("transferFromEvent");
  const toSelect = document.getElementById("transferToEvent");

  // Clear existing options
  fromSelect.innerHTML = '<option value="">Select source event...</option>';
  toSelect.innerHTML = '<option value="">Select destination event...</option>';

  events.forEach((event) => {
    const tagPrefix = event.tag === 'dry hire' ? '[DH]' : '[E]';
    const option1 = document.createElement("option");
    option1.value = event.id;
    option1.textContent = `${tagPrefix} ${event.id}: ${event.name}`;
    fromSelect.appendChild(option1);

    const option2 = document.createElement("option");
    option2.value = event.id;
    option2.textContent = `${tagPrefix} ${event.id}: ${event.name}`;
    toSelect.appendChild(option2);
  });
}

function startAssetCheck() {
  const container = document.getElementById("asset-check-content");
  container.innerHTML = `
        <div style="max-width: 600px; margin: 0 auto;">
            <h3>Asset Check in Progress</h3>
            <div class="form-group">
                <label class="form-label">Enter Asset ID or Serial Number</label>
                <input type="text" class="form-input" id="assetCheckInput" placeholder="Scan or type asset ID...">
            </div>
            <div class="form-group">
                <button class="btn btn-success" onclick="checkAsset()">Check Asset</button>
                <button class="btn btn-secondary" onclick="finishAssetCheck()">Finish Check</button>
            </div>
            <div id="assetCheckResults" style="margin-top: 20px;">
                <h4>Checked Assets:</h4>
                <ul id="checkedAssetsList" style="list-style: none; padding: 0;"></ul>
            </div>
        </div>
    `;

  // Focus on input
  document.getElementById("assetCheckInput").focus();

  // Add enter key listener
  document
    .getElementById("assetCheckInput")
    .addEventListener("keypress", function (e) {
      if (e.key === "Enter") {
        checkAsset();
      }
    });
}

async function prepareAsset(eventId, assetId) {
  try {
    await apiCall(`/api/events/${eventId}/prepare`, "POST", { assetId });
    showNotification("success", `Asset ${assetId} prepared for event`);

    // Refresh the event details
    viewEvent(eventId);

    // Refresh other views if they're active
    if (
      document.getElementById("prepare-section").classList.contains("active")
    ) {
      loadPrepareEvents();
    }
  } catch (error) {
    showNotification("error", `Failed to prepare asset: ${error.message}`);
  }
}

async function unprepareAsset(eventId, assetId) {
  try {
    await apiCall(`/api/events/${eventId}/unprepare`, "POST", { assetId });
    showNotification("success", `Asset ${assetId} unprepared`);

    // Refresh the event details
    viewEvent(eventId);

    // Refresh other views if they're active
    if (
      document.getElementById("prepare-section").classList.contains("active")
    ) {
      loadPrepareEvents();
    }
  } catch (error) {
    showNotification("error", `Failed to unprepare asset: ${error.message}`);
  }
}

function toggleEventLogSection(sectionId) {
  const section = document.getElementById(sectionId);
  const toggleIcon = document.getElementById(sectionId + '-toggle');
  
  if (section && toggleIcon) {
    if (section.style.display === 'none') {
      section.style.display = 'block';
      toggleIcon.textContent = '▼';
    } else {
      section.style.display = 'none';
      toggleIcon.textContent = '▶';
    }
  }
}

async function createEventLogViewer(eventId, eventName) {
  try {
    // Use your API to get logs
    const response = await apiCall('/api/logs');
    const logs = response.data || [];
    
    // Filter logs for this event
    const relevantLogs = logs
      .filter(log => {
        if (!log.action) return false;
        const action = log.action.toLowerCase();
        const eventRef = `event ${eventId}`;
        return action.includes(eventRef) && 
               (action.includes('assigned') || 
                action.includes('prepared') || 
                action.includes('returned') || 
                action.includes('unprepared'));
      })
      .map(log => ({
        date: log.timestamp,
        user: log.user,
        action: log.action,
        timestamp: new Date(log.timestamp).getTime()
      }))
      .sort((a, b) => b.timestamp - a.timestamp);

    // Helper functions
    const getActionIcon = (actionType) => {
      switch (actionType) {
        case 'prepared': return '📦';
        case 'returned': return '🔄';
        case 'assigned': return '📋';
        case 'unprepared': return '❌';
        default: return '📝';
      }
    };

    const getActionColor = (actionType) => {
      switch (actionType) {
        case 'prepared': return 'color: #28a745; background: #d4edda; border-left-color: #28a745;';
        case 'returned': return 'color: #007bff; background: #cce5ff; border-left-color: #007bff;';
        case 'assigned': return 'color: #ffc107; background: #fff3cd; border-left-color: #ffc107;';
        case 'unprepared': return 'color: #dc3545; background: #f8d7da; border-left-color: #dc3545;';
        default: return 'color: #6c757d; background: #e2e3e5; border-left-color: #6c757d;';
      }
    };

    const getActionType = (action) => {
      const actionLower = action.toLowerCase();
      if (actionLower.includes('prepared')) return 'prepared';
      if (actionLower.includes('returned')) return 'returned';
      if (actionLower.includes('assigned')) return 'assigned';
      if (actionLower.includes('unprepared')) return 'unprepared';
      return 'other';
    };

    const extractAssetId = (action) => {
      const match = action.match(/asset\s+([A-Z0-9#]+(?:\[[^\]]+\])?[^;\s]*)/i);
      return match ? match[1] : null;
    };

    function generateActionButton(eventId, asset, isPrepared) {
    const safeAssetId = encodeURIComponent(asset.id);
    
    if (isPrepared) {
        return `<button class="btn btn-warning asset-action-btn" 
                        data-event-id="${eventId}" 
                        data-asset-id="${safeAssetId}" 
                        data-action="unprepare"
                        style="padding: 4px 8px; font-size: 11px; margin-right: 5px;">Unprepare</button>`;
    } else {
        return `<button class="btn btn-success asset-action-btn" 
                        data-event-id="${eventId}" 
                        data-asset-id="${safeAssetId}" 
                        data-action="prepare"
                        style="padding: 4px 8px; font-size: 11px; margin-right: 5px;">Prepare</button>`;
    }
}

    // Generate unique ID for this event's log section
    const logSectionId = `event-log-${eventId}`;

    // Generate HTML with collapsible header
    let logHTML = `
      <div style="background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); padding: 20px; margin-top: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none;" onclick="toggleEventLogSection('${logSectionId}')">
          <h3 style="margin: 0; color: #333; font-size: 18px; display: flex; align-items: center; gap: 10px;">
            📋 Event Activity Log
            <span style="font-size: 14px; color: #666; font-weight: normal;">(${eventName})</span>
            ${relevantLogs.length > 0 ? `<span style="background: #007bff; color: white; border-radius: 12px; padding: 2px 8px; font-size: 12px; font-weight: bold;">${relevantLogs.length}</span>` : ''}
          </h3>
          <span id="${logSectionId}-toggle" style="font-size: 18px; color: #666; font-weight: bold;">▶</span>
        </div>
        <div id="${logSectionId}" style="display: none; margin-top: 20px;">
    `;

    if (relevantLogs.length === 0) {
      logHTML += `
        <div style="text-align: center; padding: 40px 0; color: #666;">
          <div style="font-size: 48px; margin-bottom: 10px;">📋</div>
          <p>No asset activity recorded for this event yet.</p>
        </div>
      `;
    } else {
      logHTML += `<div style="max-height: 400px; overflow-y: auto;">`;
      
      relevantLogs.forEach((log, index) => {
        const actionType = getActionType(log.action);
        const assetId = extractAssetId(log.action);
        
        logHTML += `
          <div style="padding: 15px; border-radius: 8px; border-left: 4px solid; margin-bottom: 12px; ${getActionColor(actionType)}">
            <div style="display: flex; align-items: start; gap: 12px;">
              <span style="font-size: 18px; line-height: 1;">${getActionIcon(actionType)}</span>
              <div style="flex: 1;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                  <span style="font-weight: bold; color: #333;">${log.user}</span>
                  <span style="color: #999; font-size: 12px;">•</span>
                  <span style="color: #666; font-size: 13px;">${log.date}</span>
                </div>
                ${assetId ? `
                  <div style="margin: 6px 0;">
                    <span style="font-family: 'Courier New', monospace; background: #f8f9fa; padding: 3px 6px; border-radius: 3px; font-size: 12px; color: #495057;">
                      ${assetId}
                    </span>
                  </div>
                ` : ''}
                <p style="margin: 6px 0 0 0; color: #555; font-size: 13px; line-height: 1.4;">${log.action}</p>
              </div>
            </div>
          </div>
        `;
      });
      
      logHTML += `</div>`;
      
      logHTML += `
        <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #e9ecef; text-align: center; color: #666; font-size: 12px;">
          Showing ${relevantLogs.length} activity record(s)
        </div>
      `;
    }

    logHTML += `
        </div>
      </div>
    `;
    
    return logHTML;
  } catch (error) {
    console.error('Error loading event logs:', error);
    return `
      <div style="background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); padding: 20px; margin-top: 20px;">
        <h3 style="margin: 0 0 20px 0; color: #333;">📋 Event Activity Log</h3>
        <div style="text-align: center; padding: 20px; color: #dc3545;">
          Error loading activity log. Please try again.
        </div>
      </div>
    `;
  }
}

async function editEvent(eventId) {
  try {
    const response = await apiCall(`/api/events/${eventId}`);
    const event = response.data;

    document.getElementById(
      "eventDetailsTitle"
    ).textContent = `Edit Event ${event.id}: ${event.name}`;

    // Helper function to escape HTML
    const escapeHtml = (str) => {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    };

    let content = `
            <!-- Edit Event Tabs -->
            <div class="edit-event-tabs" style="display: flex; border-bottom: 2px solid #e9ecef; margin-bottom: 20px;">
                <button class="edit-tab active" data-tab="details" onclick="switchEditTab('details')" 
                        style="flex: 1; padding: 15px 20px; border: none; background: rgba(118, 75, 162, 0.05); font-size: 16px; font-weight: 500; cursor: pointer; border-bottom: 3px solid #764ba2; transition: all 0.3s ease; color: #764ba2;">
                    📝 Event Details
                </button>
                <button class="edit-tab" data-tab="assets" onclick="switchEditTab('assets')"
                        style="flex: 1; padding: 15px 20px; border: none; background: none; font-size: 16px; font-weight: 500; cursor: pointer; border-bottom: 3px solid transparent; transition: all 0.3s ease;">
                    📦 Manage Assets
                </button>
            </div>
            
            <!-- Tab Contents -->
            <div id="edit-details-tab" class="edit-tab-content">
                <form id="editEventDetailsForm">
                    <input type="hidden" id="editEventId" value="${event.id}">
                    <div class="form-group">
                        <label class="form-label">Event Name</label>
                        <input type="text" class="form-input" id="editEventName" value="${escapeHtml(event.name)}" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Event Tag</label>
                        <select class="form-input" id="editEventTag" required>
                            <option value="events" ${(event.tag === 'events' || !event.tag) ? 'selected' : ''}>Events</option>
                            <option value="dry hire" ${event.tag === 'dry hire' ? 'selected' : ''}>Dry Hire</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Start Date</label>
                        <input type="date" class="form-input" id="editEventStartDate" value="${formatDateForInput(event.startDate)}" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">End Date</label>
                        <input type="date" class="form-input" id="editEventEndDate" value="${formatDateForInput(event.endDate)}" required>
                    </div>
                    <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
                        <button type="submit" class="btn btn-primary">Update Event</button>
                    </div>
                </form>
            </div>
            
            <div id="edit-assets-tab" class="edit-tab-content" style="display: none;">
                <div class="assets-edit-interface">
                    <!-- Search Bar at Top -->
                    <div style="background: #e8f5e8; border: 2px solid #28a745; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
                        <h4 style="color: #155724; margin-bottom: 15px; font-size: 18px;">➕ Add Asset Models</h4>
                        <div style="display: flex; gap: 15px; align-items: flex-end;">
                            <div style="flex: 1;">
                                <input type="text" class="form-input" placeholder="Search available asset models..." 
                                       style="width: 100%; padding: 12px; border: 1px solid #28a745; border-radius: 6px; font-size: 14px;" 
                                       oninput="filterAvailableModels(this.value)">
                            </div>
                            <button type="button" class="btn btn-secondary" onclick="clearModelSearch()" 
                                    style="padding: 12px 20px; background: #6c757d; border: none; border-radius: 6px; color: white; font-size: 14px;">
                                Clear
                            </button>
                        </div>
                        <div id="available-models-container" style="margin-top: 15px; border: 1px solid #28a745; border-radius: 6px; max-height: 250px; overflow-y: auto; background: white;">
                            <div style="text-align: center; padding: 20px; color: #666; font-size: 14px;">
                                Type to search for available asset models...
                            </div>
                        </div>
                    </div>

                    <!-- Add Custom Asset Section -->
                    <div style="margin-bottom: 30px;">
                        <h4 style="color: #495057; margin-bottom: 15px;">🛠️ Add Custom Assets</h4>
                        <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 15px;">
                            <input type="text" id="customAssetName" placeholder="Enter custom asset name" 
                                   style="flex: 1; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                            <input type="number" id="customAssetQuantity" placeholder="Qty" min="1" value="1"
                                   style="width: 60px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                            <select id="customAssetType" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                                <option value="MISC">Misc Item</option>
                                <option value="LOAN">Loan/Rental</option>
                            </select>
                            <button type="button" class="btn btn-success" onclick="addCustomAssetToEvent(${eventId})" 
                                    style="padding: 8px 16px; white-space: nowrap;">
                                Add Custom Asset
                            </button>
                        </div>
                    </div>

                    <!-- Current Asset Models -->
                    <div style="margin-bottom: 30px;">
                        <h4 style="color: #495057; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;">
                            <span>📦 Model Requirements</span>
                            <span class="toggle-icon" style="font-size: 14px; cursor: pointer;" onclick="toggleViewSection('all-models')">▼</span>
                        </h4>
                        <div id="all-models" style="display: block;">
                            <div id="current-asset-models" style="border: 1px solid #e9ecef; border-radius: 8px; min-height: 200px;">
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

    document.getElementById("eventDetailsContent").innerHTML = content;

    // Load available assets for the assets tab
    loadEditEventAssets(eventId);

    // Clean up any existing event listeners on the eventDetailsContent
    const eventDetailsContent = document.getElementById("eventDetailsContent");
    if (eventDetailsContent.handleModelToggle) {
      eventDetailsContent.removeEventListener(
        "click",
        eventDetailsContent.handleModelToggle
      );
    }

    // Set up event delegation for model toggle
    const handleModelToggle = function (e) {
      if (e.target.classList.contains("toggle-model-btn")) {
        e.preventDefault();
        const modelId = e.target.getAttribute("data-model-id");
        toggleModelDetailsInEdit(modelId);
      }
    };

    // Store the listener reference for cleanup
    eventDetailsContent.handleModelToggle = handleModelToggle;
    eventDetailsContent.addEventListener("click", handleModelToggle);

    openModal("eventDetailsModal");
  } catch (error) {
    showNotification("error", "Failed to load event details");
  }
}

// Switch between edit tabs
function switchEditTab(tabName) {
  // Remove active class from all tabs and content
  document.querySelectorAll(".edit-tab").forEach((tab) => {
    tab.classList.remove("active");
  });
  document.querySelectorAll(".edit-tab-content").forEach((content) => {
    content.classList.remove("active");
    content.style.display = "none";
  });

  // Add active class to clicked tab
  document.querySelector(`[data-tab="${tabName}"]`).classList.add("active");

  // Show corresponding content
  const contentDiv = document.getElementById(`edit-${tabName}-tab`);
  contentDiv.classList.add("active");
  contentDiv.style.display = "block";

  // Load assets data when assets tab is clicked
  if (tabName === "assets") {
    const eventId = document.getElementById("editEventId").value;
    if (eventId) {
      loadEditEventAssets(eventId);
    }
  }
}

async function loadEditEventAssets(eventId) {
  try {
    const [eventResponse, availableAssetsResponse, availabilityResponse] = await Promise.all([
      apiCall(`/api/events/${eventId}`),
      apiCall("/api/assets/available"),
      apiCall(`/api/events/${eventId}/availability`),
    ]);

    const event = eventResponse.data;
    const availableAssets = availableAssetsResponse.data;

    // Store for functionality
    window.currentEditAvailableAssets = availableAssets;
    window.currentEditEventId = eventId;
    window.currentEditEvent = event;
    window.currentEditAvailabilityList = availabilityResponse.data;

    // Helper function to escape HTML
    const escapeHtml = (str) => {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    };

    let content = `
            <div class="assets-edit-interface">
                <!-- Search Bar at Top -->
                <div style="background: #e8f5e8; border: 2px solid #28a745; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
                    <h4 style="color: #155724; margin: 0 0 15px 0; font-weight: 600;">🔍 Search Available Asset Models</h4>
                    <div style="display: flex; align-items: center; gap: 15px;">
                        <input type="text" class="form-input" placeholder="Search available asset models (min 2 characters)..." 
                               style="flex: 1; max-width: 500px; padding: 10px 15px; border: 1px solid #28a745; border-radius: 5px;" 
                               oninput="filterAvailableModels(this.value)">
                        <button type="button" class="btn btn-outline-secondary" onclick="clearModelSearch()" 
                                style="padding: 10px 15px; white-space: nowrap;">Clear Search</button>
                    </div>
                    <div id="available-models-container" style="margin-top: 15px; border: 1px solid #28a745; border-radius: 5px; background: white; max-height: 300px; overflow-y: auto;">
                        <div style="text-align: center; padding: 20px; color: #666; font-size: 14px;">Type to search for available asset models...</div>
                    </div>
                </div>

                <!-- Add Custom Assets Section -->
                <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
                    <h4 style="color: #856404; margin: 0 0 15px 0; font-weight: 600;">➕ Add Custom Assets</h4>
                    <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                        <input type="text" id="customAssetName" placeholder="Asset Name" 
                               style="flex: 1; min-width: 200px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                        <input type="number" id="customAssetQuantity" placeholder="Qty" min="1" value="1"
                               style="width: 60px; padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                        <select id="customAssetType" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;">
                            <option value="MISC">Misc Item</option>
                            <option value="LOAN">Loan/Rental</option>
                        </select>
                        <button type="button" class="btn btn-success" onclick="addCustomAssetToEvent(${eventId})" 
                                style="padding: 8px 16px; white-space: nowrap;">
                            Add Custom Asset
                        </button>
                    </div>
                </div>

                <!-- Current Asset Models -->
                <div style="margin-bottom: 30px;">
                    <h4 style="color: #495057; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;">
                        <span>📦 Model Requirements</span>
                        <span class="toggle-icon" style="font-size: 14px; cursor: pointer;" onclick="toggleViewSection('all-models')">▼</span>
                    </h4>
                    <div id="all-models" style="display: block;">
                        <div id="current-asset-models" style="border: 1px solid #e9ecef; border-radius: 8px; min-height: 200px;">
                            <!-- Content will be populated by updateModelRequirementsSection -->
                        </div>
                    </div>
                </div>
            </div>
        `;

    document.getElementById("edit-assets-tab").innerHTML = content;

    // IMPORTANT: Use updateModelRequirementsSection to populate the current-asset-models 
    // This ensures consistent UI with Edit/Remove buttons
    await updateModelRequirementsSection(eventId);

  } catch (error) {
    console.error("Error loading edit event assets:", error);
    showNotification("error", "Failed to load assets for editing");
  }
}

// Add custom asset to event
async function addCustomAssetToEvent(eventId) {
  const nameInput = document.getElementById("customAssetName");
  const quantityInput = document.getElementById("customAssetQuantity");
  const typeSelect = document.getElementById("customAssetType");
  
  const name = nameInput.value.trim();
  const quantity = parseInt(quantityInput.value) || 1;
  const type = typeSelect.value;
  
  if (!name) {
    showNotification("error", "Please enter a custom asset name");
    return;
  }
  
  try {
    // Create the custom asset ID based on type
    // Use semicolon format for quantities > 1: [TYPE]name;quantity
    const customAssetId = quantity > 1 ? `[${type}]${name};${quantity}` : `[${type}]${name}`;
    
    await apiCall(`/api/events/${eventId}/assets`, "POST", {
      assetId: customAssetId,
    });
    
    const quantityText = quantity > 1 ? ` (Qty: ${quantity})` : '';
    showNotification("success", `Custom asset "${name}"${quantityText} added to event`);
    
    // Clear the inputs
    nameInput.value = "";
    quantityInput.value = "1";
    
    // Update the model requirements section to show the new custom asset
    await updateModelRequirementsSection(eventId);
    
  } catch (error) {
    showNotification("error", `Failed to add custom asset: ${error.message}`);
  }
}

// Clear model search
function clearModelSearch() {
  const searchInput = document.querySelector('#edit-assets-tab input[placeholder*="Search available asset models"]');
  const container = document.getElementById("available-models-container");
  
  if (searchInput) {
    searchInput.value = "";
  }
  
  if (container) {
    container.innerHTML = '<div style="text-align: center; padding: 20px; color: #666; font-size: 14px;">Type to search for available asset models...</div>';
  }
}

// Add asset model to event (simplified)
async function addAssetModelToEvent(eventId, modelName, department) {
  try {
    // Find the first available asset of this model
    const response = await apiCall("/api/assets/available");
    const availableAssets = response.data;

    const asset = availableAssets.find(
      (a) =>
        `${a.brand} ${a.model}` === modelName && a.department === department
    );

    if (!asset) {
      showNotification("error", "No available assets of this model");
      return;
    }

    await apiCall(`/api/events/${eventId}/assets`, "POST", {
      assetId: asset.id,
    });
    showNotification("success", `${modelName} added to event`);

    // Refresh the assets view
    loadEditEventAssets(eventId);
  } catch (error) {
    showNotification("error", `Failed to add asset: ${error.message}`);
  }
}

// Switch between edit tabs
function switchEditTab(tabName) {
  // Remove active class from all tabs
  document.querySelectorAll(".edit-tab").forEach((tab) => {
    tab.classList.remove("active");
    tab.style.background = "none";
    tab.style.borderBottomColor = "transparent";
    tab.style.color = "#666";
  });

  // Remove active class from all content
  document.querySelectorAll(".edit-tab-content").forEach((content) => {
    content.style.display = "none";
  });

  // Add active class to clicked tab
  const activeTab = document.querySelector(`[data-tab="${tabName}"]`);
  if (activeTab) {
    activeTab.classList.add("active");
    activeTab.style.background = "rgba(118, 75, 162, 0.05)";
    activeTab.style.borderBottomColor = "#764ba2";
    activeTab.style.color = "#764ba2";
  }

  // Show corresponding content
  const contentDiv = document.getElementById(`edit-${tabName}-tab`);
  if (contentDiv) {
    contentDiv.style.display = "block";
  }
}

// Load available assets for editing
async function loadAvailableAssetsForEdit(eventId) {
  try {
    const [availableResponse, availabilityResponse] = await Promise.all([
      apiCall("/api/assets/available"),
      apiCall(`/api/events/${eventId}/availability`),
    ]);
    const availableAssets = availableResponse.data;

    // Store for search functionality
    window.currentEditAvailableAssets = availableAssets;
    window.currentEditEventId = eventId;
    window.currentEditAvailabilityList = availabilityResponse.data;
  } catch (error) {
    console.error("Error loading available assets:", error);
  }
}

async function addModelToEvent(eventId, brand, model, department, description) {
  try {
    // Get the quantity from the input field - use a safer method
    const cleanBrand = brand.replace(/\s+/g, "");
    const cleanModel = model.replace(/\s+/g, "");
    const qtyInputId = `qty-${cleanBrand}-${cleanModel}`;
    const qtyInput = document.getElementById(qtyInputId);
    const requestedQuantity = parseInt(qtyInput?.value) || 1;

    // Check available assets
    const availableAssets = window.currentEditAvailableAssets || [];
    const modelAssets = availableAssets.filter(
      (a) => a.brand === brand && a.model === model
    );
    const availableCount = modelAssets.length;

    // Check if this model is already assigned to the event
    let currentlyAssigned = 0;
    const modelElements = document.querySelectorAll(".model-assignment");
    for (let element of modelElements) {
      const text = element.textContent;
      if (text.includes(`${brand} ${model}`)) {
        const qtyMatch = text.match(/(\d+)x/);
        if (qtyMatch) {
          currentlyAssigned = parseInt(qtyMatch[1]);
          break;
        }
      }
    }

    // Calculate how many we can actually add
    const maxCanAdd = availableCount;

    if (requestedQuantity > maxCanAdd) {
      showNotification(
        "error",
        `Only ${maxCanAdd} ${brand} ${model} available. Try reducing the quantity.`
      );
      return;
    }

    // Add model to event
    await apiCall(`/api/events/${eventId}/models`, "POST", {
      brand: brand,
      model: model,
      department: department,
      description: description,
      quantity: requestedQuantity,
    });

    showNotification("success", `${requestedQuantity}x ${brand} ${model} added to event`);

    // Clear the quantity input
    if (qtyInput) {
      qtyInput.value = 1;
    }

    // Update available assets by removing the assigned ones
    if (window.currentEditAvailableAssets) {
      let removedCount = 0;
      window.currentEditAvailableAssets = window.currentEditAvailableAssets.filter((asset) => {
        if (asset.brand === brand && asset.model === model && removedCount < requestedQuantity) {
          removedCount++;
          return false;
        }
        return true;
      });
    }

    // IMPORTANT: Use updateModelRequirementsSection to ensure buttons are present
    await updateModelRequirementsSection(eventId);

    // Remove this model from the search results since it now has fewer available
    const currentSearchTerm = document.querySelector('#edit-assets-tab input[placeholder*="Search available asset models"]')?.value;
    if (currentSearchTerm && currentSearchTerm.length >= 2) {
      filterAvailableModels(currentSearchTerm);
    }

  } catch (error) {
    showNotification("error", `Failed to add model: ${error.message}`);
  }
}

async function updateModelRequirementsSection(eventId) {
  try {
    const eventResponse = await apiCall(`/api/events/${eventId}`);
    const event = eventResponse.data;

    const modelsContainer = document.getElementById("current-asset-models");
    if (!modelsContainer) return;

    // Helper function to escape HTML
    const escapeHtml = (str) => {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    };

    let content = '';

    // Display current model assignments
    if (event.modelGroups && Object.keys(event.modelGroups).length > 0) {
        // Group by department
        const modelsByDept = {};
        Object.values(event.modelGroups).forEach((model) => {
            if (!modelsByDept[model.department]) {
                modelsByDept[model.department] = [];
            }
            modelsByDept[model.department].push(model);
        });

        Object.keys(modelsByDept).sort().forEach((dept) => {
            const models = modelsByDept[dept];
            const totalAssigned = models.reduce((sum, model) => sum + (model.assignedAssets ? model.assignedAssets.length : 0), 0);
            const totalRequired = models.reduce((sum, model) => sum + model.requiredQuantity, 0);
            const deptInfo = getDepartmentInfo(dept);

            content += `
                <div style="background: ${deptInfo.bgColor}; padding: 12px; border-bottom: 1px solid #e9ecef; font-weight: bold;">
                    ${deptInfo.name} (${totalAssigned}/${totalRequired} assigned)
                </div>
                <div style="padding: 12px;">
            `;

            models.forEach((model) => {
                const assignedCount = model.assignedAssets ? model.assignedAssets.length : 0;
                const statusIcon = assignedCount >= model.requiredQuantity ? "✅" : "⚠️";
                
                content += `
                    <div class="model-assignment" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f1f1f1;">
                        <div style="flex: 1;">
                            <div style="display: flex; align-items: center;">
                                <span style="margin-right: 8px;">${statusIcon}</span>
                                <span style="font-weight: 500;">${model.requiredQuantity}x ${escapeHtml(model.brand)} ${escapeHtml(model.model)}</span>
                                <span style="color: #666; margin-left: 8px;">(${assignedCount} assigned)</span>
                            </div>
                            <div style="color: #666; font-size: 12px; margin-left: 20px; margin-top: 2px;">${escapeHtml(model.description || '')}</div>
                        </div>
                        <div style="display: flex; gap: 8px;">
                            <button class="btn btn-sm btn-outline-primary edit-model-qty-btn"
                                  data-event-id="${eventId}"
                                  data-brand="${escapeHtmlAttribute(model.brand)}"
                                  data-model="${escapeHtmlAttribute(model.model)}"
                                  data-department="${escapeHtmlAttribute(model.department)}"
                                  data-description="${escapeHtmlAttribute(model.description || '')}"
                                  style="padding: 4px 8px; font-size: 11px;">Edit Qty</button>

                          <button class="btn btn-sm btn-danger remove-model-btn"
                                  data-event-id="${eventId}"
                                  data-brand="${escapeHtmlAttribute(model.brand)}"
                                  data-model="${escapeHtmlAttribute(model.model)}"
                                  data-department="${escapeHtmlAttribute(model.department)}"
                                  data-description="${escapeHtmlAttribute(model.description || '')}"
                                  style="padding: 4px 8px; font-size: 11px;">Remove</button>
                        </div>
                    </div>
                `;
            });

            content += `</div>`;
        });
    }

    // Always add custom assets section, regardless of whether there are model groups
    await addCustomAssetsToModelRequirements(eventId, content);
    
  } catch (error) {
    console.error("Error updating model requirements:", error);
  }
}

// Add custom assets to existing model requirements without changing format
async function addCustomAssetsToModelRequirements(eventId, existingContent = '') {
  try {
    const eventResponse = await apiCall(`/api/events/${eventId}`);
    const event = eventResponse.data;
    const modelsContainer = document.getElementById("current-asset-models");
    
    if (!modelsContainer) return;

    // Helper function to escape HTML
    const escapeHtml = (str) => {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    };

    // Helper function to parse custom asset name and quantity
    const parseCustomAsset = (assetId, assetName) => {
      let name = assetName;
      let quantity = 1;
      
      // Check if the asset ID has quantity in format [TYPE]name;quantity
      if (assetId.includes(';')) {
        const parts = assetId.split(';');
        if (parts.length === 2) {
          quantity = parseInt(parts[1]) || 1;
          // Extract the base name from the ID
          const namePart = parts[0];
          if (namePart.startsWith('[MISC]')) {
            name = namePart.replace('[MISC]', '');
          } else if (namePart.startsWith('[LOAN]')) {
            name = namePart.replace('[LOAN]', '');
          }
        }
      }
      
      return { name, quantity };
    };

    let content = existingContent;

    // Process custom assets (those starting with [MISC] or [LOAN])
    if (event.assignedAssets) {
      const customAssets = event.assignedAssets.filter(asset => 
        asset.id && (asset.id.startsWith('[MISC]') || asset.id.startsWith('[LOAN]'))
      );

      if (customAssets.length > 0) {
        // Group custom assets by type
        const customAssetsByType = {};
        customAssets.forEach(asset => {
          const type = asset.id.startsWith('[MISC]') ? 'MISC' : 'LOAN';
          if (!customAssetsByType[type]) {
            customAssetsByType[type] = [];
          }
          customAssetsByType[type].push(asset);
        });

        // Add each type section
        Object.keys(customAssetsByType).forEach(type => {
          const assetsOfType = customAssetsByType[type];
          const deptDisplayName = type === 'LOAN' ? '🏪 Loan/Rental Items' : '🔧 Misc Items';
          
          // Calculate total quantity for this type
          let totalQuantity = 0;
          assetsOfType.forEach(asset => {
            const parsed = parseCustomAsset(asset.id, asset.name);
            totalQuantity += parsed.quantity;
          });
          
          content += `
            <div data-custom-section="true" style="border-top: 1px solid #e9ecef; margin-top: 20px; padding-top: 20px;">
              <div style="background: #f8f9fa; padding: 12px; border-bottom: 1px solid #e9ecef; font-weight: bold;">
                ${deptDisplayName} (${totalQuantity} total qty, ${assetsOfType.length} items)
              </div>
              <div style="padding: 12px;">
                ${assetsOfType.map(asset => {
                  const statusIcon = asset.status === "returned" ? "↩️" 
                                 : asset.status === "prepared" ? "✅" 
                                 : "📋";
                  const parsed = parseCustomAsset(asset.id, asset.name);
                  const displayName = parsed.quantity > 1 ? `${parsed.quantity}x ${parsed.name}` : parsed.name;
                  
                  return `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f1f1f1;">
                      <div style="display: flex; align-items: center;">
                        <span style="margin-right: 8px;">${statusIcon}</span>
                        <span style="font-weight: 500;">${escapeHtml(displayName)}</span>
                      </div>
                      <div style="display: flex; gap: 8px;">
                        <button class="btn btn-sm btn-outline-primary edit-custom-qty-btn" 
                                data-event-id="${eventId}" data-asset-id="${escapeHtml(asset.id)}" 
                                data-asset-name="${escapeHtml(parsed.name)}" data-asset-type="${type}"
                                style="padding: 4px 8px; font-size: 11px;">Edit Qty</button>
                        <button class="btn btn-danger btn-sm remove-asset-btn" 
                                data-event-id="${eventId}" data-asset-id="${escapeHtml(asset.id)}"
                                style="padding: 4px 8px; font-size: 11px;">Remove</button>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          `;
        });
      }
    }

    // If no content at all, show empty state
    if (!content.trim()) {
      content = `
        <div style="text-align: center; padding: 40px; color: #666;">
          No assets assigned to this event
        </div>
      `;
    }

    modelsContainer.innerHTML = content;
    
  } catch (error) {
    console.error("Error adding custom assets to model requirements:", error);
  }
}

async function removeModelFromEvent(eventId, brand, model, department, description = "") {
  const label = `${brand} ${model}${description ? ` (${description})` : ""}`;
  if (!confirm(`Remove ${label} from this event?`)) return;

  try {
    await apiCall(`/api/events/${eventId}/models`, "DELETE", {
      brand,
      model,
      department,
      description, // <<< critical: disambiguates G52 vs L50
    });

    showNotification("success", `${label} removed from event`);

    // Reload available assets to reflect the newly available items
    const response = await apiCall("/api/assets/available");
    window.currentEditAvailableAssets = response.data;

    // Update only the models section without disrupting the search
    await updateModelRequirementsSection(eventId);

    // Refresh the search results to show the model as available again
    const currentSearchTerm =
      document.querySelector('#edit-assets-tab input[placeholder*="Search available asset models"]')?.value;
    if (currentSearchTerm && currentSearchTerm.length >= 2) {
      filterAvailableModels(currentSearchTerm);
    }
  } catch (error) {
    showNotification("error", `Failed to remove model: ${error.message}`);
  }
}

function editModelQuantity(eventId, brand, model, department, description = "") {
  let currentQuantity = 1;

  fetch(`/api/events/${eventId}`)
    .then(r => r.json())
    .then(data => {
      const event = data.data;
      if (event.modelGroups) {
        const modelKey = Object.keys(event.modelGroups).find(key => {
          const m = event.modelGroups[key];
          return (
            m.brand === brand &&
            m.model === model &&
            m.department === department &&
            (m.description || "") === (description || "")
          );
        });

        if (modelKey) {
          const modelData = event.modelGroups[modelKey];
          currentQuantity = modelData.requiredQuantity || 1;
          populateEditQuantityModal(eventId, brand, model, department, currentQuantity, (modelData.description || ""));
        }
      }
    });
}

function populateEditQuantityModal(eventId, brand, model, department, currentQuantity, description) {
  // Calculate available assets
  const availableAssets = window.currentEditAvailableAssets || [];
  const modelAssets = availableAssets.filter(
    (a) => a.brand === brand && a.model === model
  );
  const maxQuantity = currentQuantity + modelAssets.length;

  // Populate modal
  document.getElementById("editQuantityTitle").textContent = `Edit Quantity - ${brand} ${model}`;
  document.getElementById("editQuantityLabel").textContent = `Current quantity: ${currentQuantity}`;
  document.getElementById("editQuantityInput").value = currentQuantity;
  document.getElementById("editQuantityInput").min = 1;
  document.getElementById("editQuantityInput").max = maxQuantity;
  document.getElementById("editQuantityEventId").value = eventId;
  document.getElementById("editQuantityBrand").value = brand;
  document.getElementById("editQuantityModel").value = model;
  document.getElementById("editQuantityDepartment").value = department;
  document.getElementById("editQuantityCurrentQty").value = currentQuantity;
  
  // Store the full description (add this hidden field to your HTML)
  document.getElementById("editQuantityDescription").value = description;

  validateEditQuantityInput();
  openModal("editQuantityModal");
}

// Handle blur for edit quantity modal
function handleEditQuantityBlur(maxQuantity) {
  const input = document.getElementById("editQuantityInput");
  if (!input) return;

  let value = input.value.trim();

  // If empty on blur, restore to minimum 1
  if (value === '' || isNaN(parseInt(value)) || parseInt(value) < 1) {
    input.value = 1;
    input.style.borderColor = "#28a745";
    return;
  }

  // If value exceeds maximum, set to maximum
  const numValue = parseInt(value);
  if (numValue > maxQuantity) {
    input.value = maxQuantity;
    showNotification("warning", `Maximum ${maxQuantity} available`);
  }

  validateEditQuantityInput();
}

function validateEditQuantityInput() {
  const input = document.getElementById("editQuantityInput");
  if (!input) return false;

  const maxQty = parseInt(input.max);
  let value = input.value.trim();

  // Allow empty during typing
  if (value === '') {
    input.style.borderColor = "#ddd";
    return false;
  }

  const numValue = parseInt(value);

  if (isNaN(numValue) || numValue < 1) {
    input.style.borderColor = "#dc3545";
    return false;
  }

  if (numValue > maxQty) {
    input.style.borderColor = "#dc3545";
    return false;
  }

  input.style.borderColor = "#28a745";
  return true;
}

async function updateModelQuantity(eventId, brand, model, department, newQuantity, currentQuantity, description = "") {
  try {
    // Remove the old model assignment
    await apiCall(`/api/events/${eventId}/models`, "DELETE", {
      brand: brand,
      model: model,
      department: department,
      description: description,
    });

    // Add the new model assignment with updated quantity
    await apiCall(`/api/events/${eventId}/models`, "POST", {
      brand: brand,
      model: model,
      department: department,
      description: description,
      quantity: newQuantity,
    });

    showNotification("success", `Updated ${brand} ${model} quantity to ${newQuantity}`);

    // Update available assets count
    const quantityDifference = newQuantity - currentQuantity;
    if (window.currentEditAvailableAssets) {
      const availableAssets = window.currentEditAvailableAssets;
      const modelAssets = availableAssets.filter((a) => a.brand === brand && a.model === model);

      if (quantityDifference > 0) {
        // Quantity increased - remove more assets from available
        let removedCount = 0;
        window.currentEditAvailableAssets = window.currentEditAvailableAssets.filter((asset) => {
          if (asset.brand === brand && asset.model === model && removedCount < quantityDifference) {
            removedCount++;
            return false;
          }
          return true;
        });
      } else if (quantityDifference < 0) {
        // Quantity decreased - add assets back to available
        const assetsToAddBack = Math.abs(quantityDifference);
        for (let i = 0; i < assetsToAddBack && i < modelAssets.length; i++) {
          window.currentEditAvailableAssets.push(modelAssets[i]);
        }
      }
    }

    // Only update the model requirements section to maintain consistent UI
    await updateModelRequirementsSection(eventId);

    // Refresh the search results if there's an active search
    const currentSearchTerm = document.querySelector('#edit-assets-tab input[placeholder*="Search available asset models"]')?.value;
    if (currentSearchTerm && currentSearchTerm.length >= 2) {
      filterAvailableModels(currentSearchTerm);
    }

  } catch (error) {
    showNotification("error", `Failed to update model quantity: ${error.message}`);
  }
}
function preserveModalState(callback) {
    // Save which sections are expanded
    const expandedSections = [];
    const toggleIcons = document.querySelectorAll('.toggle-icon');
    toggleIcons.forEach(icon => {
        const parent = icon.closest('[onclick*="togglePrepareSection"]');
        if (parent) {
            const onclickAttr = parent.getAttribute('onclick');
            const match = onclickAttr.match(/togglePrepareSection\('([^']+)'\)/);
            if (match) {
                const sectionId = match[1];
                const section = document.getElementById(sectionId);
                if (section && section.style.display !== 'none') {
                    expandedSections.push(sectionId);
                }
            }
        }
    });
    
    // Save scroll position
    const modalContent = document.getElementById('prepareEventContent');
    const scrollTop = modalContent ? modalContent.scrollTop : 0;
    
    // Save active tabs
    const activeTab = document.querySelector('.nav-link.active');
    const activeTabText = activeTab ? activeTab.textContent.trim() : '';
    
    // Execute the callback (usually openPrepareEventModal)
    callback();
    
    // Restore state after a short delay to allow DOM to update
    setTimeout(() => {
        // Restore expanded sections
        expandedSections.forEach(sectionId => {
            const section = document.getElementById(sectionId);
            if (section) {
                section.style.display = 'block';
                // Update toggle icon
                const toggleIcon = document.querySelector(`[onclick*="togglePrepareSection('${sectionId}')"] .toggle-icon`);
                if (toggleIcon) {
                    toggleIcon.textContent = '▼';
                }
            }
        });
        
        // Restore scroll position
        const newModalContent = document.getElementById('prepareEventContent');
        if (newModalContent) {
            newModalContent.scrollTop = scrollTop;
        }
        
        // Restore active tab
        if (activeTabText) {
            const tabs = document.querySelectorAll('.nav-link');
            tabs.forEach(tab => {
                if (tab.textContent.trim() === activeTabText) {
                    tab.click();
                }
            });
        }
    }, 100);
}

function validateEditQuantityInput() {
  const input = document.getElementById("editQuantityInput");
  const maxQty = parseInt(input.max);
  const currentQty = parseInt(
    document.getElementById("editQuantityCurrentQty").value
  );
  let value = parseInt(input.value);

  if (isNaN(value) || value < 1) {
    input.style.borderColor = "#dc3545";
    return false;
  }

  if (value > maxQty) {
    input.style.borderColor = "#dc3545";
    input.value = maxQty;
    showNotification("warning", `Maximum ${maxQty} available`);
    return false;
  }

  input.style.borderColor = "#28a745";
  return true;
}

// Filter available assets for simple interface
function filterAvailableAssetsSimple(searchTerm) {
  const container = document.getElementById("available-assets-simple");
  const availableAssets = window.currentEditAvailableAssets || [];
  const eventId = window.currentEditEventId;

  if (!searchTerm || searchTerm.length < 2) {
    container.innerHTML =
      '<p style="text-align: center; color: #666; padding: 20px;">Type at least 2 characters to search...</p>';
    return;
  }

  const filteredAssets = availableAssets.filter(
    (asset) =>
      asset.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      asset.brand.toLowerCase().includes(searchTerm.toLowerCase()) ||
      asset.model.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (asset.description &&
        asset.description.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  if (filteredAssets.length === 0) {
    container.innerHTML =
      '<p style="text-align: center; color: #666; padding: 20px;">No matching assets found.</p>';
    return;
  }

  // Group assets by model
  const assetsByModel = {};
  filteredAssets.forEach((asset) => {
    const modelKey = `${asset.brand} ${asset.model}`;
    if (!assetsByModel[modelKey]) {
      assetsByModel[modelKey] = {
        brand: asset.brand,
        model: asset.model,
        description: asset.description,
        department: asset.department,
        assets: [],
        count: 0,
      };
    }
    assetsByModel[modelKey].assets.push(asset);
    assetsByModel[modelKey].count++;
  });

  let content = "";
  Object.values(assetsByModel).forEach((modelGroup) => {
    const inputId = `qty-${modelGroup.brand.replace(
      /\s+/g,
      ""
    )}-${modelGroup.model.replace(/\s+/g, "")}`;

    content += `
            <div style="padding: 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                <div style="flex: 1;">
                    <div style="font-weight: 500; font-size: 14px;">${escapeHtml(modelGroup.brand)} ${escapeHtml(modelGroup.model)}</div>
                    <div style="color: #666; font-size: 12px; margin: 4px 0;">${escapeHtml(modelGroup.description || "")}</div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span class="asset-badge dept-${modelGroup.department.toLowerCase()}">${escapeHtml(modelGroup.department)}</span>
                        <span style="color: #28a745; font-size: 11px; font-weight: 500;">${modelGroup.count} available</span>
                    </div>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <input type="number" min="1" max="${modelGroup.count}" value="1" 
                           id="${inputId}"
                           style="width: 50px; padding: 4px; border: 1px solid #ddd; border-radius: 4px; text-align: center;"
                           onchange="validateQuantityInput('${inputId}', ${modelGroup.count})"
                           oninput="validateQuantityInput('${inputId}', ${modelGroup.count})">
                    <button class="btn btn-success add-model-btn" style="padding: 6px 12px; font-size: 11px;" 
                            data-event-id="${eventId}"
                            data-brand="${escapeHtml(modelGroup.brand)}"
                            data-model="${escapeHtml(modelGroup.model)}"
                            data-department="${escapeHtml(modelGroup.department)}"
                            data-description="${escapeHtmlAttribute(modelGroup.description || '')}"
                            data-input-id="${inputId}">
                        Add
                    </button>
                </div>
            </div>
        `;
  });

  container.innerHTML = content;
}

async function updateCurrentAssetsOnly(eventId) {
  try {
    const response = await apiCall(`/api/events/${eventId}`);
    const event = response.data;

    // Update just the current assets section
    const currentAssetsContainer = document.querySelector(
      "#edit-assets-tab > div:first-child > div:last-child"
    );
    if (!currentAssetsContainer) return;

    // Clear current assets
    currentAssetsContainer.innerHTML = "";

    // Rebuild current assets display
    if (
      event.assetsByDepartment &&
      Object.keys(event.assetsByDepartment).length > 0
    ) {
      Object.keys(event.assetsByDepartment).forEach((dept) => {
        const assets = event.assetsByDepartment[dept];

        // Create department section
        const deptHTML = `
                    <div style="background: #f8f9fa; padding: 8px 12px; font-weight: bold; border-bottom: 1px solid #e9ecef;">
                        ${dept} Department (${assets.length} assets)
                    </div>
                    <div class="dept-assets-${dept}"></div>
                `;
        currentAssetsContainer.insertAdjacentHTML("beforeend", deptHTML);

        const deptContainer = currentAssetsContainer.querySelector(
          `.dept-assets-${dept}`
        );

        assets.forEach((asset) => {
          let assetHTML = "";

          // Check if this is a model assignment
          if (asset.id && asset.id.startsWith("[MODEL]")) {
            // Parse model assignment
            try {
              const parts = asset.id.substring(7).split("|");
              if (parts.length >= 4) {
                const brand = parts[1];
                const model = parts[2];
                const quantity = parts[3];
                const description = parts[4] || "";

                assetHTML = `
                                    <div class="model-assignment" style="padding: 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center; background: #f8f9fa;">
                                        <div>
                                            <span style="font-weight: 500; color: #495057;">📦 ${quantity}x ${brand} ${model}</span>
                                            <div style="color: #666; font-size: 11px; margin-top: 2px;">${description}</div>
                                            <div style="color: #999; font-size: 10px; font-style: italic; margin-top: 2px;">Specific assets will be assigned during preparation</div>
                                        </div>
                                        <div style="display: flex; gap: 5px;">
                                            <button class="btn btn-warning" style="padding: 3px 6px; font-size: 10px;"
                                              onclick="editModelQuantity(${eventId}, '${escapeJs(brand)}', '${escapeJs(model)}', '${escapeJs(dept)}', '${escapeJs(description)}')">Edit Qty</button>

                                            <button class="btn btn-danger" style="padding: 3px 6px; font-size: 10px;"
                                              onclick="removeModelFromEvent(${eventId}, '${escapeJs(brand)}', '${escapeJs(model)}', '${escapeJs(dept)}', '${escapeJs(description)}')">Remove</button>
                                        </div>
                                    </div>
                                `;
              }
            } catch (e) {
              console.error("Error parsing model assignment:", e);
            }
          } else {
            // Regular asset
            const statusIcon =
              asset.status === "returned"
                ? "↩️"
                : asset.status === "prepared"
                ? "✅"
                : "📋";
            assetHTML = `
                            <div style="padding: 10px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <span>${statusIcon} ${asset.id} - ${asset.name}</span>
                                </div>
                                <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="removeAssetFromEvent(${eventId}, '${asset.id}')">Remove</button>
                            </div>
                        `;
          }

          if (assetHTML) {
            deptContainer.insertAdjacentHTML("beforeend", assetHTML);
          }
        });
      });
    } else {
      currentAssetsContainer.innerHTML =
        '<p style="text-align: center; color: #666; padding: 40px;">No assets assigned to this event.</p>';
    }

    // Update the total count in the header
    const assetsHeader = document.querySelector("#edit-assets-tab h4");
    if (assetsHeader) {
      assetsHeader.textContent = `Current Assets (${event.totalAssets})`;
    }
  } catch (error) {
    console.error("Error updating current assets:", error);
  }
}

function validateQuantityInput(inputId, maxAvailable) {
  const input = document.getElementById(inputId);
  if (!input) return;

  let value = input.value.trim();

  // Allow empty value during typing (don't force to 1 immediately)
  if (value === '') {
    input.style.borderColor = "#ddd";
    input.style.backgroundColor = "white";
    return;
  }

  // Parse the value
  const numValue = parseInt(value);

  // Check if value is valid number
  if (isNaN(numValue) || numValue < 1) {
    input.style.borderColor = "#dc3545";
    input.style.backgroundColor = "#fff5f5";
    return;
  }

  // Check if value exceeds maximum
  if (numValue > maxAvailable) {
    input.value = maxAvailable;
    input.style.borderColor = "#dc3545";
    input.style.backgroundColor = "#fff5f5";
    showNotification("warning", `Maximum ${maxAvailable} available`);
    return;
  }

  // Valid value
  input.style.borderColor = "#28a745";
  input.style.backgroundColor = "white";
}

// Handle when user clicks out of quantity input (blur event)
function handleQuantityBlur(inputId, maxAvailable) {
  const input = document.getElementById(inputId);
  if (!input) return;

  let value = input.value.trim();

  // If empty on blur, default to 1
  if (value === '' || isNaN(parseInt(value)) || parseInt(value) < 1) {
    input.value = 1;
    input.style.borderColor = "#28a745";
    input.style.backgroundColor = "white";
    return;
  }

  // If value exceeds maximum, set to maximum
  const numValue = parseInt(value);
  if (numValue > maxAvailable) {
    input.value = maxAvailable;
    showNotification("warning", `Maximum ${maxAvailable} available`);
  }

  // Final validation
  validateQuantityInput(inputId, maxAvailable);
}

// Handle special key behaviors for quantity input
function handleQuantityKeydown(event) {
  const input = event.target;
  
  // Allow: backspace, delete, tab, escape, enter
  if ([8, 9, 27, 13, 46].indexOf(event.keyCode) !== -1 ||
      // Allow: Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X
      (event.keyCode === 65 && event.ctrlKey === true) ||
      (event.keyCode === 67 && event.ctrlKey === true) ||
      (event.keyCode === 86 && event.ctrlKey === true) ||
      (event.keyCode === 88 && event.ctrlKey === true) ||
      // Allow: home, end, left, right
      (event.keyCode >= 35 && event.keyCode <= 39)) {
    return;
  }
  
  // Ensure that it is a number and stop the keypress
  if ((event.shiftKey || (event.keyCode < 48 || event.keyCode > 57)) && (event.keyCode < 96 || event.keyCode > 105)) {
    event.preventDefault();
  }
}

async function refreshAvailableAssetsAfterRemoval(eventId) {
  try {
    // Reload available assets
    const response = await apiCall("/api/assets/available");
    window.currentEditAvailableAssets = response.data;

    // If there's an active search, re-run it
    const searchInput = document.querySelector(
      '#edit-assets-tab input[placeholder="Search available assets..."]'
    );
    if (searchInput && searchInput.value.length >= 2) {
      filterAvailableAssetsSimple(searchInput.value);
    }
  } catch (error) {
    console.error("Error refreshing available assets:", error);
  }
}

async function addAssetToEventSimple(eventId, assetId) {
  try {
    await apiCall(`/api/events/${eventId}/assets`, "POST", { assetId });
    showNotification("success", `Asset ${assetId} added to event`);

    // Remove the asset from the available list (since it's now assigned)
    const assetElement = document
      .querySelector(
        `[onclick*="addAssetToEventSimple(${eventId}, '${assetId}')"]`
      )
      .closest("div");
    if (assetElement) {
      assetElement.remove();
    }

    // Update the current assets section by adding the new asset
    const currentAssetsContainer = document.querySelector(
      "#edit-assets-tab > div:first-child > div:last-child"
    );
    if (currentAssetsContainer) {
      // Find the asset details from the available assets
      const availableAssets = window.currentEditAvailableAssets || [];
      const asset = availableAssets.find((a) => a.id === assetId);

      if (asset) {
        // Remove "no assets" message if it exists
        const noAssetsMsg = currentAssetsContainer.querySelector("p");
        if (
          noAssetsMsg &&
          noAssetsMsg.textContent.includes("No assets assigned")
        ) {
          noAssetsMsg.remove();
        }

        // Look for existing department section by checking the text content
        let deptHeaderElement = null;
        let deptAssetsContainer = null;

        // Find all department headers
        const allHeaders = currentAssetsContainer.querySelectorAll(
          'div[style*="background: #f8f9fa"]'
        );
        for (let header of allHeaders) {
          if (header.textContent.includes(`${asset.department} Department`)) {
            deptHeaderElement = header;
            // The assets container should be the next sibling
            deptAssetsContainer = header.nextElementSibling;
            break;
          }
        }

        if (deptHeaderElement && deptAssetsContainer) {
          // Add to existing department section
          const newAssetHTML = `
                        <div style="padding: 10px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <span>📋 ${asset.id} - ${asset.brand} ${
            asset.model
          } - ${asset.description || ""}</span>
                            </div>
                            <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="removeAssetFromEvent(${eventId}, '${
            asset.id
          }')">Remove</button>
                        </div>
                    `;
          deptAssetsContainer.insertAdjacentHTML("beforeend", newAssetHTML);

          // Update department count
          const currentCount = parseInt(
            deptHeaderElement.textContent.match(/\((\d+) assets?\)/)[1]
          );
          deptHeaderElement.textContent = `${asset.department} Department (${
            currentCount + 1
          } assets)`;
        } else {
          // Create new department section
          const deptHTML = `
                        <div style="background: #f8f9fa; padding: 8px 12px; font-weight: bold; border-bottom: 1px solid #e9ecef;">
                            ${asset.department} Department (1 assets)
                        </div>
                        <div class="dept-assets-${asset.department}">
                            <div style="padding: 10px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <span>📋 ${asset.id} - ${asset.brand} ${
            asset.model
          } - ${asset.description || ""}</span>
                                </div>
                                <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="removeAssetFromEvent(${eventId}, '${
            asset.id
          }')">Remove</button>
                            </div>
                        </div>
                    `;
          currentAssetsContainer.insertAdjacentHTML("beforeend", deptHTML);
        }
      }
    }

    // Update the total asset count
    const assetsHeader = document.querySelector("#edit-assets-tab h4");
    if (assetsHeader) {
      const currentText = assetsHeader.textContent;
      const match = currentText.match(/\((\d+)\)/);
      if (match) {
        const currentCount = parseInt(match[1]);
        assetsHeader.textContent = `Current Assets (${currentCount + 1})`;
      }
    }

    // Remove the asset from our available assets array so it won't show up in future searches
    if (window.currentEditAvailableAssets) {
      window.currentEditAvailableAssets =
        window.currentEditAvailableAssets.filter((a) => a.id !== assetId);
    }
  } catch (error) {
    showNotification("error", `Failed to add asset: ${error.message}`);
  }
}

async function assignSpecificAsset(eventId, assetId, brand, model) {
    console.log(`=== assignSpecificAsset CALLED ===`);
    console.log('eventId:', eventId, 'assetId:', assetId, 'brand:', brand, 'model:', model);
    
    try {
        await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId });
        showNotification('success', `Assigned ${assetId} to event`);
        
        console.log('About to refresh modal with state preservation...');
        // Refresh modal while preserving UI state
        setTimeout(() => {
            preserveModalState(() => {
                openPrepareEventModal(eventId);
            });
        }, 200);
        
        // Also refresh other views if they're active
        setTimeout(() => {
            if (document.getElementById('prepare-section').classList.contains('active')) {
                loadPrepareEvents();
            }
            if (document.getElementById('dashboard-section').classList.contains('active')) {
                loadDashboard();
            }
            if (document.getElementById('events-section').classList.contains('active')) {
                loadAllEvents();
            }
        }, 700);
        
    } catch (error) {
        console.error('Error in assignSpecificAsset:', error);
        showNotification('error', `Failed to assign asset: ${error.message}`);
    }
}

async function unassignSpecificAsset(eventId, assetId, brand, model) {
  try {
    // Use the new unassign-specific endpoint
    await apiCall(`/api/events/${eventId}/unassign-specific`, "POST", {
      assetId,
    });
    showNotification("success", `Unassigned ${assetId} from event`);

    // Refresh the preparation modal
    setTimeout(() => {
      openPrepareEventModal(eventId);
    }, 500);
  } catch (error) {
    showNotification("error", `Failed to unassign asset: ${error.message}`);
  }
}

function finishEventPreparation(eventId) {
    closeModal('prepareEventModal');
    showNotification('success', 'Event preparation completed');
    
    // Force refresh multiple views
    setTimeout(() => {
        if (document.getElementById('prepare-section').classList.contains('active')) {
            loadPrepareEvents();
        }
        if (document.getElementById('dashboard-section').classList.contains('active')) {
            loadDashboard();
        }
        if (document.getElementById('events-section').classList.contains('active')) {
            loadAllEvents();
        }
    }, 500);
}
function getDepartmentInfo(dept) {
  const deptInfo = {
    AX: { name: "Audio", color: "#007bff", bgColor: "#cce5ff" },
    LX: { name: "Lighting", color: "#28a745", bgColor: "#d4edda" },
    VX: { name: "Video", color: "#6f42c1", bgColor: "#e2d9f3" },
    UN: { name: "Unknown", color: "#6c757d", bgColor: "#e2e3e5" },
  };
  return deptInfo[dept] || { name: dept, color: "#6c757d", bgColor: "#e2e3e5" };
}

async function addAssetToEvent(eventId, assetId) {
  try {
    await apiCall(`/api/events/${eventId}/assets`, "POST", { assetId });
    showNotification("success", `Asset ${assetId} added to event`);

    // Refresh the edit modal
    loadEditEventAssets(eventId);
  } catch (error) {
    showNotification("error", `Failed to add asset: ${error.message}`);
  }
}

async function removeAssetFromEvent(eventId, assetId) {
    console.log('=== removeAssetFromEvent CALLED ===');
    console.log('eventId:', eventId, 'assetId:', assetId);
    
    try {
        let endpoint;
        
        // Use different endpoints for custom vs regular assets
        if (assetId.startsWith('[MISC]') || assetId.startsWith('[LOAN]')) {
            endpoint = `/api/events/${eventId}/custom-assets/remove`;
            console.log('Using custom asset removal endpoint');
        } else {
            endpoint = `/api/events/${eventId}/remove-asset`;
            console.log('Using regular asset removal endpoint');
        }
        
        console.log('Making POST request to:', endpoint);
        console.log('Request body:', { assetId: assetId });
        
        const response = await apiCall(endpoint, 'POST', { assetId: assetId });
        
        if (response.success) {
            console.log('Asset removed successfully');
            
            // Remove the asset element from UI
            const assetElements = document.querySelectorAll(`[data-asset-id="${assetId}"]`);
            assetElements.forEach(element => {
                const assetRow = element.closest('div[style*="display: flex"]');
                if (assetRow) {
                    assetRow.remove();
                }
            });
            
            // Update the model requirements section to reflect changes
            await updateModelRequirementsSection(eventId);
            
            alert(`Asset ${assetId} removed successfully`);
        } else {
            throw new Error(response.error || 'Failed to remove asset');
        }
        
    } catch (error) {
        console.error('Error removing asset from event:', error);
        alert(`Error removing asset: ${error.message}`);
    }
}

function filterAvailableModels(searchTerm) {
  const container = document.getElementById("available-models-container");
  const availableAssets = window.currentEditAvailableAssets || [];
  const eventId = window.currentEditEventId;
  const availabilityList = window.currentEditAvailabilityList || [];

  if (!container) {
    console.error("Available models container not found");
    return;
  }

  if (!searchTerm || searchTerm.length < 2) {
    container.innerHTML =
      '<div style="text-align: center; color: #666; padding: 20px;">Type at least 2 characters to search...</div>';
    return;
  }

  // Group ALL non-missing/OOC assets by model (physical pool)
  const modelGroups = {};
  availableAssets.forEach(asset => {
    const modelKey = `${asset.department}|${asset.brand}|${asset.model}|${escapeJs(asset.description || '')}`;
    if (!modelGroups[modelKey]) {
      modelGroups[modelKey] = {
        department: asset.department,
        brand: asset.brand,
        model: asset.model,
        description: asset.description || '',
        count: 0,     // physical count
        assets: []
      };
    }
    modelGroups[modelKey].count += 1;
    modelGroups[modelKey].assets.push(asset);
  });

  // Filter models by search
  const searchLower = searchTerm.toLowerCase();
  const filteredModels = Object.values(modelGroups).filter(model => {
    const searchableText = `${model.brand} ${model.model} ${model.description}`.toLowerCase();
    return searchableText.includes(searchLower);
  });

  if (filteredModels.length === 0) {
    container.innerHTML = '<div style="text-align: center; color: #666; padding: 20px;">No matching asset models found.</div>';
    return;
  }

  const adjustedAvailFor = (m) => {
    const list = window.currentEditAvailabilityList || [];

    // 1) try exact 4-tuple match (dept, brand, model, desc)
    let entry = list.find(e =>
      e.department === m.department &&
      e.brand === m.brand &&
      e.model === m.model &&
      (e.description || '') === (m.description || '')
    );
    if (entry) {
      return {
        adjusted: (entry.available ?? 0),     // per-description display value from backend
        physical: (entry.physical ?? m.count) // per-description physical from backend
      };
    }

    // 2) fall back to 3-tuple match (dept, brand, model) ignoring description
    entry = list.find(e =>
      e.department === m.department &&
      e.brand === m.brand &&
      e.model === m.model
    );
    if (entry) {
      // We must never exceed this card’s own physical count
      const display = Math.max(0, Math.min(entry.adjustedGlobal ?? entry.available ?? 0, m.count));
      return { adjusted: display, physical: m.count };
    }

    // 3) final fallback: show physical only
    return { adjusted: m.count, physical: m.count };
  };

  let html = '';
  filteredModels.slice(0, 20).forEach(model => {
    const cleanBrand = model.brand.replace(/\s+/g, "");
    const cleanModel = model.model.replace(/\s+/g, "");
    const qtyInputId = `qty-${cleanBrand}-${cleanModel}`;

    const { adjusted, physical } = adjustedAvailFor(model);
    const displayCount = Math.max(0, adjusted);
    const color = adjusted < 1 ? '#dc3545' : '#28a745'; // RED if fewer than 1 remaining

    html += `
      <div style="padding: 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
        <div style="flex: 1;">
          <div style="font-weight: 500; margin-bottom: 4px;">${model.brand} ${model.model}</div>
          <div style="color: #666; font-size: 13px; margin-bottom: 2px;">${model.description}</div>
          <div style="font-size: 12px; color: ${color};">${displayCount} available</div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px;">
          <!-- IMPORTANT: we keep max bound to PHYSICAL so we do NOT prevent adding when adjusted < 1 -->
          <input type="number" id="${qtyInputId}" min="1" max="${physical}" value="1"
                 style="width: 60px; padding: 4px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px;"
                 oninput="validateQuantityInput('${qtyInputId}', ${physical})"
                 onblur="handleQuantityBlur('${qtyInputId}', ${physical})"
                 onkeydown="handleQuantityKeydown(event)">
          <button class="btn btn-primary add-model-btn" style="padding: 6px 12px; font-size: 12px;"
                  data-event-id="${eventId}" data-brand="${model.brand}" data-model="${model.model}"
                  data-department="${model.department}" data-description="${escapeHtmlAttribute(model.description)}">
            Add
          </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// Toggle model details in edit interface
function toggleModelDetailsInEdit(modelId) {
  const detailsDiv = document.getElementById(modelId);
  const toggleIcon = document.querySelector(`[onclick*="${modelId}"] .toggle-icon`);

  if (detailsDiv && toggleIcon) {
    if (detailsDiv.style.display === "none") {
      detailsDiv.style.display = "block";
      toggleIcon.textContent = "▲";
    } else {
      detailsDiv.style.display = "none";
      toggleIcon.textContent = "▼";
    }
  }
}

async function deleteEvent(eventId) {
  if (
    !confirm(
      "Are you sure you want to delete this event? This action cannot be undone."
    )
  ) {
    return;
  }

  try {
    await apiCall(`/api/events/${eventId}`, "DELETE");
    showNotification("success", "Event deleted successfully");

    // Refresh the current view
    if (
      document.getElementById("dashboard-section").classList.contains("active")
    ) {
      loadDashboard();
    } else if (
      document.getElementById("events-section").classList.contains("active")
    ) {
      loadAllEvents();
    }
  } catch (error) {
    showNotification("error", "Failed to delete event");
  }
}

async function viewAsset(assetId) {
  const asset = assets.find((a) => a.id === assetId);
  if (!asset) {
    showNotification("error", "Asset not found");
    return;
  }

  document.getElementById(
    "assetDetailsTitle"
  ).textContent = `Asset ${asset.id}`;

  const content = `
        <div class="form-group">
            <strong>Brand:</strong> ${asset.brand}
        </div>
        <div class="form-group">
            <strong>Model:</strong> ${asset.model}
        </div>
        <div class="form-group">
            <strong>Serial Number:</strong> ${asset.serial || "N/A"}
        </div>
        <div class="form-group">
            <strong>Description:</strong> ${asset.description || "N/A"}
        </div>
        <div class="form-group">
            <strong>Department:</strong> <span class="asset-badge dept-${asset.department.toLowerCase()}">${
    asset.department
  }</span>
        </div>
        <div class="form-group">
            <strong>Status:</strong> <span class="asset-badge status-${
              asset.status
            }">${asset.status}</span>
        </div>
        <div class="form-group">
            <strong>Current Location:</strong> ${asset.location || "Store"}
        </div>
        <div class="form-group">
            <strong>Missing:</strong> ${asset.isMissing ? "Yes" : "No"}
        </div>
        <div class="form-group" style="display: flex; align-items: center; gap: 15px;">
            <strong>Out of Commission:</strong>
            <label class="ooc-toggle">
                <input type="checkbox" ${asset.isOOC ? 'checked' : ''} 
                       onchange="toggleOOCStatus('${asset.id}', this.checked)"
                       ${asset.status === 'deployed' ? 'disabled title="Cannot change OOC status while asset is deployed"' : ''}>
                <span class="ooc-slider"></span>
            </label>
            <span style="color: ${asset.isOOC ? '#dc3545' : '#28a745'}; font-weight: 500;">
                ${asset.isOOC ? 'Out of Commission' : 'In Service'}
            </span>
        </div>
        <div class="form-group" style="margin-top: 20px;">
            <button class="btn btn-primary" onclick="viewMaintenanceLog('${asset.id}')">
                View Maintenance Log
            </button>
            <button class="btn btn-warning" onclick="closeModal('assetDetailsModal'); openMaintenanceModalForAsset('${asset.id}')">
                Log Maintenance
            </button>
        </div>
    `;

  document.getElementById("assetDetailsContent").innerHTML = content;
  openModal("assetDetailsModal");
}

async function refreshAssetsTabContent(eventId) {
  try {
    const response = await apiCall(`/api/events/${eventId}`);
    const event = response.data;

    // Update the current assets section
    let currentAssetsHTML = "";
    if (
      event.assetsByDepartment &&
      Object.keys(event.assetsByDepartment).length > 0
    ) {
      Object.keys(event.assetsByDepartment).forEach((dept) => {
        const assets = event.assetsByDepartment[dept];
        currentAssetsHTML += `
                        <div style="background: #f8f9fa; padding: 8px 12px; font-weight: bold; border-bottom: 1px solid #e9ecef;">
                            ${dept} Department (${assets.length} assets)
                        </div>
                    `;
        assets.forEach((asset) => {
          const statusIcon =
            asset.status === "returned"
              ? "↩️"
              : asset.status === "prepared"
              ? "✅"
              : "📋";
          currentAssetsHTML += `
                            <div style="padding: 10px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <span>${statusIcon} ${asset.id} - ${asset.name}</span>
                                </div>
                                ${generateRemoveButton(event.id, asset.id)}
                            </div>
                        `;
        });
      });
    } else {
      currentAssetsHTML =
        '<p style="text-align: center; color: #666; padding: 40px;">No assets assigned to this event.</p>';
    }

    // Update the current assets container
    const currentAssetsContainer = document.querySelector(
      "#edit-assets-tab > div:first-child > div:last-child"
    );
    if (currentAssetsContainer) {
      currentAssetsContainer.innerHTML = currentAssetsHTML;
    }

    // Update the asset count in the header
    const assetsHeader = document.querySelector("#edit-assets-tab h4");
    if (assetsHeader) {
      assetsHeader.textContent = `Current Assets (${event.totalAssets})`;
    }

    // Clear the search and results
    const searchInput = document.querySelector(
      '#edit-assets-tab input[placeholder="Search available assets..."]'
    );
    if (searchInput) {
      searchInput.value = "";
    }
    const resultsContainer = document.getElementById("available-assets-simple");
    if (resultsContainer) {
      resultsContainer.innerHTML =
        '<p style="text-align: center; color: #666; padding: 20px;">Type to search for available assets...</p>';
    }

    // Reload available assets
    await loadAvailableAssetsForEdit(eventId);
  } catch (error) {
    console.error("Error refreshing assets tab:", error);
    showNotification("error", "Failed to refresh assets list");
  }
}

// Form handlers
document.addEventListener("DOMContentLoaded", function () {
  // Add Event Form
  document
    .getElementById("addEventForm")
    .addEventListener("submit", async function (e) {
      e.preventDefault();

      const eventData = {
        name: document.getElementById("eventName").value,
        startDate: document.getElementById("eventStartDate").value,
        endDate: document.getElementById("eventEndDate").value,
        tag: document.getElementById("eventTag").value,
      };

      try {
        await apiCall("/api/events", "POST", eventData);
        closeModal("addEventModal");
        showNotification("success", "Event added successfully!");

        // Refresh the current view
        if (
          document
            .getElementById("dashboard-section")
            .classList.contains("active")
        ) {
          loadDashboard();
        } else if (
          document.getElementById("events-section").classList.contains("active")
        ) {
          loadAllEvents();
        }

        // Reset form
        document.getElementById("addEventForm").reset();
      } catch (error) {
        showNotification("error", "Failed to add event");
      }
    });

  // Add Asset Form
  document
    .getElementById("addAssetForm")
    .addEventListener("submit", async function (e) {
      e.preventDefault();

      const assetData = {
        brand: document.getElementById("assetBrand").value,
        model: document.getElementById("assetModel").value,
        serial: document.getElementById("assetSerial").value,
        description: document.getElementById("assetDescription").value,
        department: document.getElementById("assetDepartment").value,
      };

      try {
        await apiCall("/api/assets", "POST", assetData);
        closeModal("addAssetModal");
        showNotification("success", "Asset added successfully!");

        // Refresh inventory if we're on that page
        if (
          document
            .getElementById("inventory-section")
            .classList.contains("active")
        ) {
          loadInventory();
        }

        // Refresh dashboard stats
        loadDashboard();

        // Reset form
        document.getElementById("addAssetForm").reset();
      } catch (error) {
        showNotification("error", "Failed to add asset");
      }
    });

  // Event delegation for assign and unassign buttons
  document.addEventListener('click', function(e) {
      if (e.target.classList.contains('assign-btn')) {
          e.preventDefault();
          const eventId = e.target.getAttribute('data-event-id');
          const assetId = e.target.getAttribute('data-asset-id');
          const brand = e.target.getAttribute('data-brand');
          const model = e.target.getAttribute('data-model');
          
          if (eventId && assetId && brand && model) {
              assignSpecificAsset(parseInt(eventId), assetId, brand, model);
          }
      }
      
      if (e.target.classList.contains('unassign-btn')) {
          e.preventDefault();
          const eventId = e.target.getAttribute('data-event-id');
          const assetId = e.target.getAttribute('data-asset-id');
          const brand = e.target.getAttribute('data-brand');
          const model = e.target.getAttribute('data-model');
          
          if (eventId && assetId && brand && model) {
              unassignSpecificAsset(parseInt(eventId), assetId, brand, model);
          }
      }

      if (e.target.classList.contains('add-model-btn')) {
          e.preventDefault();
          const eventId = parseInt(e.target.getAttribute('data-event-id'));
          const brand = e.target.getAttribute('data-brand');
          const model = e.target.getAttribute('data-model');
          const department = e.target.getAttribute('data-department');
          const description = e.target.getAttribute('data-description');
          
          if (eventId && brand && model && department) {
              addModelToEvent(eventId, brand, model, department, description);
          }
      }

      if (e.target.classList.contains('edit-model-qty-btn')) {
          e.preventDefault();
          const eventId = parseInt(e.target.getAttribute('data-event-id'));
          const brand = e.target.getAttribute('data-brand');
          const model = e.target.getAttribute('data-model');
          const department = e.target.getAttribute('data-department');
          
          if (eventId && brand && model && department) {
              const description = e.target.getAttribute('data-description') || '';
              editModelQuantity(eventId, brand, model, department, description);
          }
      }
    
    if (e.target.classList.contains('remove-model-btn')) {
      e.preventDefault();
      const eventId = parseInt(e.target.getAttribute('data-event-id'));
      const brand = e.target.getAttribute('data-brand');
      const model = e.target.getAttribute('data-model');
      const department = e.target.getAttribute('data-department');
      const description = e.target.getAttribute('data-description') || '';

      if (eventId && brand && model && department) {
          removeModelFromEvent(eventId, brand, model, department, description);
      }
    }
    
    if (e.target.classList.contains('remove-asset-btn')) {
        e.preventDefault();
        const eventId = parseInt(e.target.getAttribute('data-event-id'));
        const assetId = e.target.getAttribute('data-asset-id');
        
        if (eventId && assetId) {
            removeAssetFromEvent(eventId, assetId);
        }
    }

    if (e.target.classList.contains('edit-custom-qty-btn')) {
        e.preventDefault();
        const eventId = parseInt(e.target.getAttribute('data-event-id'));
        const assetId = e.target.getAttribute('data-asset-id');
        const assetName = e.target.getAttribute('data-asset-name');
        const assetType = e.target.getAttribute('data-asset-type');
        
        if (eventId && assetId && assetName && assetType) {
            editCustomAssetQuantity(eventId, assetId, assetName, assetType);
        }
    }
  });

  // Handle edit event form submission dynamically
  document.addEventListener("submit", async function (e) {
    if (e.target.id === "editEventDetailsForm") {
      e.preventDefault();

      const eventId = document.getElementById("editEventId").value;
      const eventData = {
        name: document.getElementById("editEventName").value,
        startDate: document.getElementById("editEventStartDate").value,
        endDate: document.getElementById("editEventEndDate").value,
        tag: document.getElementById("editEventTag").value,
      };

      try {
        await apiCall(`/api/events/${eventId}`, "PUT", eventData);
        closeModal("eventDetailsModal");
        showNotification("success", "Event updated successfully!");

        // Refresh the current view
        if (
          document
            .getElementById("dashboard-section")
            .classList.contains("active")
        ) {
          loadDashboard();
        } else if (
          document.getElementById("events-section").classList.contains("active")
        ) {
          loadAllEvents();
        }

        // Also refresh prepare section if it's active
        if (
          document.getElementById("prepare-section").classList.contains("active")
        ) {
          loadPrepareEvents();
        }
      } catch (error) {
        showNotification("error", "Failed to update event");
      }
    }
  });

  // Prepare Asset Form
  const prepareAssetForm = document.getElementById("prepareAssetForm");
  if (prepareAssetForm) {
    prepareAssetForm.addEventListener("submit", async function (e) {
      e.preventDefault();

      const eventIdEl = document.getElementById("prepareEventId");
      const assetIdEl = document.getElementById("prepareAssetId");

      if (!eventIdEl || !assetIdEl) {
        console.error("Prepare asset form elements not found");
        showNotification("error", "Form not properly loaded");
        return;
      }

      const eventId = eventIdEl.value;
      const assetId = assetIdEl.value;

      try {
        await apiCall(`/api/events/${eventId}/prepare`, "POST", { assetId });
        closeModal("prepareAssetModal");
        showNotification("success", "Asset prepared successfully!");

        // Refresh prepare events view
        if (
          document
            .getElementById("prepare-section")
            .classList.contains("active")
        ) {
          loadPrepareEvents();
        }

        // Reset form
        prepareAssetForm.reset();
      } catch (error) {
        showNotification("error", "Failed to prepare asset");
      }
    });
  }

  // Return Asset Form
  document
    .getElementById("returnAssetForm")
    .addEventListener("submit", async function (e) {
      e.preventDefault();

      const eventId = document.getElementById("returnEventId").value;
      const assetId = document.getElementById("returnAssetId").value;

      try {
        await apiCall(`/api/events/${eventId}/return`, "POST", { assetId });
        closeModal("returnAssetModal");
        showNotification("success", "Asset returned successfully!");

        // Refresh return events view
        if (
          document.getElementById("return-section").classList.contains("active")
        ) {
          loadReturnEvents();
        }

        // Reset form
        document.getElementById("returnAssetForm").reset();
      } catch (error) {
        showNotification("error", "Failed to return asset");
      }
    });

  // Transfer Asset Form
  document
    .getElementById("transferForm")
    .addEventListener("submit", async function (e) {
      e.preventDefault();

      const assetId = document.getElementById("transferAssetId").value;
      const fromEventId = document.getElementById("transferFromEvent").value;
      const toEventId = document.getElementById("transferToEvent").value;

      if (fromEventId === toEventId) {
        showNotification(
          "error",
          "Source and destination events cannot be the same"
        );
        return;
      }

      try {
        await apiCall(`/api/events/${toEventId}/transfer`, "POST", {
          assetId,
          fromEventId: parseInt(fromEventId),
        });
        closeModal("transferModal");
        showNotification("success", "Asset transferred successfully!");

        // Refresh transfer view
        if (
          document
            .getElementById("transfer-section")
            .classList.contains("active")
        ) {
          loadTransferHistory();
        }

        // Reset form
        document.getElementById("transferForm").reset();
      } catch (error) {
        showNotification("error", "Failed to transfer asset");
      }
    });

  // Bulk OOC Clear Form
  const bulkOOCForm = document.getElementById("bulkOOCForm");
  if (bulkOOCForm) {
    bulkOOCForm.addEventListener("submit", async function (e) {
      e.preventDefault();

      if (selectedOOCAssets.size === 0) {
        showNotification("warning", "Please select at least one asset");
        return;
      }

      const logEntry = document.getElementById("bulkOOCLogEntry").value.trim();
      const maintenanceDate = document.getElementById("bulkOOCMaintenanceDate").value;
      const newLocation = document.getElementById("bulkOOCNewLocation").value.trim();

      if (!logEntry) {
        showNotification("warning", "Please enter a maintenance description");
        return;
      }

      if (!maintenanceDate) {
        showNotification("warning", "Please select a maintenance date");
        return;
      }

      try {
        let successCount = 0;
        let errorCount = 0;
        const errors = [];
        
        // Process each selected asset
        for (const assetId of selectedOOCAssets) {
          try {
            // Get serial number updates if any
            const serialInput = document.getElementById(`newSerial_${assetId.replace(/[^a-zA-Z0-9]/g, '_')}`);
            const newSerial = serialInput ? serialInput.value.trim() : '';
            
            const maintenanceData = {
              logEntry,
              maintenanceDate, // Include the selected date
              newLocation: newLocation || "Store",
              markOOC: false,
              unmarkOOC: true,  // Clear OOC status
              markMissing: false,
              unmarkMissing: true,  // Clear Missing status
              newSerial: newSerial || null
            };
            
            // Encode the asset ID for the URL
            const encodedAssetId = encodeURIComponent(assetId);
            await apiCall(`/api/assets/${encodedAssetId}/maintain`, "POST", maintenanceData);
            successCount++;
          } catch (error) {
            console.error(`Failed to clear status for ${assetId}:`, error);
            errorCount++;
            errors.push(`${assetId}: ${error.message}`);
          }
        }

        closeModal("bulkOOCModal");
        
        if (successCount > 0) {
          const locationText = newLocation ? `and moved to ${newLocation}` : "and moved to Store";
          showNotification("success", `Cleared OOC/Missing status for ${successCount} asset${successCount > 1 ? 's' : ''} ${locationText}`);
        }
        
        if (errorCount > 0) {
          showNotification("error", `Failed to clear status for ${errorCount} asset${errorCount > 1 ? 's' : ''}`);
        }

        // Refresh the OOC list
        loadOOCAssets();
        
        // Clear selections
        selectedOOCAssets.clear();
        updateBulkOOCButton();

        // Refresh other views if they're active
        if (document.getElementById("inventory-section").classList.contains("active")) {
          loadInventory();
        }

      } catch (error) {
        showNotification("error", "Failed to clear status");
        console.error("Bulk status clear error:", error);
      }
    });
  }

  // Maintenance Form
  const maintenanceForm = document.getElementById("maintenanceForm");
  if (maintenanceForm) {
    maintenanceForm.addEventListener("submit", async function (e) {
      e.preventDefault();

      if (selectedMaintenanceAssets.size === 0) {
        showNotification("warning", "Please select at least one asset");
        return;
      }

      const logEntry = document.getElementById("maintenanceLogEntry").value.trim();
      const maintenanceDate = document.getElementById("maintenanceDate").value;
      const newLocation = document.getElementById("maintenanceNewLocation").value.trim();

      const newSerialElement = document.getElementById("maintenanceNewSerial");
      const newSerial = newSerialElement ? newSerialElement.value.trim() : '';
      
      // Get asset status from radio buttons
      const statusEl = document.querySelector('input[name="assetStatus"]:checked');
      
      if (!statusEl) {
        showNotification("warning", "Please select a status option");
        return;
      }
      
      const statusValue = statusEl.value;

      if (!logEntry) {
        showNotification("warning", "Please enter a maintenance log entry");
        return;
      }

      if (!maintenanceDate) {
        showNotification("warning", "Please select a maintenance date");
        return;
      }

      try {
        let successCount = 0;
        let errorCount = 0;
        const errors = [];
        
        // Process each selected asset
        for (const assetId of selectedMaintenanceAssets) {
          try {
            const maintenanceData = {
              logEntry: logEntry,
              maintenanceDate: maintenanceDate,
              newLocation: newLocation || null,
              newSerial: newSerial || null,
              markOOC: statusValue === 'ooc',
              unmarkOOC: statusValue === 'clearooc',
              markMissing: statusValue === 'missing',
              unmarkMissing: statusValue === 'clearmissing'
            };
            
            // Encode the asset ID for the URL
            const encodedAssetId = encodeURIComponent(assetId);
            await apiCall(`/api/assets/${encodedAssetId}/maintain`, "POST", maintenanceData);
            successCount++;
          } catch (error) {
            console.error(`Failed to log maintenance for ${assetId}:`, error);
            errorCount++;
            errors.push(`${assetId}: ${error.message}`);
          }
        }

        closeModal("maintenanceModal");
        
        if (successCount > 0) {
          let statusMessage = "";
          if (statusValue === 'ooc') {
            statusMessage = " and marked as OOC";
          } else if (statusValue === 'missing') {
            statusMessage = " and marked as Missing";
          }
          showNotification("success", `Maintenance logged for ${successCount} asset${successCount > 1 ? 's' : ''}${statusMessage}`);
        }
        
        if (errorCount > 0) {
          console.error('Maintenance errors:', errors);
          showNotification("error", `Failed to log maintenance for ${errorCount} asset${errorCount > 1 ? 's' : ''}. Check console for details.`);
        }

        // Update assets data without refreshing search results
        try {
          const assetsResponse = await apiCall('/api/assets');
          if (assetsResponse.success) {
            assets = assetsResponse.data;
          }
        } catch (error) {
          console.error('Failed to refresh assets data:', error);
        }

        // Only refresh views if user is not actively searching
        const maintenanceSearchInput = document.getElementById("maintenance-search");
        const assetSearchInput = document.getElementById("asset-search");
        const isMaintenanceSearchActive = maintenanceSearchInput && maintenanceSearchInput.value.trim().length > 0;
        const isAssetSearchActive = assetSearchInput && assetSearchInput.value.trim().length > 0;

        // Refresh maintenance view if it's active and no search is active
        if (document.getElementById("maintenance-section").classList.contains("active") && !isMaintenanceSearchActive) {
          loadMaintenanceAssets();
        }

        // Refresh inventory view if it's active and no search is active  
        if (document.getElementById("inventory-section").classList.contains("active") && !isAssetSearchActive) {
          loadInventory();
        }

        // Clear selections
        selectedMaintenanceAssets.clear();
        updateSelectedAssetsDisplay();

      } catch (error) {
        showNotification("error", "Failed to log maintenance");
        console.error("Maintenance error:", error);
      }
    });
  }

  // Single OOC Clear Form
  document
    .getElementById("singleOOCForm")
    .addEventListener("submit", async function (e) {
      e.preventDefault();
      await processSingleOOCClear();
    });

  // Maintenance search functionality
  const maintenanceSearch = document.getElementById("maintenance-search");
  if (maintenanceSearch) {
    maintenanceSearch.addEventListener("input", function (e) {
      const searchTerm = e.target.value.toLowerCase();
      const filteredAssets = assets.filter(
        (asset) =>
          asset.id.toLowerCase().includes(searchTerm) ||
          asset.brand.toLowerCase().includes(searchTerm) ||
          asset.model.toLowerCase().includes(searchTerm) ||
          (asset.description &&
            asset.description.toLowerCase().includes(searchTerm))
      );

      displayMaintenanceAssets(filteredAssets);
    });
  }

  // Search functionality
  const eventSearch = document.getElementById("event-search");
  if (eventSearch) {
    eventSearch.addEventListener("input", function (e) {
      const searchTerm = e.target.value.toLowerCase();
      const filteredEvents = events.filter(
        (event) =>
          event.name.toLowerCase().includes(searchTerm) ||
          event.state.toLowerCase().includes(searchTerm)
      );

      const container = document.getElementById("all-events");
      container.innerHTML = "";
      filteredEvents.forEach((event) => {
        container.appendChild(createEventCard(event));
      });
    });
  }

  const assetSearch = document.getElementById("asset-search");
  if (assetSearch) {
    assetSearch.addEventListener("input", function (e) {
      const searchTerm = e.target.value.toLowerCase();
      const filteredAssets = assets.filter(
        (asset) =>
          asset.id.toLowerCase().includes(searchTerm) ||
          asset.brand.toLowerCase().includes(searchTerm) ||
          asset.model.toLowerCase().includes(searchTerm) ||
          (asset.description &&
            asset.description.toLowerCase().includes(searchTerm))
      );

      displayInventoryTable(filteredAssets);
    });
  }

  // Maintenance Asset Search functionality  
  const maintenanceAssetSearch = document.getElementById("maintenanceAssetSearch");
  if (maintenanceAssetSearch) {
    maintenanceAssetSearch.addEventListener("input", function (e) {
      searchMaintenanceAssets();
    });
    
    // Add Enter key handler for direct asset ID selection
    maintenanceAssetSearch.addEventListener("keypress", async function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        const searchTerm = e.target.value.trim();
        if (!searchTerm) return;

        if (!assets || assets.length === 0) {
          showNotification('error', 'Assets not loaded yet');
          return;
        }

        // exact asset match first
        const asset = assets.find(a =>
          a.id.toLowerCase() === searchTerm.toLowerCase() ||
          (a.serial && a.serial.toLowerCase() === searchTerm.toLowerCase())
        );

        if (asset) {
          if (!selectedMaintenanceAssets.has(asset.id)) {
            selectAssetForMaintenance(asset.id);
            e.target.value = '';
          } else {
            showNotification('warning', `Asset ${asset.id} is already selected`);
          }
          return;
        }

        // ---------- NEW: container match ----------
        try {
          const container = await getContainerById(searchTerm, true);
          if (!container) {
            showNotification('error', `Asset/Container '${searchTerm}' not found`);
            return;
          }

          let added = 0;
          let already = 0;

          for (const aid of (container.assetIds || [])) {
            if (!selectedMaintenanceAssets.has(aid)) {
              selectAssetForMaintenance(aid);
              added++;
            } else {
              already++;
            }
          }

          e.target.value = '';
          showNotification('success', `Added container ${container.id}: ${added} added (${already} already selected)`);

        } catch (err) {
          showNotification('error', `Failed to load container: ${err.message}`);
        }
      }
    });
  }

  fetch("/api/stats")
    .then((response) => {
      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }
      return response.json();
    })
    .then((data) => {
      if (data && data.success) {
        // Initialize application
        initializeApp();
      }
    })
    .catch((error) => {
      console.error("Authentication check failed:", error);
      // Still try to initialize in case of network issues
      initializeApp();
    });

  // Add to the existing event delegation
  document.addEventListener('click', function(e) {
      
      if (e.target.classList.contains('select-maintenance-btn')) {
          e.preventDefault();
          e.stopPropagation();
          const assetId = e.target.getAttribute('data-asset-id');
          if (assetId) {
              selectAssetForMaintenance(assetId);
          }
      }
      
      if (e.target.classList.contains('maintenance-asset-item')) {
          const assetId = e.target.getAttribute('data-asset-id');
          if (assetId) {
              selectAssetForMaintenance(assetId);
          }
      }
        // Container selector (used in Containers create/edit modal)
      const containerSelectBtn = e.target.closest && e.target.closest('.select-container-btn');
      if (containerSelectBtn) {
        e.preventDefault();
        e.stopPropagation();
        const assetId = containerSelectBtn.getAttribute('data-asset-id');
        if (assetId) {
          selectAssetForContainer(assetId);
        }
      }

      const containerItem = e.target.closest && e.target.closest('.container-asset-item');
      if (containerItem) {
        const assetId = containerItem.getAttribute('data-asset-id');
        if (assetId) {
          selectAssetForContainer(assetId);
        }
      }
  });
  
  // Edit Quantity Form
  document.addEventListener("submit", async function (e) {
    if (e.target.id === "editQuantityForm") {
      e.preventDefault();

      const eventId = parseInt(document.getElementById("editQuantityEventId").value);
      const newQuantity = parseInt(document.getElementById("editQuantityInput").value);
      const currentQuantity = parseInt(document.getElementById("editQuantityCurrentQty").value);

      // Check if this is a custom asset edit
      const isCustomAsset = e.target.dataset.customAsset === "true";

      if (isCustomAsset) {
        // Handle custom asset quantity update
        const oldAssetId = document.getElementById("editQuantityBrand").value; // Asset ID stored here
        const assetName = document.getElementById("editQuantityModel").value;
        const assetType = document.getElementById("editQuantityDepartment").value;

        await updateCustomAssetQuantity(eventId, oldAssetId, assetName, assetType, newQuantity);
        
        // Clear the custom asset flag
        delete e.target.dataset.customAsset;
      } else {
          // Handle regular model quantity update
          const brand = document.getElementById("editQuantityBrand").value;
          const model = document.getElementById("editQuantityModel").value;
          const department = document.getElementById("editQuantityDepartment").value;
          const description = document.getElementById("editQuantityDescription").value;
          
          await updateModelQuantity(eventId, brand, model, department, newQuantity, currentQuantity, description);
        }

      closeModal("editQuantityModal");
    }
  });

function openMaintenanceModalForAsset(assetId) {
  // Ensure the modal is opened first
  openMaintenanceModal();
  
  // Pre-select the asset after a short delay to ensure DOM is ready
  setTimeout(() => {
    if (assets && assets.length > 0) {
      selectAssetForMaintenance(assetId);
    } else {
      console.warn('Assets not loaded yet, cannot pre-select asset');
    }
  }, 200);
}

// Global variable to store selected assets for maintenance
let selectedMaintenanceAssets = new Set();

function openMaintenanceModal() {
  // Check if elements exist before trying to use them
  const logEntryEl = document.getElementById('maintenanceLogEntry');
  const newLocationEl = document.getElementById('maintenanceNewLocation');
  const maintenanceDateEl = document.getElementById('maintenanceDate');
  const assetSearchEl = document.getElementById('maintenanceAssetSearch');
  const availableAssetsEl = document.getElementById('availableMaintenanceAssets');
  
  if (!logEntryEl || !newLocationEl || !maintenanceDateEl || !assetSearchEl || !availableAssetsEl) {
    console.error('Maintenance modal elements not found');
    showNotification('error', 'Maintenance modal not properly loaded');
    return;
  }
  
  // Clear previous selections
  selectedMaintenanceAssets.clear();
  updateSelectedAssetsDisplay();
  
  // Clear form
  logEntryEl.value = '';
  newLocationEl.value = '';
  
  // Set current date as default
  const today = new Date().toISOString().split('T')[0];
  maintenanceDateEl.value = today;
  
  // Reset status radio button to "no change"
  const noChangeRadio = document.querySelector('input[name="assetStatus"][value="nochange"]');
  if (noChangeRadio) noChangeRadio.checked = true;
  
  assetSearchEl.value = '';
  
  // Clear search results
  availableAssetsEl.innerHTML = 
    '<div style="padding: 20px; text-align: center; color: #666;">Type to search for assets...</div>';
  
  openModal('maintenanceModal');
}

function openMaintenanceModalForAsset(assetId) {
  // Ensure the modal is opened first
  openMaintenanceModal();
  
  // Pre-select the asset after a short delay to ensure DOM is ready
  setTimeout(() => {
    if (assets && assets.length > 0) {
      selectAssetForMaintenance(assetId);
    } else {
      console.warn('Assets not loaded yet, cannot pre-select asset');
    }
  }, 200);
}

function searchMaintenanceAssets() {
  const searchEl = document.getElementById('maintenanceAssetSearch');
  const container = document.getElementById('availableMaintenanceAssets');
  
  if (!searchEl || !container) {
    console.error('Search elements not found');
    return;
  }
  
  const searchTerm = searchEl.value.toLowerCase().trim();
  
  if (!searchTerm || searchTerm.length < 2) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">Type at least 2 characters to search...</div>';
    return;
  }
  
  if (!assets || assets.length === 0) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No assets loaded. Please refresh the page.</div>';
    return;
  }
  
  // Filter assets based on search term
  const filteredAssets = assets.filter(asset => {
    const searchableText = `${asset.id} ${asset.brand} ${asset.model} ${asset.serial || ''} ${escapeJs(asset.description || '')}`.toLowerCase();
    return searchableText.includes(searchTerm) && !selectedMaintenanceAssets.has(asset.id);
  });
  
  if (filteredAssets.length === 0) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No matching assets found.</div>';
    return;
  }
  
  let html = '';
  filteredAssets.slice(0, 50).forEach(asset => { // Limit to 50 results
    const statusBadge = getAssetStatusBadge(asset);
    const locationText = asset.location || 'Store';
    
    html += `
      <div class="maintenance-asset-item" style="padding: 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center; cursor: pointer; transition: background-color 0.2s;"
           onmouseover="this.style.backgroundColor='#f8f9fa'" 
           onmouseout="this.style.backgroundColor='white'"
           data-asset-id="${escapeHtml(asset.id)}">
        <div style="flex: 1;">
          <div style="font-weight: 500; margin-bottom: 4px;">${escapeHtml(asset.id)}</div>
          <div style="color: #666; font-size: 13px; margin-bottom: 2px;">${escapeHtml(asset.brand)} ${escapeHtml(asset.model)}</div>
          <div style="color: #999; font-size: 12px;">${escapeJs(asset.description || '')}</div>
          <div style="margin-top: 4px;">
            ${statusBadge}
            <span style="color: #999; font-size: 11px; margin-left: 8px;">📍 ${escapeHtml(locationText)}</span>
          </div>
        </div>
        <button class="btn btn-primary select-maintenance-btn" style="padding: 6px 12px; font-size: 12px;" data-asset-id="${escapeHtml(asset.id)}">
          Select
        </button>
      </div>
    `;
  });
  
  container.innerHTML = html;
}

function getAssetStatusBadge(asset) {
  let statusClass = 'status-available';
  let statusText = 'Available';
  
  if (asset.status === 'missing') {
    statusClass = 'status-missing';
    statusText = 'Missing';
  } else if (asset.status === 'ooc') {
    statusClass = 'status-ooc';
    statusText = 'OOC';
  } else if (asset.status === 'deployed') {
    statusClass = 'status-deployed';
    statusText = 'Deployed';
  }
  
  return `<span class="asset-badge ${statusClass}">${statusText}</span>`;
}

function selectAssetForMaintenance(assetId) {
  if (!assets || assets.length === 0) {
    showNotification('error', 'Assets not loaded');
    return;
  }
  
  const asset = assets.find(a => a.id === assetId);
  if (!asset) {
    showNotification('error', `Asset ${assetId} not found`);
    return;
  }
  
  selectedMaintenanceAssets.add(assetId);
  updateSelectedAssetsDisplay();
  
  // Clear search results and show a message
  const searchContainer = document.getElementById('availableMaintenanceAssets');
  if (searchContainer) {
    searchContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">Asset pre-selected. You can search for additional assets to add to this maintenance session.</div>';
  }
  
  showNotification('success', `Selected ${assetId} for maintenance`);
}

function removeAssetFromMaintenance(assetId) {
  selectedMaintenanceAssets.delete(assetId);
  updateSelectedAssetsDisplay();
  
  // Refresh search results
  searchMaintenanceAssets();
  
  showNotification('info', `Removed ${assetId} from selection`);
}

function updateSelectedAssetsDisplay() {
  const countElement = document.getElementById('selectedAssetsCount');
  const listElement = document.getElementById('selectedAssetsList');
  
  if (!countElement || !listElement) {
    console.error('Selected assets display elements not found');
    return;
  }
  
  countElement.textContent = selectedMaintenanceAssets.size;
  
  if (selectedMaintenanceAssets.size === 0) {
    listElement.innerHTML = '<span style="color: #666; font-style: italic;">No assets selected</span>';
    return;
  }
  
  let html = '<div style="display: flex; flex-wrap: wrap; gap: 8px;">';
  selectedMaintenanceAssets.forEach(assetId => {
    const asset = assets ? assets.find(a => a.id === assetId) : null;
    if (asset) {
      html += `
        <div style="background: #e7f3ff; border: 1px solid #b3d9ff; border-radius: 6px; padding: 6px 10px; display: flex; align-items: center; gap: 8px; font-size: 13px;">
          <span style="font-weight: 500;">${assetId}</span>
          <span style="color: #666;">- ${asset.brand} ${asset.model}</span>
          <button onclick="removeAssetFromMaintenance('${assetId}')" style="background: none; border: none; color: #999; cursor: pointer; padding: 0; margin-left: 4px; font-size: 14px;" title="Remove">×</button>
        </div>
      `;
    } else {
      html += `
        <div style="background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 6px; padding: 6px 10px; display: flex; align-items: center; gap: 8px; font-size: 13px;">
          <span style="font-weight: 500;">${assetId}</span>
          <span style="color: #666;">- Asset not found</span>
          <button onclick="removeAssetFromMaintenance('${assetId}')" style="background: none; border: none; color: #999; cursor: pointer; padding: 0; margin-left: 4px; font-size: 14px;" title="Remove">×</button>
        </div>
      `;
    }
  });
  html += '</div>';
  
  listElement.innerHTML = html;
}

function searchMaintenanceAssets() {
  const searchEl = document.getElementById('maintenanceAssetSearch');
  const container = document.getElementById('availableMaintenanceAssets');
  
  if (!searchEl || !container) {
    console.error('Search elements not found');
    return;
  }
  
  const searchTerm = searchEl.value.toLowerCase().trim();
  
  if (!searchTerm || searchTerm.length < 2) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">Type at least 2 characters to search...</div>';
    return;
  }
  
  if (!assets || assets.length === 0) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No assets loaded. Please refresh the page.</div>';
    return;
  }
  
  // Filter assets based on search term
  const filteredAssets = assets.filter(asset => {
    const searchableText = `${asset.id} ${asset.brand} ${asset.model} ${asset.serial || ''} ${escapeJs(asset.description || '')}`.toLowerCase();
    return searchableText.includes(searchTerm) && !selectedMaintenanceAssets.has(asset.id);
  });
  
  if (filteredAssets.length === 0) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No matching assets found.</div>';
    return;
  }
  
  let html = '';
  filteredAssets.slice(0, 50).forEach(asset => { // Limit to 50 results
    const statusBadge = getAssetStatusBadge(asset);
    const locationText = asset.location || 'Store';
    
    html += `
      <div style="padding: 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center; cursor: pointer; transition: background-color 0.2s;"
           onmouseover="this.style.backgroundColor='#f8f9fa'" 
           onmouseout="this.style.backgroundColor='white'"
           onclick="selectAssetForMaintenance('${asset.id}')">
        <div style="flex: 1;">
          <div style="font-weight: 500; margin-bottom: 4px;">${asset.id}</div>
          <div style="color: #666; font-size: 13px; margin-bottom: 2px;">${asset.brand} ${asset.model}</div>
          <div style="color: #999; font-size: 12px;">${escapeJs(asset.description || '')}</div>
          <div style="margin-top: 4px;">
            ${statusBadge}
            <span style="color: #999; font-size: 11px; margin-left: 8px;">📍 ${locationText}</span>
          </div>
        </div>
        <button class="btn btn-primary" style="padding: 6px 12px; font-size: 12px;" onclick="event.stopPropagation(); selectAssetForMaintenance('${asset.id}')">
          Select
        </button>
      </div>
    `;
  });
  
  container.innerHTML = html;
}

function getAssetStatusBadge(asset) {
  let statusClass = 'status-available';
  let statusText = 'Available';
  
  if (asset.status === 'missing') {
    statusClass = 'status-missing';
    statusText = 'Missing';
  } else if (asset.status === 'ooc') {
    statusClass = 'status-ooc';
    statusText = 'OOC';
  } else if (asset.status === 'deployed') {
    statusClass = 'status-deployed';
    statusText = 'Deployed';
  }
  
  return `<span class="asset-badge ${statusClass}">${statusText}</span>`;
}

function selectAssetForMaintenance(assetId) {
  if (!assets || assets.length === 0) {
    showNotification('error', 'Assets not loaded');
    return;
  }
  
  const asset = assets.find(a => a.id === assetId);
  if (!asset) {
    showNotification('error', `Asset ${assetId} not found`);
    return;
  }
  
  selectedMaintenanceAssets.add(assetId);
  updateSelectedAssetsDisplay();
  
  // Remove from search results
  searchMaintenanceAssets();
  
  showNotification('success', `Selected ${assetId} for maintenance`);
}

function removeAssetFromMaintenance(assetId) {
  selectedMaintenanceAssets.delete(assetId);
  updateSelectedAssetsDisplay();
  
  // Refresh search results
  searchMaintenanceAssets();
  
  showNotification('info', `Removed ${assetId} from selection`);
}

function updateSelectedAssetsDisplay() {
  const countElement = document.getElementById('selectedCount');
  const listElement = document.getElementById('selectedAssetsList');
  
  if (!countElement || !listElement) {
    console.error('Selected assets display elements not found');
    return;
  }
  
  countElement.textContent = selectedMaintenanceAssets.size;
  
  if (selectedMaintenanceAssets.size === 0) {
    listElement.innerHTML = '<span style="color: #666; font-style: italic;">No assets selected</span>';
    return;
  }
  
  let html = '<div style="display: flex; flex-wrap: wrap; gap: 8px;">';
  selectedMaintenanceAssets.forEach(assetId => {
    const asset = assets ? assets.find(a => a.id === assetId) : null;
    if (asset) {
      html += `
        <div style="background: #e7f3ff; border: 1px solid #b3d9ff; border-radius: 6px; padding: 6px 10px; display: flex; align-items: center; gap: 8px; font-size: 13px;">
          <span style="font-weight: 500;">${assetId}</span>
          <span style="color: #666;">- ${asset.brand} ${asset.model}</span>
          <button onclick="removeAssetFromMaintenance('${assetId}')" style="background: none; border: none; color: #999; cursor: pointer; padding: 0; margin-left: 4px; font-size: 14px;" title="Remove">×</button>
        </div>
      `;
    } else {
      html += `
        <div style="background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 6px; padding: 6px 10px; display: flex; align-items: center; gap: 8px; font-size: 13px;">
          <span style="font-weight: 500;">${assetId}</span>
          <span style="color: #666;">- Asset not found</span>
          <button onclick="removeAssetFromMaintenance('${assetId}')" style="background: none; border: none; color: #999; cursor: pointer; padding: 0; margin-left: 4px; font-size: 14px;" title="Remove">×</button>
        </div>
      `;
    }
  });
  html += '</div>';
  
  listElement.innerHTML = html;
}

// Global variable for selected OOC assets
let selectedOOCAssets = new Set();

function switchMaintenanceTab(tabName) {
  // Remove active class from all tabs
  document.querySelectorAll(".maintenance-tab").forEach((tab) => {
    tab.classList.remove("active");
    tab.style.background = "none";
    tab.style.borderBottomColor = "transparent";
    tab.style.color = "#666";
  });

  // Remove active class from all content
  document.querySelectorAll(".maintenance-content").forEach((content) => {
    content.classList.remove("active");
    content.style.display = "none";
  });

  // Add active class to clicked tab
  const activeTab = document.querySelector(`[data-tab="${tabName}"]`);
  if (activeTab) {
    activeTab.classList.add("active");
    activeTab.style.background = "rgba(118, 75, 162, 0.05)";
    activeTab.style.borderBottomColor = "#764ba2";
    activeTab.style.color = "#764ba2";
  }

  // Show corresponding content
  const contentDiv = document.getElementById(`${tabName}-assets-maintenance`);
  if (contentDiv) {
    contentDiv.classList.add("active");
    contentDiv.style.display = "block";
  }

  // Show/hide the "Log Maintenance" button based on the active tab
  const logMaintenanceBtn = document.getElementById('log-maintenance-btn');
  if (logMaintenanceBtn) {
    if (tabName === 'ooc') {
      // Hide the button in OOC/Missing tab
      logMaintenanceBtn.style.display = 'none';
    } else {
      // Show the button in All Assets tab
      logMaintenanceBtn.style.display = 'inline-block';
    }
  }

  // Load appropriate data
  if (tabName === "all") {
    loadMaintenanceAssets();
  } else if (tabName === "ooc") {
    loadOOCAssets();
  }
}

async function loadOOCAssets() {
  try {
    const response = await apiCall("/api/assets");
    const oocAndMissingAssets = response.data.filter(asset => asset.isOOC || asset.isMissing);
    
    displayOOCAssets(oocAndMissingAssets);
    
    // Set up search functionality
    const searchInput = document.getElementById("ooc-search");
    if (searchInput) {
      searchInput.removeEventListener("input", filterOOCAssets);
      searchInput.addEventListener("input", filterOOCAssets);
    }
    
  } catch (error) {
    document.getElementById("ooc-assets-list").innerHTML =
      '<p style="color: red; text-align: center;">Error loading OOC and Missing assets</p>';
  }
}

function displayOOCAssets(oocAssets) {
  const container = document.getElementById("ooc-assets-list");

  if (oocAssets.length === 0) {
    container.innerHTML =
      '<p style="text-align: center; color: #666; padding: 40px;">🎉 No assets are currently marked as Out of Commission or Missing!</p>';
    return;
  }

  let tableHTML = `
    <div style="margin-bottom: 15px; display: flex; gap: 10px; align-items: center;">
      <button id="bulk-clear-ooc-btn" class="btn btn-success" onclick="openBulkOOCModal()" style="display: none;">
        Clear Status
      </button>
    </div>
    <div class="table-responsive">
      <table class="table">
        <thead>
          <tr>
            <th style="width: 40px;">
              <input type="checkbox" id="selectAllOOCCheckbox" onchange="toggleSelectAllOOC()">
            </th>
            <th>Asset ID</th>
            <th>Brand & Model</th>
            <th>Status</th>
            <th>Location</th>
            <th>Description</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
  `;

  oocAssets.forEach(asset => {
    const isSelected = selectedOOCAssets.has(asset.id);
    const statusText = asset.isOOC && asset.isMissing ? 'OOC & Missing' : 
                     asset.isOOC ? 'Out of Commission' : 'Missing';
    const statusClass = asset.isOOC && asset.isMissing ? 'status-ooc' : 
                       asset.isOOC ? 'status-ooc' : 'status-missing';
    
    tableHTML += `
      <tr class="ooc-asset-item ${isSelected ? 'selected' : ''}" data-asset-id="${escapeHtmlAttribute(asset.id)}">
        <td>
          <input type="checkbox" class="ooc-asset-checkbox" 
                ${isSelected ? 'checked' : ''} 
                onchange="toggleOOCAssetSelection('${escapeJs(asset.id)}')">
        </td>

        <td style="font-weight: 500;">
          <a href="#"
            title="View maintenance log"
            onclick="event.preventDefault(); event.stopPropagation(); viewMaintenanceLog('${escapeJs(asset.id)}');"
            style="color: #667eea; text-decoration: underline; font-weight: 600;">
            ${asset.id}
          </a>
        </td>

        <td>${asset.brand} ${asset.model}</td>
        <td>
          <span class="asset-badge ${statusClass}">${statusText}</span>
        </td>
        <td>${asset.location || 'Store'}</td>
        <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis;">${asset.description || '-'}</td>
        <td>
          <button class="btn btn-success btn-sm" onclick="clearSingleOOC('${escapeJs(asset.id)}')" style="padding: 4px 8px; font-size: 11px;">
            Clear Status
          </button>
        </td>
      </tr>
    `;
  });

  tableHTML += `
        </tbody>
      </table>
    </div>
  `;
  
  container.innerHTML = tableHTML;
  
  // Update the button state after rendering
  updateBulkOOCButton();
}

async function toggleOOCStatus(assetId, isOOC) {
  try {
    // Find the asset in our local data
    const asset = assets.find(a => a.id === assetId);
    if (!asset) {
      showNotification('error', 'Asset not found');
      return;
    }
    
    // Check if asset is deployed
    if (asset.status === 'deployed') {
      showNotification('warning', 'Cannot change OOC status while asset is deployed');
      // Reset the toggle
      const toggle = document.querySelector(`input[onchange*="${assetId}"]`);
      if (toggle) {
        toggle.checked = asset.isOOC;
      }
      return;
    }
    
    // Prepare the maintenance data
    const actionText = isOOC ? 'Marked as Out of Commission via toggle' : 'Removed Out of Commission status via toggle';
    
    const maintenanceData = {
          logEntry,
          newLocation: newLocation || "Store",
          markOOC: false,
          unmarkOOC: true,
          markMissing: false,
          unmarkMissing: true
    };
    
    // Call the maintenance API to update OOC status
    const response = await apiCall(`/api/assets/${encodeURIComponent(assetId)}/maintain`, 'POST', maintenanceData);
    
    if (response.success) {
      // Update local asset data
      asset.isOOC = isOOC;
      
      // Show success notification
      const statusText = isOOC ? 'marked as Out of Commission' : 'removed from Out of Commission';
      showNotification('success', `${assetId} ${statusText}`);
      
      // Refresh inventory if we're on that page
      if (document.getElementById('inventory-section').classList.contains('active')) {
        // Just update the local display instead of full reload for better UX
        setTimeout(() => {
          displayFilteredInventory();
        }, 100);
      }
      
      // Refresh maintenance section if it's active
      if (document.getElementById('maintenance-section').classList.contains('active')) {
        setTimeout(() => {
          loadMaintenanceAssets();
        }, 100);
      }
      
    } else {
      showNotification('error', response.message || 'Failed to update OOC status');
      
      // Reset the toggle on error
      const toggle = document.querySelector(`input[onchange*="${assetId}"]`);
      if (toggle) {
        toggle.checked = asset.isOOC;
      }
    }
    
  } catch (error) {
    showNotification('error', `Failed to update OOC status: ${error.message}`);
    console.error('Error toggling OOC status:', error);
    
    // Reset the toggle on error
    const toggle = document.querySelector(`input[onchange*="${assetId}"]`);
    if (toggle) {
      const asset = assets.find(a => a.id === assetId);
      if (asset) {
        toggle.checked = asset.isOOC;
      }
    }
  }
}

function toggleOOCAssetSelection(assetId) {
  if (selectedOOCAssets.has(assetId)) {
    selectedOOCAssets.delete(assetId);
  } else {
    selectedOOCAssets.add(assetId);
  }
  
  updateOOCAssetDisplay();
  updateBulkOOCButton();
}

function toggleAllOOCSelection() {
  const selectAllCheckbox = document.getElementById("selectAllOOC");
  const isChecked = selectAllCheckbox.checked;
  
  // Get all currently visible OOC assets
  const oocAssetRows = document.querySelectorAll(".ooc-asset-item");
  
  if (isChecked) {
    // Select all visible assets
    oocAssetRows.forEach(row => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (checkbox && !checkbox.checked) {
        const assetId = checkbox.getAttribute('onchange').match(/'([^']+)'/)[1];
        selectedOOCAssets.add(assetId);
      }
    });
  } else {
    // Deselect all
    selectedOOCAssets.clear();
  }
  
  updateOOCAssetDisplay();
  updateBulkOOCButton();
}

function updateOOCAssetDisplay() {
  // Update individual checkboxes and row styling
  document.querySelectorAll(".ooc-asset-item").forEach(row => {
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (checkbox) {
      const assetId = checkbox.getAttribute('onchange').match(/'([^']+)'/)[1];
      const isSelected = selectedOOCAssets.has(assetId);
      
      checkbox.checked = isSelected;
      if (isSelected) {
        row.classList.add('selected');
      } else {
        row.classList.remove('selected');
      }
    }
  });
  
  // Update select all checkbox
  const selectAllCheckbox = document.getElementById("selectAllOOC");
  if (selectAllCheckbox) {
    const totalVisible = document.querySelectorAll(".ooc-asset-item").length;
    const totalSelected = selectedOOCAssets.size;
    
    selectAllCheckbox.checked = totalSelected > 0 && totalSelected === totalVisible;
    selectAllCheckbox.indeterminate = totalSelected > 0 && totalSelected < totalVisible;
  }
}

// Update the bulk OOC button state
function updateBulkOOCButton() {
  const bulkButton = document.getElementById('bulk-clear-ooc-btn');
  
  if (bulkButton) {
    const count = selectedOOCAssets.size;
    
    if (count === 0) {
      // Hide the button when no assets are selected
      bulkButton.style.display = 'none';
    } else {
      // Show the button and update text when assets are selected
      bulkButton.style.display = 'inline-block';
      bulkButton.textContent = `Clear Status (${count} selected)`;
      bulkButton.disabled = false;
      bulkButton.classList.add('btn-success');
      bulkButton.classList.remove('btn-secondary');
    }
  }
}

function filterOOCAssets() {
  const searchTerm = document.getElementById("ooc-search")?.value.toLowerCase() || "";
  const rows = document.querySelectorAll(".ooc-asset-item");
  
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    if (text.includes(searchTerm)) {
      row.style.display = "";
    } else {
      row.style.display = "none";
    }
  });
}

function openBulkOOCModal() {
  if (selectedOOCAssets.size === 0) {
    showNotification("warning", "Please select at least one asset");
    return;
  }
  
  updateSelectedOOCDisplay();
  openModal('bulkOOCModal');
}

function updateSelectedOOCDisplay() {
  const countElement = document.getElementById('selectedOOCCount');
  const containerElement = document.getElementById('selectedOOCAssets');
  const serialUpdatesContainer = document.getElementById('bulkSerialNumberUpdates');
  
  countElement.textContent = selectedOOCAssets.size;
  
  if (selectedOOCAssets.size === 0) {
    containerElement.innerHTML = '<div style="color: #666; font-style: italic;">No assets selected</div>';
    if (serialUpdatesContainer) {
      serialUpdatesContainer.innerHTML = '<div style="color: #666; font-style: italic; text-align: center;">No assets selected for serial number updates</div>';
    }
    return;
  }
  
  let html = '<div style="display: grid; gap: 8px;">';
  let serialHtml = '<div style="display: grid; gap: 8px;">';
  
  selectedOOCAssets.forEach(assetId => {
    const asset = assets ? assets.find(a => a.id === assetId) : null;
    if (asset) {
      html += `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: white; border: 1px solid #ddd; border-radius: 4px;">
          <div>
            <span style="font-weight: 500;">${assetId}</span>
            <span style="color: #666; margin-left: 10px;">${asset.brand} ${asset.model}</span>
          </div>
          <button onclick="removeFromOOCSelection('${assetId}')" style="background: none; border: none; color: #999; cursor: pointer; font-size: 16px;" title="Remove">×</button>
        </div>
      `;
      
      serialHtml += `
        <div style="display: flex; align-items: center; gap: 10px; padding: 8px; background: white; border: 1px solid #ddd; border-radius: 4px;">
          <div style="flex: 1;">
            <span style="font-weight: 500; font-size: 12px;">${assetId}</span>
            <div style="color: #666; font-size: 11px;">Current SN: ${asset.serial || 'None'}</div>
          </div>
          <input 
            type="text" 
            placeholder="New serial number" 
            id="newSerial_${assetId.replace(/[^a-zA-Z0-9]/g, '_')}"
            style="flex: 2; padding: 4px 8px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px;"
          />
        </div>
      `;
    }
  });
  html += '</div>';
  serialHtml += '</div>';
  
  containerElement.innerHTML = html;
  if (serialUpdatesContainer) {
    serialUpdatesContainer.innerHTML = serialHtml;
  }
}

function removeFromOOCSelection(assetId) {
  selectedOOCAssets.delete(assetId);
  updateSelectedOOCDisplay();
  updateOOCAssetDisplay();
  updateBulkOOCButton();
}

function clearSingleOOC(assetId) {
  // Find the asset details
  const asset = assets ? assets.find(a => a.id === assetId) : null;
  if (!asset) {
    showNotification('error', 'Asset not found');
    return;
  }
  
  // Populate the modal
  document.getElementById('singleOOCTitle').textContent = `Clear OOC Status - ${assetId}`;
  document.getElementById('singleOOCAssetId').value = assetId;
  document.getElementById('singleOOCLogEntry').value = '';
  document.getElementById('singleOOCNewLocation').value = 'Store';
  document.getElementById('singleOOCNewSerial').value = '';
  
  // Show asset info
  const assetInfoDiv = document.getElementById('singleOOCAssetInfo');
  assetInfoDiv.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px;">
      <div><strong>Asset ID:</strong> ${asset.id}</div>
      <div><strong>Brand:</strong> ${asset.brand}</div>
      <div><strong>Model:</strong> ${asset.model}</div>
      <div><strong>Current Location:</strong> ${asset.location || 'Store'}</div>
      <div><strong>Current Serial:</strong> ${asset.serial || 'None'}</div>
    </div>
    ${asset.description ? `<div style="margin-top: 8px;"><strong>Description:</strong> ${escapeJs(asset.description || '')}</div>` : ''}
  `;
  
  // Open the modal
  openModal('singleOOCModal');
}

function openBulkOOCClear() {
  // Set current date as default
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('bulkOOCMaintenanceDate').value = today;
  
  openModal('bulkOOCModal');
}

function clearSingleOOC(assetId) {
  // Find the asset details
  const asset = assets ? assets.find(a => a.id === assetId) : null;
  if (!asset) {
    showNotification('error', 'Asset not found');
    return;
  }
  
  // Set current date as default
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('singleOOCMaintenanceDate').value = today;
  
  // Populate the modal
  document.getElementById('singleOOCTitle').textContent = `Clear OOC Status - ${assetId}`;
  document.getElementById('singleOOCAssetId').value = assetId;
  document.getElementById('singleOOCLogEntry').value = '';
  document.getElementById('singleOOCNewLocation').value = 'Store';
  document.getElementById('singleOOCNewSerial').value = '';
  
  // Show asset info
  const assetInfoDiv = document.getElementById('singleOOCAssetInfo');
  assetInfoDiv.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px;">
      <div><strong>Asset ID:</strong> ${asset.id}</div>
      <div><strong>Brand:</strong> ${asset.brand}</div>
      <div><strong>Model:</strong> ${asset.model}</div>
      <div><strong>Current Location:</strong> ${asset.location || 'Store'}</div>
      <div><strong>Current Serial:</strong> ${asset.serial || 'None'}</div>
    </div>
    ${asset.description ? `<div style="margin-top: 8px;"><strong>Description:</strong> ${escapeJs(asset.description || '')}</div>` : ''}
  `;
  
  // Open the modal
  openModal('singleOOCModal');
}

async function processSingleOOCClear() {
  const assetId = document.getElementById('singleOOCAssetId').value;
  const logEntry = document.getElementById('singleOOCLogEntry').value.trim();
  const maintenanceDate = document.getElementById('singleOOCMaintenanceDate').value;
  const newLocation = document.getElementById('singleOOCNewLocation').value.trim();
  const newSerial = document.getElementById('singleOOCNewSerial').value.trim();
  
  if (!logEntry) {
    showNotification("warning", "Please enter a maintenance description");
    return;
  }
  
  if (!maintenanceDate) {
    showNotification("warning", "Please select a maintenance date");
    return;
  }
  
  if (!newLocation) {
    showNotification("warning", "Please enter a location");
    return;
  }
  
  try {
    const maintenanceData = {
      logEntry: logEntry,
      maintenanceDate: maintenanceDate, // Include the selected date
      newLocation: newLocation,
      markOOC: false,
      unmarkOOC: true,   // Clear OOC status
      markMissing: false,
      unmarkMissing: true // Clear Missing status
    };
    
    // Add serial number if provided
    if (newSerial) {
      maintenanceData.newSerial = newSerial;
    }
    
    await apiCall(`/api/assets/${encodeURIComponent(assetId)}/maintain`, "POST", maintenanceData);
    
    closeModal('singleOOCModal');
    
    let message = `Cleared OOC/Missing status for ${assetId} and moved to ${newLocation}`;
    if (newSerial) {
      message += ` (Serial updated to: ${newSerial})`;
    }
    showNotification("success", message);
    
    // Refresh the OOC list
    loadOOCAssets();
    
    // Remove from selection if it was selected
    selectedOOCAssets.delete(assetId);
    updateBulkOOCButton();
    
  } catch (error) {
    showNotification("error", `Failed to clear status: ${error.message}`);
  }
}

async function viewMaintenanceLog(assetId) {
  try {
    // Ensure we have the latest assets in memory (so this works even when called from other pages/tabs)
    if (!Array.isArray(assets) || assets.length === 0) {
      const assetsResponse = await apiCall('/api/assets');
      if (assetsResponse && assetsResponse.success) {
        assets = assetsResponse.data;
      }
    }

    // Get the asset details
    const asset = Array.isArray(assets) ? assets.find(a => a.id === assetId) : null;
    if (!asset) {
      showNotification('error', `Asset not found: ${assetId}`);
      return;
    }

    // Create and show the maintenance log modal (global-safe)
    const fn =
      (typeof window.showMaintenanceLogModal === 'function') ? window.showMaintenanceLogModal :
      (typeof showMaintenanceLogModal === 'function') ? showMaintenanceLogModal :
      null;

    if (fn) {
      fn(asset);
    } else {
      showNotification('error', 'Maintenance log modal UI is not available. Please hard refresh.');
    }

  } catch (error) {
    console.error('Error viewing maintenance log:', error);
    showNotification('error', 'Failed to load maintenance log');
  }
}

function updateStatusFromToggle(statusType, isChecked) {
  if (statusType === 'ooc') {
    const hiddenNoChange = document.getElementById('hiddenOOCNoChange');
    const hiddenMark = document.getElementById('hiddenOOCMark');
    const statusText = document.getElementById('oocStatusText');
    
    if (!hiddenNoChange || !hiddenMark || !statusText) {
      return;
    }
    
    if (isChecked) {
      hiddenMark.checked = true;
      statusText.textContent = 'Mark as Out of Commission';
      statusText.style.color = '#dc3545';
      statusText.style.fontWeight = '500';
    } else {
      hiddenNoChange.checked = true;
      statusText.textContent = 'No change';
      statusText.style.color = '#6c757d';
      statusText.style.fontWeight = 'normal';
    }
  } else if (statusType === 'missing') {
    const hiddenNoChange = document.getElementById('hiddenMissingNoChange');
    const hiddenMark = document.getElementById('hiddenMissingMark');
    const statusText = document.getElementById('missingStatusText');
    
    if (!hiddenNoChange || !hiddenMark || !statusText) {
      return;
    }
    
    if (isChecked) {
      hiddenMark.checked = true;
      statusText.textContent = 'Mark as Missing';
      statusText.style.color = '#fd7e14';
      statusText.style.fontWeight = '500';
    } else {
      hiddenNoChange.checked = true;
      statusText.textContent = 'No change';
      statusText.style.color = '#6c757d';
      statusText.style.fontWeight = 'normal';
    }
  }
}

function showMaintenanceLogModal(asset) {
  // Debug: Log the asset data to console
  // console.log('Asset maintenance logs:', asset.maintenanceLogs);
  // console.log('Total maintenance logs count:', asset.maintenanceLogs ? asset.maintenanceLogs.length : 0);
  
  // Start building modal content
  let modalContent = `
    <div class="modal" id="maintenanceLogModal" style="display: flex; align-items: center; justify-content: center;">
      <div class="modal-content" style="max-width: 1200px; width: 95%; height: 95vh; display: flex; flex-direction: column; overflow: hidden; padding: 20px;">
        <div class="modal-header" style="flex-shrink: 0; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 2px solid #eee;">
          <h3 class="modal-title">Maintenance Log - ${asset.id}</h3>
          <button class="close-btn" onclick="closeMaintenanceLogModal()">&times;</button>
        </div>
        <div class="modal-body" style="flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0;">
          <!-- Asset Info -->
          <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px; flex-shrink: 0;">
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
              <div>
                <strong>Asset ID:</strong> ${asset.id}<br>
                <strong>Brand:</strong> ${asset.brand}<br>
                <strong>Model:</strong> ${asset.model}
              </div>
              <div>
                <strong>Description:</strong> ${asset.description || 'N/A'}<br>
                <strong>Serial:</strong> ${asset.serial || 'N/A'}<br>
                <strong>Department:</strong> <span class="asset-badge dept-${asset.department.toLowerCase()}">${asset.department}</span>
              </div>
              <div>
                <strong>Status:</strong> <span class="asset-badge status-${asset.status}">${asset.status}</span><br>
                <strong>Location:</strong> ${asset.location || 'Store'}<br>
                <strong>OOC:</strong> ${asset.isOOC ? '<span style="color: #dc3545;">Yes</span>' : '<span style="color: #28a745;">No</span>'}<br>
                <strong>Missing:</strong> ${asset.isMissing ? '<span style="color: #fd7e14;">Yes</span>' : '<span style="color: #28a745;">No</span>'}
              </div>
            </div>
          </div>
          
          <!-- Maintenance Logs -->
          <div style="flex: 1; display: flex; flex-direction: column; min-height: 0;">
            <h4 style="margin-bottom: 15px; color: #495057; flex-shrink: 0;">
              Maintenance History - Total: ${asset.maintenanceLogs ? asset.maintenanceLogs.length : 0} entries
            </h4>
            <div style="flex: 1; overflow-y: scroll; border: 1px solid #e9ecef; border-radius: 8px; background: white;">
             <table style="width: 100%; border-collapse: collapse; font-size: 14px; table-layout: fixed;">
                <thead style="position: sticky; top: 0; background: #f8f9fa; z-index: 10; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                  <tr>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; text-align: left; background: #f8f9fa; width: 50px;">#</th>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; text-align: left; background: #f8f9fa; width: 110px;">Date</th>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; text-align: left; background: #f8f9fa; width: 100px;">User</th>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; text-align: left; background: #f8f9fa;">Description</th>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; text-align: left; background: #f8f9fa; width: 200px;">Status Changes</th>
                    <th style="padding: 12px; font-weight: 600; color: #495057; border-bottom: 2px solid #e9ecef; width: 50px; text-align: center; background: #f8f9fa;"></th>
                  </tr>
                </thead>
                <tbody>
  `;

  // Process maintenance logs
  if (asset.maintenanceLogs && asset.maintenanceLogs.length > 0) {
    const maintenanceData = asset.maintenanceLogs.map((log, originalIndex) => {
      const parts = log.split('\t');
      return {
        date: parts[0] || '',
        user: parts[1] || '',
        description: parts.slice(2).join('\t') || '',
        originalIndex: originalIndex // Keep track of the original index
      };
    });

    // Sort logs by date (most recent first) using proper date parsing
    const sortedData = maintenanceData.map(log => {
      // Parse the date for proper sorting
      let dateObj;
      try {
        const dateParts = log.date.split('/');
        if (dateParts.length === 3) {
          dateObj = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]));
        } else {
          dateObj = new Date(0); // Very old date if parsing fails
        }
      } catch (e) {
        dateObj = new Date(0);
      }
      
      return {
        ...log,
        dateObj: dateObj
      };
    }).sort((a, b) => b.dateObj - a.dateObj); // Sort newest first
    
    
    
    sortedData.forEach((log, displayIndex) => {
      const logId = `log_${asset.id.replace(/[^a-zA-Z0-9]/g, '_')}_${log.originalIndex}`;
      const displayNumber = displayIndex + 1;
      
      console.log(`Processing log ${displayNumber}:`, log);
      
      // Parse description and status changes
      let mainDescription = log.description;
      let statusChanges = '';

      // Only look for status changes if brackets exist
      if (log.description.includes('[') && log.description.includes(']')) {
        const statusMatch = log.description.match(/^(.*?)(\s*\[.*?\]\s*)$/s);
        if (statusMatch) {
          mainDescription = statusMatch[1].trim();
          statusChanges = statusMatch[2].trim().replace(/^\[|\]$/g, ''); // Remove the brackets
        }
      }

      // Format status changes for display
      let statusChangesDisplay = '';
      if (statusChanges) {
        const changes = statusChanges.split(',').map(change => change.trim());
        statusChangesDisplay = changes.map(change => {
          let color = '#667eea'; // Default blue
          let icon = '';
          
          // More comprehensive status change detection
          const changeLower = change.toLowerCase();
          
          if (changeLower.includes('marked ooc') || changeLower.includes('mark ooc')) {
            color = '#dc3545';
            icon = '⚠️';
          } else if (changeLower.includes('cleared ooc') || changeLower.includes('clear ooc') || changeLower.includes('removed ooc') || changeLower.includes('unmark ooc')) {
            color = '#28a745';
            icon = '✅';
          } else if (changeLower.includes('marked missing') || changeLower.includes('mark missing')) {
            color = '#fd7e14';
            icon = '❌';
          } else if (changeLower.includes('cleared missing') || changeLower.includes('clear missing') || changeLower.includes('removed missing') || changeLower.includes('unmark missing')) {
            color = '#28a745';
            icon = '✅';
          } else if (changeLower.includes('location:')) {
            color = '#17a2b8';
            icon = '📍';
          } else if (changeLower.includes('serial:')) {
            color = '#6f42c1';
            icon = '🔢';
          }
          
          return `<span style="color: ${color}; font-weight: 500; font-size: 12px; display: block; margin-bottom: 2px;">${icon} ${escapeHtml(change)}</span>`;
        }).join('');
      } else {
        statusChangesDisplay = '<span style="color: #999; font-style: italic; font-size: 12px;">No changes</span>';
      }
      
      modalContent += `
        <tr style="border-bottom: 1px solid #f1f1f1;">
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top; font-weight: 500; text-align: center;">${displayNumber}</td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top; font-size: 13px;">${log.date}</td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top; font-size: 13px;">${escapeHtml(log.user)}</td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top;">
            <div id="${logId}_display" style="display: block; cursor: pointer;" onclick="editMaintenanceLog('${asset.id}', ${log.originalIndex}, '${logId}')">
              ${escapeHtml(mainDescription)}
            </div>
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top; word-wrap: break-word; overflow-wrap: break-word; max-width: 200px;">
            ${statusChangesDisplay}
          </td>
          <td style="padding: 12px; border-bottom: 1px solid #f1f1f1; vertical-align: top; text-align: center;">
            <button 
              type="button"
              class="delete-log-btn" 
              data-asset-id="${asset.id}"
              data-log-index="${log.originalIndex}"
              data-log-id="${logId}"
              style="background: none; border: none; color: #dc3545; cursor: pointer; font-size: 16px; padding: 4px; border-radius: 3px; line-height: 1; width: 24px; height: 24px;"
              title="Delete this maintenance log"
              onmouseover="this.style.backgroundColor='#ffebee'"
              onmouseout="this.style.backgroundColor='transparent'">
              ×
            </button>
          </td>
        </tr>
      `;
    });
    
    //console.log('Finished processing all logs. Total rows added:', reversedData.length);
  } else {
    modalContent += `
      <tr>
        <td colspan="6" style="text-align: center; color: #666; padding: 30px; font-style: italic;">
          No maintenance records found for this asset.
        </td>
      </tr>
    `;
  }

  // Close the table and add action buttons
  modalContent += `
                  </tbody>
                </table>
              </div>
            </div>
            
            <!-- Action Buttons -->
            <div style="margin-top: 20px; padding-top: 15px; border-top: 2px solid #eee; text-align: center; flex-shrink: 0;">
              <button onclick="addNewLogEntryFromModal('${asset.id}')" 
                      style="background: #667eea; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-size: 14px; margin-right: 10px; cursor: pointer;">
                📝 Add New Log Entry
              </button>
              <button onclick="closeMaintenanceLogModal()" 
                      style="background: #6c757d; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-size: 14px; cursor: pointer;">
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

  // Remove existing modal if any
  const existingModal = document.getElementById('maintenanceLogModal');
  if (existingModal) {
    existingModal.remove();
  }

  // Add new modal to body
  document.body.insertAdjacentHTML('beforeend', modalContent);

  // Show modal
  const modal = document.getElementById('maintenanceLogModal');
  modal.style.display = 'flex';
  
  // Add event listener for clicking outside modal
  modal.addEventListener('click', function(e) {
    if (e.target === modal) {
      closeMaintenanceLogModal();
    }
  });
  
  // Add event listeners for delete buttons

  setTimeout(() => {
    const deleteButtons = modal.querySelectorAll('.delete-log-btn');
    console.log('Found delete buttons:', deleteButtons.length);
    
    deleteButtons.forEach((button, index) => {
      console.log(`Setting up delete button ${index}:`, button.dataset);
      
      // Remove any existing click handlers and use a single handler
      button.onclick = function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        const assetId = this.dataset.assetId;
        const logIndex = parseInt(this.dataset.logIndex);
        const logId = this.dataset.logId;
        
        console.log('Delete button clicked via onclick:', { assetId, logIndex, logId });
        deleteMaintenanceLog(assetId, logIndex, logId);
      };
    });
  }, 100);
}

if (typeof window !== 'undefined') {
  window.showMaintenanceLogModal = showMaintenanceLogModal;
}

//WHAT IS LOVE, BABY DONT HURT ME, DONT HURT ME NO MOREEE
window.viewMaintenanceLog = viewMaintenanceLog;
window.openMaintenanceModal = openMaintenanceModal;
window.switchMaintenanceTab = switchMaintenanceTab;
window.openMaintenanceModalForAsset = openMaintenanceModal;
window.clearSingleOOC = clearSingleOOC;
window.addNewLogEntryFromModal = addNewLogEntryFromModal;
window.returnSpecificAssetNew = returnSpecificAssetNew;
window.selectAssetForMaintenance = selectAssetForMaintenance;
window.removeAssetFromMaintenance = removeAssetFromMaintenance;

// Helper function to close the maintenance log modal
function closeMaintenanceLogModal() {
  const modal = document.getElementById('maintenanceLogModal');
  if (modal) {
    modal.remove();
  }
}

// Function to handle adding new log entry from the maintenance log modal
function addNewLogEntryFromModal(assetId) {
  // Close the current maintenance log modal
  closeMaintenanceLogModal();
  
  // Open the maintenance modal with the asset pre-selected
  openMaintenanceModalForAsset(assetId);
}

async function deleteMaintenanceLog(assetId, logIndex, logId) {
  console.log('Delete button clicked!');
  console.log('Parameters:', { assetId, logIndex, logId });
  
  // Show custom confirmation dialog
  const shouldDelete = await showCustomConfirm(
    'Delete Maintenance Log', 
    'Are you sure you want to delete this maintenance log entry? This action cannot be undone and will recalculate the asset status.'
  );
  
  if (!shouldDelete) {
    console.log('User cancelled deletion');
    return;
  }
  
  console.log('User confirmed deletion, proceeding...');
  
  try {
    console.log(`Attempting to delete log at index ${logIndex} for asset ${assetId}`);
    
    const encodedAssetId = encodeURIComponent(assetId);
    const url = `/api/assets/${encodedAssetId}/maintenance-log/${logIndex}`;
    console.log('API URL:', url);
    
    const response = await apiCall(url, 'DELETE');
    console.log('API Response:', response);
    
    if (response && response.success) {
      showNotification('success', 'Maintenance log deleted and asset status updated');
      
      // Force reload from server to get fresh data including updated status
      try {
        const assetsResponse = await apiCall('/api/assets');
        if (assetsResponse.success) {
          // Update the global assets array
          assets = assetsResponse.data;
          const updatedAsset = assets.find(a => a.id === assetId);
          if (updatedAsset) {
            // Close any existing edit modals first
            const editModal = document.getElementById('editMaintenanceLogModal');
            if (editModal) {
              editModal.remove();
            }
            
            // Show refreshed maintenance log modal
            showMaintenanceLogModal(updatedAsset);
          }
        } else {
          closeMaintenanceLogModal();
          showNotification('info', 'Please refresh the page to see updated logs');
        }
      } catch (reloadError) {
        console.warn('Could not reload asset data:', reloadError);
        closeMaintenanceLogModal();
        showNotification('info', 'Log deleted. Please refresh the page to see updated logs and asset status');
      }
    } else {
      console.error('API returned error or no response:', response);
      showNotification('error', (response && response.message) || 'Failed to delete maintenance log');
    }
    
  } catch (error) {
    console.error('Error deleting maintenance log:', error);
    showNotification('error', `Failed to delete maintenance log: ${error.message}`);
  }
}

// Add this improved custom confirmation function
function showCustomConfirm(title, message) {
  return new Promise((resolve) => {
    // Remove any existing confirmation modals
    const existingModal = document.getElementById('customConfirmModal');
    if (existingModal) {
      existingModal.remove();
    }
    
    // Create confirmation modal with higher z-index
    const confirmModalHTML = `
      <div id="customConfirmModal" style="
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        backdrop-filter: blur(2px);
      ">
        <div style="
          background: white;
          border-radius: 12px;
          padding: 30px;
          max-width: 450px;
          width: 90%;
          text-align: center;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.2);
          animation: confirmFadeIn 0.2s ease-out;
        ">
          <div style="
            width: 60px;
            height: 60px;
            background: #fee;
            border-radius: 50%;
            margin: 0 auto 20px auto;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            color: #dc3545;
          ">⚠️</div>
          <h3 style="
            margin: 0 0 15px 0; 
            color: #333; 
            font-size: 20px;
            font-weight: 600;
          ">${title}</h3>
          <p style="
            margin: 0 0 30px 0; 
            color: #666; 
            line-height: 1.5;
            font-size: 15px;
          ">${message}</p>
          <div style="
            display: flex; 
            gap: 15px; 
            justify-content: center;
          ">
            <button id="confirmCancel" style="
              background: #6c757d;
              color: white;
              border: none;
              padding: 12px 24px;
              border-radius: 6px;
              cursor: pointer;
              font-size: 14px;
              font-weight: 500;
              transition: background-color 0.2s;
            " onmouseover="this.style.backgroundColor='#5a6268'" 
               onmouseout="this.style.backgroundColor='#6c757d'">
              Cancel
            </button>
            <button id="confirmDelete" style="
              background: #dc3545;
              color: white;
              border: none;
              padding: 12px 24px;
              border-radius: 6px;
              cursor: pointer;
              font-size: 14px;
              font-weight: 500;
              transition: background-color 0.2s;
            " onmouseover="this.style.backgroundColor='#c82333'" 
               onmouseout="this.style.backgroundColor='#dc3545'">
              Delete
            </button>
          </div>
        </div>
      </div>
      
      <style>
        @keyframes confirmFadeIn {
          from {
            opacity: 0;
            transform: scale(0.9);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
      </style>
    `;
    
    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', confirmModalHTML);
    
    // Get modal and buttons
    const modal = document.getElementById('customConfirmModal');
    const cancelBtn = document.getElementById('confirmCancel');
    const deleteBtn = document.getElementById('confirmDelete');
    
    // Function to clean up and resolve
    const cleanup = (result) => {
      if (modal && modal.parentNode) {
        modal.remove();
      }
      document.removeEventListener('keydown', escapeHandler);
      resolve(result);
    };
    
    // Handle cancel
    cancelBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup(false);
    };
    
    // Handle delete
    deleteBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup(true);
    };
    
    // Handle click outside (only on the backdrop)
    modal.onclick = (e) => {
      if (e.target === modal) {
        cleanup(false);
      }
    };
    
    // Handle escape key
    const escapeHandler = (e) => {
      if (e.key === 'Escape') {
        cleanup(false);
      }
    };
    document.addEventListener('keydown', escapeHandler);
    
    // Focus the cancel button by default
    setTimeout(() => {
      cancelBtn.focus();
    }, 100);
  });
}

// Add this custom confirmation function
function showCustomConfirm(message) {
  return new Promise((resolve) => {
    // Create confirmation modal
    const confirmModalHTML = `
      <div id="customConfirmModal" style="
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2000;
      ">
        <div style="
          background: white;
          border-radius: 8px;
          padding: 30px;
          max-width: 400px;
          width: 90%;
          text-align: center;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        ">
          <h3 style="margin: 0 0 15px 0; color: #333;">Confirm Delete</h3>
          <p style="margin: 0 0 25px 0; color: #666; line-height: 1.4;">${message}</p>
          <div style="display: flex; gap: 15px; justify-content: center;">
            <button id="confirmCancel" style="
              background: #6c757d;
              color: white;
              border: none;
              padding: 10px 20px;
              border-radius: 5px;
              cursor: pointer;
              font-size: 14px;
            ">Cancel</button>
            <button id="confirmDelete" style="
              background: #dc3545;
              color: white;
              border: none;
              padding: 10px 20px;
              border-radius: 5px;
              cursor: pointer;
              font-size: 14px;
            ">Delete</button>
          </div>
        </div>
      </div>
    `;
    
    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', confirmModalHTML);
    
    // Get modal and buttons
    const modal = document.getElementById('customConfirmModal');
    const cancelBtn = document.getElementById('confirmCancel');
    const deleteBtn = document.getElementById('confirmDelete');
    
    // Handle cancel
    cancelBtn.onclick = () => {
      modal.remove();
      resolve(false);
    };
    
    // Handle delete
    deleteBtn.onclick = () => {
      modal.remove();
      resolve(true);
    };
    
    // Handle click outside
    modal.onclick = (e) => {
      if (e.target === modal) {
        modal.remove();
        resolve(false);
      }
    };
    
    // Handle escape key
    const escapeHandler = (e) => {
      if (e.key === 'Escape') {
        modal.remove();
        document.removeEventListener('keydown', escapeHandler);
        resolve(false);
      }
    };
    document.addEventListener('keydown', escapeHandler);
  });
}

function deleteMaintenanceLogFromModal(assetId, logIndex, logId) {
  console.log('Delete Log button clicked from modal:', { assetId, logIndex, logId });
  
  // Close the edit modal first
  const editModal = document.getElementById('editMaintenanceLogModal');
  if (editModal) {
    editModal.remove();
  }
  
  // Then call the delete function
  deleteMaintenanceLog(assetId, logIndex, logId);
}

// Toggle select all OOC assets
function toggleSelectAllOOC() {
  const selectAllCheckbox = document.getElementById('selectAllOOCCheckbox');
  const isChecked = selectAllCheckbox.checked;
  
  // Get all individual asset checkboxes
  const assetCheckboxes = document.querySelectorAll('.ooc-asset-checkbox');
  
  assetCheckboxes.forEach(checkbox => {
    const assetId = checkbox.getAttribute('data-asset-id') || 
                   checkbox.closest('[data-asset-id]')?.getAttribute('data-asset-id');
    
    if (assetId) {
      checkbox.checked = isChecked;
      
      if (isChecked) {
        selectedOOCAssets.add(assetId);
        checkbox.closest('tr')?.classList.add('selected');
      } else {
        selectedOOCAssets.delete(assetId);
        checkbox.closest('tr')?.classList.remove('selected');
      }
    }
  });
  
  updateSelectedOOCDisplay();
  updateBulkOOCButton();
}

// Toggle individual OOC asset selection
function toggleOOCAssetSelection(assetId) {
  const checkbox = document.querySelector(`.ooc-asset-checkbox[onchange*="${assetId}"]`);
  const row = checkbox?.closest('tr');
  
  if (checkbox.checked) {
    selectedOOCAssets.add(assetId);
    row?.classList.add('selected');
  } else {
    selectedOOCAssets.delete(assetId);
    row?.classList.remove('selected');
  }
  
  // Update the "select all" checkbox state
  const selectAllCheckbox = document.getElementById('selectAllOOCCheckbox');
  const allCheckboxes = document.querySelectorAll('.ooc-asset-checkbox');
  const checkedCheckboxes = document.querySelectorAll('.ooc-asset-checkbox:checked');
  
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = allCheckboxes.length > 0 && checkedCheckboxes.length === allCheckboxes.length;
    selectAllCheckbox.indeterminate = checkedCheckboxes.length > 0 && checkedCheckboxes.length < allCheckboxes.length;
  }
  
  updateSelectedOOCDisplay();
  updateBulkOOCButton();
}

// Update the selected OOC assets display
function updateSelectedOOCDisplay() {
  const countElement = document.getElementById('selectedOOCCount');
  const containerElement = document.getElementById('selectedOOCAssets');
  const serialUpdatesContainer = document.getElementById('bulkSerialNumberUpdates');
  
  if (countElement) {
    countElement.textContent = selectedOOCAssets.size;
  }
  
  if (!containerElement) return;
  
  let html = '<div style="display: flex; flex-wrap: wrap; gap: 8px;">';
  let serialHtml = '<div style="display: flex; flex-direction: column; gap: 8px;">';
  
  if (selectedOOCAssets.size === 0) {
    html = '<div style="color: #666; font-style: italic;">No assets selected</div>';
    serialHtml = '<div style="color: #666; font-style: italic;">No assets selected</div>';
  }
  
  selectedOOCAssets.forEach(assetId => {
    const asset = assets ? assets.find(a => a.id === assetId) : null;
    if (asset) {
      html += `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: white; border: 1px solid #ddd; border-radius: 4px;">
          <div>
            <span style="font-weight: 500;">${assetId}</span>
            <span style="color: #666; margin-left: 10px;">${asset.brand} ${asset.model}</span>
          </div>
          <button onclick="removeFromOOCSelection('${assetId}')" style="background: none; border: none; color: #999; cursor: pointer; font-size: 16px;" title="Remove">×</button>
        </div>
      `;
      
      serialHtml += `
        <div style="display: flex; align-items: center; gap: 10px; padding: 8px; background: white; border: 1px solid #ddd; border-radius: 4px;">
          <div style="flex: 1;">
            <span style="font-weight: 500; font-size: 12px;">${assetId}</span>
            <div style="color: #666; font-size: 11px;">Current SN: ${asset.serial || 'None'}</div>
          </div>
          <input 
            type="text" 
            placeholder="New serial number" 
            id="newSerial_${assetId.replace(/[^a-zA-Z0-9]/g, '_')}"
            style="flex: 2; padding: 4px 8px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px;"
          />
        </div>
      `;
    }
  });
  html += '</div>';
  serialHtml += '</div>';
  
  containerElement.innerHTML = html;
  if (serialUpdatesContainer) {
    serialUpdatesContainer.innerHTML = serialHtml;
  }
}});

function editCustomAssetQuantity(eventId, assetId, assetName, assetType) {
  // Parse current quantity from asset ID
  let currentQuantity = 1;
  if (assetId.includes(';')) {
    const parts = assetId.split(';');
    if (parts.length === 2) {
      currentQuantity = parseInt(parts[1]) || 1;
    }
  }

  // Populate modal - reuse the existing edit quantity modal
  document.getElementById("editQuantityTitle").textContent = `Edit Custom Asset Quantity`;
  document.getElementById("editQuantityLabel").textContent = `Editing: ${assetName} (${assetType === 'LOAN' ? 'Loan/Rental' : 'Misc'})`;
  document.getElementById("editQuantityInput").value = currentQuantity;
  document.getElementById("editQuantityInput").min = 1;
  document.getElementById("editQuantityInput").max = 999; // No limit for custom assets

  const editQtyInput = document.getElementById("editQuantityInput");
  if (editQtyInput) {
    editQtyInput.oninput = () => validateCustomAssetQuantityInput();
    editQtyInput.onblur = () => handleCustomAssetQuantityBlur();
    editQtyInput.onkeydown = (e) => handleQuantityKeydown(e);
  }

  // Show info
  const availableDiv = document.getElementById("editQuantityAvailable");
  availableDiv.innerHTML = `<span style="color: #28a745;">✅ Custom assets have no quantity limits</span>`;

  // Store values in hidden fields (repurpose existing ones)
  document.getElementById("editQuantityEventId").value = eventId;
  document.getElementById("editQuantityBrand").value = assetId; // Store full asset ID here
  document.getElementById("editQuantityModel").value = assetName;
  document.getElementById("editQuantityDepartment").value = assetType;
  document.getElementById("editQuantityCurrentQty").value = currentQuantity;

  // Mark this as custom asset edit by setting a flag
  document.getElementById("editQuantityForm").dataset.customAsset = "true";

  // Open modal
  openModal("editQuantityModal");
}

function validateCustomAssetQuantityInput() {
  const input = document.getElementById("editQuantityInput");
  if (!input) return false;

  let value = input.value.trim();

  // Allow empty during typing
  if (value === '') {
    input.style.borderColor = "#ddd";
    return false;
  }

  const numValue = parseInt(value);

  if (isNaN(numValue) || numValue < 1) {
    input.style.borderColor = "#dc3545";
    return false;
  }

  if (numValue > 999) {
    input.style.borderColor = "#dc3545";
    return false;
  }

  input.style.borderColor = "#28a745";
  return true;
}

function handleCustomAssetQuantityBlur() {
  const input = document.getElementById("editQuantityInput");
  if (!input) return;

  let value = input.value.trim();

  // If empty on blur, restore to minimum 1
  if (value === '' || isNaN(parseInt(value)) || parseInt(value) < 1) {
    input.value = 1;
    input.style.borderColor = "#28a745";
    return;
  }

  // If value exceeds maximum, set to maximum
  const numValue = parseInt(value);
  if (numValue > 999) {
    input.value = 999;
    showNotification("warning", "Maximum quantity is 999");
  }

  validateCustomAssetQuantityInput();
}

async function updateCustomAssetQuantity(eventId, oldAssetId, assetName, assetType, newQuantity) {
  try {
    console.log(`Updating custom asset quantity: ${oldAssetId} -> quantity ${newQuantity}`);
    
    // Create the update payload for a dedicated quantity update endpoint
    const updateData = {
      assetId: oldAssetId,
      newQuantity: newQuantity
    };
    
    // Try a dedicated custom asset quantity update endpoint
    await apiCall(`/api/events/${eventId}/custom-assets/update-quantity`, "PUT", updateData);
    
    console.log(`Successfully updated custom asset quantity via dedicated endpoint`);

    const quantityText = newQuantity > 1 ? ` (Qty: ${newQuantity})` : '';
    showNotification("success", `Updated "${assetName}"${quantityText} quantity to ${newQuantity}`);

    // Update the model requirements section to show the changes
    await updateModelRequirementsSection(eventId);

  } catch (error) {
    console.error("Error in updateCustomAssetQuantity:", error);
    
    // Create updateData here for the error logging
    const updateData = {
      assetId: oldAssetId,
      newQuantity: newQuantity
    };
    
    // If the dedicated endpoint doesn't exist, show a helpful error
    if (error.message.includes('Not found') || error.message.includes('404')) {
      showNotification("error", "Custom asset quantity update endpoint not available. This feature needs to be implemented on the backend.");
      console.log("Backend needs endpoint: PUT /api/events/{eventId}/custom-assets/update-quantity");
      console.log("Expected payload:", updateData);
    } else {
      showNotification("error", `Failed to update custom asset quantity: ${error.message}`);
    }
  }
}

// Remove asset from OOC selection
function removeFromOOCSelection(assetId) {
  selectedOOCAssets.delete(assetId);
  
  // Uncheck the checkbox
  const checkbox = document.querySelector(`.ooc-asset-checkbox[onchange*="${assetId}"]`);
  if (checkbox) {
    checkbox.checked = false;
    checkbox.closest('tr')?.classList.remove('selected');
  }
  
  updateSelectedOOCDisplay();
  updateOOCAssetDisplay();
  updateBulkOOCButton();
}

// Update the bulk OOC button state
function updateBulkOOCButton() {
  const bulkButton = document.getElementById('bulk-clear-ooc-btn');
  const countSpan = document.getElementById('selectedOOCCount');
  
  if (bulkButton && countSpan) {
    const count = selectedOOCAssets.size;
    bulkButton.disabled = count === 0;
    bulkButton.textContent = `Clear Status (${count} selected)`;
    
    if (count === 0) {
      bulkButton.classList.add('btn-secondary');
      bulkButton.classList.remove('btn-success');
    } else {
      bulkButton.classList.add('btn-success');
      bulkButton.classList.remove('btn-secondary');
    }
  }
}

// Update OOC asset display
function updateOOCAssetDisplay() {
  // This function updates the visual state of the OOC assets list
  const assetRows = document.querySelectorAll('[data-asset-id]');
  
  assetRows.forEach(row => {
    const assetId = row.getAttribute('data-asset-id');
    const checkbox = row.querySelector('.ooc-asset-checkbox');
    
    if (assetId && checkbox) {
      if (selectedOOCAssets.has(assetId)) {
        row.classList.add('selected');
        checkbox.checked = true;
      } else {
        row.classList.remove('selected');
        checkbox.checked = false;
      }
    }
  });
}

// Open bulk OOC modal
function openBulkOOCModal() {
  if (selectedOOCAssets.size === 0) {
    showNotification('warning', 'Please select at least one asset to clear status');
    return;
  }
  
  // Set current date as default
  const today = new Date().toISOString().split('T')[0];
  const dateField = document.getElementById('bulkOOCMaintenanceDate');
  if (dateField) {
    dateField.value = today;
  }
  
  // Update the display of selected assets
  updateSelectedOOCDisplay();
  
  openModal('bulkOOCModal');
}

// Filter OOC assets (for search functionality)
function filterOOCAssets() {
  const searchInput = document.getElementById('ooc-search');
  if (!searchInput) return;
  
  const searchTerm = searchInput.value.toLowerCase().trim();
  const assetRows = document.querySelectorAll('#ooc-assets-list tr:not(:first-child)'); // Skip header row
  
  assetRows.forEach(row => {
    const text = row.textContent.toLowerCase();
    if (text.includes(searchTerm)) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  });
}

function createMaintenanceLogTable(asset) {
  if (!asset.maintenanceLogs || asset.maintenanceLogs.length === 0) {
    return `
      <div style="text-align: center; padding: 40px; color: #666; background: #f8f9fa; border-radius: 8px;">
        <div style="font-size: 48px; margin-bottom: 10px;">🔧</div>
        <div style="font-size: 18px; margin-bottom: 5px;">No Maintenance Records</div>
        <div style="font-size: 14px;">This asset has no maintenance history yet.</div>
      </div>
    `;
  }
  
  // Sort logs by date (most recent first)
  const sortedLogs = sortMaintenanceLogsByDate(asset.maintenanceLogs);
  
  let tableHTML = `
    <div style="border: 1px solid #e9ecef; border-radius: 8px; overflow: hidden;">
      <table class="table" style="margin: 0;">
        <thead style="background: #f8f9fa;">
          <tr>
            <th style="width: 120px;">Date</th>
            <th style="width: 100px;">User</th>
            <th>Maintenance Description <small style="font-weight: normal; color: #666;">(click to edit)</small></th>
          </tr>
        </thead>
        <tbody>
  `;
  
  sortedLogs.forEach((logData, index) => {
    const parts = logData.log.split('\t');
    if (parts.length >= 3) {
      const date = parts[0];
      const user = parts[1];
      const description = parts.slice(2).join('\t'); // In case description contains tabs
      
      // Alternate row colors
      const rowClass = index % 2 === 0 ? '' : 'style="background-color: #f8f9fa;"';
      
      tableHTML += `
        <tr ${rowClass} style="cursor: pointer;" onclick="editMaintenanceLog('${asset.id}', ${logData.originalIndex}, 'log_${asset.id}_${logData.originalIndex}')">
          <td style="padding: 12px; vertical-align: top; font-weight: 500;">${date}</td>
          <td style="padding: 12px; vertical-align: top;">${user}</td>
          <td style="padding: 12px;">${description}</td>
        </tr>
      `;
    }
  });
  
  tableHTML += `
        </tbody>
      </table>
    </div>
  `;
  
  return tableHTML;
}

function sortMaintenanceLogsByDate(logs) {
  if (!logs || logs.length === 0) return [];
  
  // Parse logs and sort by date (most recent first)
  const parsedLogs = logs.map((log, index) => {
    const parts = log.split('\t');
    const dateStr = parts[0] || '';
    
    // Convert date string to Date object for proper sorting
    let dateObj;
    try {
      // Parse YYYY/MM/DD format
      const dateParts = dateStr.split('/');
      if (dateParts.length === 3) {
        dateObj = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]));
      } else {
        dateObj = new Date(0); // Very old date if parsing fails
      }
    } catch (e) {
      dateObj = new Date(0); // Very old date if parsing fails
    }
    
    return {
      log: log,
      date: dateObj,
      originalIndex: index
    };
  });
  
  // Sort by date (most recent first)
  parsedLogs.sort((a, b) => b.date - a.date);
  
  return parsedLogs;
}

function editMaintenanceLog(assetId, logIndex, logId) {
  // First, close any other editing logs
  const currentlyEditing = document.querySelectorAll('div[id$="_edit"][style*="block"]');
  currentlyEditing.forEach(editDiv => {
    const currentLogId = editDiv.id.replace('_edit', '');
    cancelEditMaintenanceLogModal(currentLogId);
  });
  
  // Get the asset data
  const asset = assets.find(a => a.id === assetId);
  if (!asset || !asset.maintenanceLogs || !asset.maintenanceLogs[logIndex]) {
    showNotification('error', 'Maintenance log not found');
    return;
  }
  
  // Parse the current log entry
  const logEntry = asset.maintenanceLogs[logIndex];
  const parts = logEntry.split('\t');
  const currentDate = parts[0] || '';
  const currentUser = parts[1] || '';
  const descriptionWithStatus = parts.slice(2).join('\t') || '';
  
  // Extract status changes from description if they exist
  let currentDescription = descriptionWithStatus;
  let existingStatusChanges = '';
  let logLocationFromThisEntry = null; 
  let hasLocationChangeInThisLog = false;

  // Only look for status changes if brackets exist
  if (descriptionWithStatus.includes('[') && descriptionWithStatus.includes(']')) {
    const statusMatch = descriptionWithStatus.match(/^(.*?)(\s*\[.*?\]\s*)$/s);
    if (statusMatch) {
      currentDescription = statusMatch[1].trim();
      existingStatusChanges = statusMatch[2].trim();
      
      // Extract location from this specific log's status changes
      const locationMatch = existingStatusChanges.match(/Location:\s*([^,\]]+)/i);
      if (locationMatch) {
        logLocationFromThisEntry = locationMatch[1].trim();
        hasLocationChangeInThisLog = true;
      }
    }
  }

  
  // Convert date format from YYYY/MM/DD to YYYY-MM-DD for HTML date input
  const dateForInput = currentDate.replace(/\//g, '-');
  
  // Determine current asset status for radio button pre-selection
  let defaultStatusValue = 'nochange';
  if (asset.isOOC && asset.isMissing) {
    defaultStatusValue = 'nochange'; // Both statuses - let user choose
  } else if (asset.isOOC) {
    defaultStatusValue = 'clearooc'; // Currently OOC, suggest clearing it
  } else if (asset.isMissing) {
    defaultStatusValue = 'clearmissing'; // Currently missing, suggest clearing it
  }
  
  // Create the enhanced edit modal
  const modalContent = `
    <div class="modal" id="editMaintenanceLogModal" style="display: flex; align-items: center; justify-content: center; z-index: 1100;">
      <div class="modal-content" style="max-width: 600px; width: 90%; max-height: 90vh; overflow-y: auto;">
        <div class="modal-header">
          <h3 class="modal-title">Edit Maintenance Log - ${assetId}</h3>
          <button class="close-btn" onclick="cancelEditMaintenanceLogModal()">&times;</button>
        </div>
        <div class="modal-body">
          <!-- Current Asset Status Display -->
          <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #667eea;">
            <h5 style="margin: 0 0 10px 0; color: #495057;">Current Asset Status</h5>
            <div style="display: flex; gap: 20px; flex-wrap: wrap;">
              <div>
                <strong>OOC:</strong> 
                <span style="color: ${asset.isOOC ? '#dc3545' : '#28a745'}; font-weight: 500;">
                  ${asset.isOOC ? 'Yes' : 'No'}
                </span>
              </div>
              <div>
                <strong>Missing:</strong> 
                <span style="color: ${asset.isMissing ? '#fd7e14' : '#28a745'}; font-weight: 500;">
                  ${asset.isMissing ? 'Yes' : 'No'}
                </span>
              </div>
              <div>
                <strong>Location:</strong> <span style="font-weight: 500;">${escapeHtml(asset.location || 'Store')}</span>
              </div>
              <div>
                <strong>Serial:</strong> <span style="font-weight: 500;">${escapeHtml(asset.serial || 'N/A')}</span>
              </div>
            </div>
            ${existingStatusChanges ? `<div style="margin-top: 10px;"><strong>Previous Changes:</strong> <span style="color: #666; font-style: italic;">${escapeHtml(existingStatusChanges)}</span></div>` : ''}
          </div>

          <form id="editMaintenanceLogForm">
            <!-- Date -->
            <div class="form-group">
              <label class="form-label">Maintenance Date</label>
              <input
                type="date"
                class="form-input"
                id="editMaintenanceDate"
                value="${dateForInput}"
                required
              />
            </div>

            <!-- User -->
            <div class="form-group">
              <label class="form-label">User</label>
              <input
                type="text"
                class="form-input"
                id="editMaintenanceUser"
                value="${escapeHtml(currentUser)}"
                required
                placeholder="Enter username"
              />
            </div>

            <!-- Description -->
            <div class="form-group">
              <label class="form-label">Maintenance Description</label>
              <textarea
                class="form-input"
                id="editMaintenanceDescription"
                rows="4"
                required
                placeholder="Describe maintenance work performed..."
              >${escapeHtml(currentDescription)}</textarea>
            </div>

            <!-- New Location -->
            <div class="form-group">
              <label class="form-label">Update Location (optional)</label>
              <input
                type="text"
                class="form-input"
                id="editMaintenanceNewLocation"
                placeholder="Leave blank to keep ${hasLocationChangeInThisLog ? 'location from this log (' + escapeHtml(logLocationFromThisEntry || 'Store') + ')' : 'no location change'}"
                value="${hasLocationChangeInThisLog ? escapeHtml(logLocationFromThisEntry || '') : ''}"
              />
            </div>

            <!-- New Serial -->
            <div class="form-group">
              <label class="form-label">Update Serial Number (optional)</label>
              <input
                type="text"
                class="form-input"
                id="editMaintenanceNewSerial"
                placeholder="Leave blank to keep current serial (${escapeHtml(asset.serial || 'N/A')})"
                value=""
              />
            </div>    

            <!-- Asset Status Changes -->
            <div class="form-group">
              <label class="form-label">Asset Status Changes</label>
              <div style="display: flex; gap: 15px; flex-wrap: wrap; margin-top: 10px;">
                <label style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 2px solid #e9ecef; border-radius: 6px; cursor: pointer; background: white;">
                  <input type="radio" name="editAssetStatus" value="nochange" ${defaultStatusValue === 'nochange' ? 'checked' : ''}>
                  <span>No Change</span>
                </label>
                <label style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 2px solid #e9ecef; border-radius: 6px; cursor: pointer; background: white;">
                  <input type="radio" name="editAssetStatus" value="ooc" ${defaultStatusValue === 'ooc' ? 'checked' : ''}>
                  <span style="color: #dc3545;">Mark as OOC</span>
                </label>
                <label style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 2px solid #e9ecef; border-radius: 6px; cursor: pointer; background: white;">
                  <input type="radio" name="editAssetStatus" value="missing" ${defaultStatusValue === 'missing' ? 'checked' : ''}>
                  <span style="color: #fd7e14;">Mark as Missing</span>
                </label>
                <label style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 2px solid #e9ecef; border-radius: 6px; cursor: pointer; background: white;">
                  <input type="radio" name="editAssetStatus" value="clearooc" ${defaultStatusValue === 'clearooc' ? 'checked' : ''}>
                  <span style="color: #28a745;">Clear OOC Status</span>
                </label>
                <label style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 2px solid #e9ecef; border-radius: 6px; cursor: pointer; background: white;">
                  <input type="radio" name="editAssetStatus" value="clearmissing" ${defaultStatusValue === 'clearmissing' ? 'checked' : ''}>
                  <span style="color: #28a745;">Clear Missing Status</span>
                </label>
              </div>
            </div>

            <!-- Form Buttons -->
            <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
              <button
                type="button"
                class="btn btn-secondary"
                onclick="cancelEditMaintenanceLogModal()"
              >
                Cancel
              </button>

              <button 
                type="button" 
                class="btn btn-danger" 
                onclick="deleteMaintenanceLogFromModal('${assetId}', ${logIndex}, '${logId}')"
                style="margin-right: auto;"
              >
                Delete Log
              </button>
              <button type="submit" class="btn btn-primary">
                Save Changes
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;

  // Remove existing edit modal if any
  const existingModal = document.getElementById('editMaintenanceLogModal');
  if (existingModal) {
    existingModal.remove();
  }

  // Add new modal to body
  document.body.insertAdjacentHTML('beforeend', modalContent);

  // Show modal
  const modal = document.getElementById('editMaintenanceLogModal');
  modal.style.display = 'flex';
  
  // Add form submit handler
  const form = document.getElementById('editMaintenanceLogForm');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveEnhancedMaintenanceLog(assetId, logIndex, logId);
  });
  
  // Add event listeners for clicking outside modal and escape key
  modal.addEventListener('click', function(e) {
    if (e.target === modal) {
      cancelEditMaintenanceLogModal();
    }
  });
  
  document.addEventListener('keydown', function escapeHandler(e) {
    if (e.key === 'Escape') {
      cancelEditMaintenanceLogModal();
      document.removeEventListener('keydown', escapeHandler);
    }
  });
}

function handleClickOutside(event) {
  // Find all currently editing textareas
  const editingTextareas = document.querySelectorAll('textarea[id$="_input"]');
  
  editingTextareas.forEach(async (textarea) => {
    const editDiv = textarea.closest('div[id$="_edit"]');
    
    // Check if click was outside this specific edit area
    if (editDiv && !editDiv.contains(event.target)) {
      const assetId = textarea.dataset.assetId;
      const logIndex = parseInt(textarea.dataset.logIndex);
      const logId = textarea.dataset.logId;
      const originalValue = textarea.dataset.originalValue;
      const currentValue = textarea.value.trim();
      
      // If value changed and is not empty, save it
      if (currentValue && currentValue !== originalValue) {
        await saveMaintenanceLogSilent(assetId, logIndex, logId);
      } else if (!currentValue) {
        // If empty, restore original and cancel
        cancelEditMaintenanceLogModal(logId);
      } else {
        // If unchanged, just cancel
        cancelEditMaintenanceLogModal(logId);
      }
    }
  });
  
  // Remove the global click listener after processing
  document.removeEventListener('click', handleClickOutside);
}

function cancelEditMaintenanceLogModal() {
  const modal = document.getElementById('editMaintenanceLogModal');
  if (modal) {
    modal.remove();
  }
}

async function saveEnhancedMaintenanceLog(assetId, logIndex, logId) {
  try {
    // Get the asset data to compare against current values
    const asset = assets.find(a => a.id === assetId);
    if (!asset) {
      showNotification('error', 'Asset not found');
      return;
    }
    
    // Get form values
    const date = document.getElementById('editMaintenanceDate').value;
    const user = document.getElementById('editMaintenanceUser').value.trim();
    const description = document.getElementById('editMaintenanceDescription').value.trim();
    const newLocation = document.getElementById('editMaintenanceNewLocation').value.trim();
    const newSerial = document.getElementById('editMaintenanceNewSerial').value.trim();
    const statusEl = document.querySelector('input[name="editAssetStatus"]:checked');
    
    if (!date || !user || !description) {
      showNotification('warning', 'Date, user, and description are required');
      return;
    }
    
    if (!statusEl) {
      showNotification('warning', 'Please select a status option');
      return;
    }
    
    const statusValue = statusEl.value;
    console.log('Status value selected:', statusValue);

    // Extract the original location from this specific log for comparison
    let originalLogLocation = null;
    let hadLocationChangeOriginally = false;
    const logEntry = asset.maintenanceLogs[logIndex];
    if (logEntry) {
      const logParts = logEntry.split('\t');
      const logDescription = logParts.slice(2).join('\t') || '';
      const locationMatch = logDescription.match(/\[.*?Location:\s*([^,\]]+)/i);
      if (locationMatch) {
        originalLogLocation = locationMatch[1].trim();
        hadLocationChangeOriginally = true;
      }
    }

    // Handle location logic
    let locationToUpdate = null;
    const newLocationClean = newLocation.trim();

    if (newLocationClean) {
      // User entered a new location - always use it
      locationToUpdate = newLocationClean;
    } else if (hadLocationChangeOriginally) {

      locationToUpdate = originalLogLocation;
    }

    // Only include serial if it's different from current serial
    let serialToUpdate = null;
    const currentSerial = asset.serial || '';
    if (newSerial !== currentSerial) {
      serialToUpdate = newSerial || null;
    }
    
    // Prepare the data for the enhanced maintenance update
    const updateData = {
      logIndex: logIndex,
      date: date,
      user: user,
      description: description,
      newLocation: locationToUpdate,
      newSerial: serialToUpdate,
      markOOC: statusValue === 'ooc',
      unmarkOOC: statusValue === 'clearooc',
      markMissing: statusValue === 'missing',
      unmarkMissing: statusValue === 'clearmissing'
    };
    
    console.log('Sending update data:', updateData);
    
    // Call the enhanced update API
    const response = await apiCall(`/api/assets/${encodeURIComponent(assetId)}/maintenance-log-enhanced/${logIndex}`, 'PUT', updateData);
    
    if (response.success) {
      showNotification('success', 'Maintenance log updated successfully');
      cancelEditMaintenanceLogModal();
      
      // Refresh the maintenance log modal
      const asset = assets.find(a => a.id === assetId);
      if (asset) {
        // Force reload from server to get fresh data
        const assetsResponse = await apiCall('/api/assets');
        if (assetsResponse.success) {
          assets = assetsResponse.data;
          const updatedAsset = assets.find(a => a.id === assetId);
          if (updatedAsset) {
            const fn =
              (typeof window.showMaintenanceLogModal === 'function') ? window.showMaintenanceLogModal :
              (typeof showMaintenanceLogModal === 'function') ? showMaintenanceLogModal :
              null;

            if (fn) {
              fn(updatedAsset);
            } else {
              // avoid throwing a ReferenceError after a successful save
              console.warn('showMaintenanceLogModal is not available; skipping modal refresh');
            }
          }
        }
      }
    }
  } catch (error) {
    showNotification('error', `Failed to update maintenance log: ${error.message}`);
    console.error('Error updating maintenance log:', error);
  }
}

async function saveMaintenanceLogSilent(assetId, logIndex, logId) {
  const displayDiv = document.getElementById(`${logId}_display`);
  const editDiv = document.getElementById(`${logId}_edit`);
  const textarea = document.getElementById(`${logId}_input`);
  
  if (!displayDiv || !editDiv || !textarea) {
    return false;
  }
  
  const newDescription = textarea.value.trim();
  
  if (!newDescription) {
    cancelEditMaintenanceLogModal(logId);
    return false;
  }
  
  try {
    // Call API to update the maintenance log
    const response = await apiCall(`/api/assets/${encodeURIComponent(assetId)}/maintenance-log/${logIndex}`, 'PUT', {
      description: newDescription
    });
    
    if (response.success) {
      // Update the display with new text
      displayDiv.textContent = newDescription;
      
      // Show display, hide edit
      displayDiv.style.display = 'block';
      editDiv.style.display = 'none';
      
      // Clear dataset
      delete textarea.dataset.originalValue;
      delete textarea.dataset.assetId;
      delete textarea.dataset.logIndex;
      delete textarea.dataset.logId;
      
      // Update the assets array if it exists
      if (window.assets) {
        const asset = window.assets.find(a => a.id === assetId);
        if (asset && asset.maintenanceLogs && asset.maintenanceLogs[logIndex]) {
          const logParts = asset.maintenanceLogs[logIndex].split('\t');
          if (logParts.length >= 3) {
            logParts[2] = newDescription;
            asset.maintenanceLogs[logIndex] = logParts.join('\t');
          }
        }
      }
      
      // Only remove click-outside listener if no other logs are being edited
      const stillEditing = document.querySelectorAll('div[id$="_edit"][style*="block"]');
      if (stillEditing.length === 0) {
        document.removeEventListener('click', handleClickOutside);
      }
      
      return true;
    } else {
      showNotification('error', response.message || 'Failed to update maintenance log');
      return false;
    }
  } catch (error) {
    showNotification('error', `Failed to update maintenance log: ${error.message}`);
    console.error('Error updating maintenance log:', error);
    return false;
  }
}

async function saveMaintenanceLog(assetId, logIndex, logId) {
  const result = await saveMaintenanceLogSilent(assetId, logIndex, logId);
  
  if (result) {
    showNotification('success', 'Maintenance log updated successfully');
  }
}

function closeMaintenanceLogModal() {
  const modal = document.getElementById('maintenanceLogModal');
  if (modal) {
    modal.remove();
  }
}

// Utility functions
function showNotification(type, message) {
  const notification = document.createElement("div");
  notification.className = `notification ${type}`;
  notification.textContent = message;

  document.body.appendChild(notification);

  // Trigger animation
  setTimeout(() => notification.classList.add("show"), 100);

  // Remove notification after 3 seconds
  setTimeout(() => {
    notification.classList.remove("show");
    setTimeout(() => {
      if (document.body.contains(notification)) {
        document.body.removeChild(notification);
      }
    }, 300);
  }, 3000);
}

function createModelPreparationSection(eventId, brand, model, description, requiredQty, availableAssets, assignedAssets) {
    const assignedCount = assignedAssets.length;
    const progressPercent = Math.round((assignedCount / requiredQty) * 100);
    const modelId = `model-${brand.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '')}-${model.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '')}-${eventId}`;
    
    let section = `
        <div class="model-prep-section" style="border: 1px solid #e9ecef; border-radius: 8px; padding: 0; margin-bottom: 15px;">
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px; background: #f8f9fa; border-radius: 8px 8px 0 0; cursor: pointer;" onclick="togglePrepareSection('${modelId}')">
                <div>
                    <h5 style="margin: 0; color: #495057;">${requiredQty}x ${escapeHtml(brand)} ${escapeHtml(model)}</h5>
                    <div style="color: #666; font-size: 12px; margin-top: 2px;">${escapeHtml(description)}</div>
                </div>
                <div style="display: flex; align-items: center; gap: 15px;">
                    <div style="text-align: right;">
                        <div style="font-size: 14px; font-weight: 500; color: ${assignedCount >= requiredQty ? '#28a745' : '#ffc107'};">
                            ${assignedCount}/${requiredQty} assigned
                            ${assignedCount > requiredQty ? ` (+${assignedCount - requiredQty} extra)` : ''}
                        </div>
                        <div style="background: #e9ecef; border-radius: 10px; height: 4px; width: 120px; overflow: hidden; margin-top: 4px;">
                            <div style="background: ${assignedCount >= requiredQty ? '#28a745' : '#ffc107'}; height: 100%; width: ${Math.min(progressPercent, 100)}%; transition: width 0.3s ease;"></div>
                        </div>
                    </div>
                    <span class="toggle-icon" style="font-size: 16px; font-weight: bold; color: #666;">▼</span>
                </div>
            </div>
            
            <div id="${modelId}" style="display: none; padding: 15px; border-top: 1px solid #e9ecef;">
    `;
    
    // Available assets section
    if (availableAssets.length > 0) {
        section += `
            <div style="margin-bottom: 20px;">
                <h6 style="color: #495057; margin-bottom: 10px; font-size: 13px;">Available Assets (${availableAssets.length})</h6>
                <div style="background: #e8f5e8; border-radius: 6px; padding: 10px; max-height: 200px; overflow-y: auto;">
        `;
        
          availableAssets.forEach(asset => {
              // Check if this asset is already assigned (handle both formats)
              const isAlreadyAssigned = assignedAssets.some(assigned => 
                  typeof assigned === 'string' ? assigned === asset.id : assigned.id === asset.id
              );
              const buttonText = isAlreadyAssigned ? 'Assigned ✓' : 'Prepare';
              const buttonClass = isAlreadyAssigned ? 'btn-secondary' : 'btn-success';
              const buttonAction = isAlreadyAssigned ? '' : `assignSpecificAsset(${eventId}, '${escapeJs(asset.id)}', '${escapeJs(brand)}', '${escapeJs(model)}')`;
              const disabled = isAlreadyAssigned ? 'disabled' : '';
            
            section += `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; background: white; border-radius: 4px; margin-bottom: 5px; border: 1px solid #c3e6cb;">
                    <div>
                        <div style="font-weight: 500; font-size: 14px;">${escapeHtml(asset.id)}</div>
                        <div style="color: #666; font-size: 12px;">SN: ${escapeHtml(asset.serial || 'N/A')}</div>
                    </div>
                    <button class="btn ${buttonClass}" style="padding: 4px 10px; font-size: 11px;" onclick="${buttonAction}" ${disabled}>${buttonText}</button>
                </div>
            `;
        });
        
        section += '</div></div>';
    } else {
        section += `
            <div style="margin-bottom: 20px;">
                <h6 style="color: #495057; margin-bottom: 10px; font-size: 13px;">Available Assets</h6>
                <div style="background: #f8d7da; color: #721c24; padding: 10px; border-radius: 6px; font-size: 12px; text-align: center;">
                    No available assets of this model
                </div>
            </div>
        `;
    }
    
    // Assigned/Prepared assets section (made bigger)
    if (assignedAssets.length > 0) {
        section += `
            <div>
                <h6 style="color: #495057; margin-bottom: 10px; font-size: 13px;">Assigned Assets (${assignedAssets.length})</h6>
                <div style="background: #d4edda; border-radius: 6px; padding: 12px;">
        `;
        
        assignedAssets.forEach((asset, index) => {
            // Handle both old format (just ID strings) and new format (asset objects)
            const assetId = typeof asset === 'string' ? asset : asset.id;
            const assetSerial = typeof asset === 'string' ? 'N/A' : (asset.serial || 'N/A');
            
            const isExtra = index >= requiredQty;
            const bgColor = isExtra ? '#fff3cd' : '#d4edda';
            const textColor = isExtra ? '#856404' : '#155724';
            const statusIcon = isExtra ? '➕' : '✅';
            const statusText = isExtra ? 'Extra' : 'Required';
            
            section += `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding: 10px 12px; background: ${bgColor}; border-radius: 4px; border: 1px solid ${isExtra ? '#ffeaa7' : '#c3e6cb'};">
                    <div>
                        <span style="color: ${textColor}; font-weight: 500; font-size: 15px;">
                            ${statusIcon} ${escapeHtml(assetId)} 
                        </span>
                        <div style="color: ${textColor}; font-size: 13px; margin-top: 3px;">SN: ${escapeHtml(assetSerial)} • ${statusText}</div>
                    </div>
                    <button class="btn btn-warning" style="padding: 6px 12px; font-size: 12px;" onclick="unprepareSpecificAsset(${eventId}, '${assetId}')">Unprepare</button>
                </div>
            `;
        });
        
        section += '</div></div>';
    } else {
        section += `
            <div>
                <h6 style="color: #495057; margin-bottom: 10px; font-size: 13px;">Assigned Assets</h6>
                <div style="background: #fff3cd; color: #856404; padding: 10px; border-radius: 6px; font-size: 12px; text-align: center;">
                    No assets assigned yet
                </div>
            </div>
        `;
    }
    
    section += '</div></div>';
    
    return section;
}

let currentDeliveryOrderEvent = null;

async function openDeliveryOrderTab(eventId) {
    // Use stored event data if available, otherwise fetch it
    if (window.currentEventData && window.currentEventData.id === eventId) {
        currentDeliveryOrderEvent = window.currentEventData;
        await populateDeliveryOrderForm(window.currentEventData);
        showSection('delivery-order');
        
        // Update the tab to show it's active
        const deliveryTab = document.getElementById('delivery-order-tab');
        if (deliveryTab) deliveryTab.click();
    } else {
        // Fallback: fetch event data
        try {
            const response = await apiCall(`/api/events/${eventId}`);
            currentDeliveryOrderEvent = response.data;
            await populateDeliveryOrderForm(response.data);
            showSection('delivery-order');
            
            // Update the tab to show it's active
            const deliveryTab = document.getElementById('delivery-order-tab');
            if (deliveryTab) deliveryTab.click();
        } catch (error) {
            console.error('Error fetching event data:', error);
            showNotification('error', 'Failed to load event data');
        }
    }
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

    if (doNumberEl) {
      const year = new Date().getFullYear();
      const eid = (event && (event.event_id ?? event.id)) ? String(event.event_id ?? event.id).padStart(4, '0') : '0000';
      doNumberEl.value = `DO-${year}${eid}`;
    }
    
    if (doDateEl) doDateEl.value = new Date().toISOString().split('T')[0];
    if (clientNameEl) clientNameEl.value = event.client_name || event.name || '';
    if (clientCompanyEl) clientCompanyEl.value = event.client_company || '';
    if (deliveryAddress1El) deliveryAddress1El.value = event.venue || '';
    if (deliveryAddress2El) deliveryAddress2El.value = event.venue_address || '';
    if (deliveryAddress3El) deliveryAddress3El.value = event.venue_city || '';
    if (clientPhoneEl) clientPhoneEl.value = event.client_phone || '';
    if (jobTitleEl) jobTitleEl.value = event.name || '';
    if (jobLocationEl) jobLocationEl.value = event.venue || '';
    if (additionalCommentsEl) additionalCommentsEl.value = '';
    
    if (document.getElementById('showAssetIds')) document.getElementById('showAssetIds').checked = false;

    // Populate items preview (now async)
    await populateDeliveryItemsPreview(event);
    await setupClientAutocomplete();    // NEW
    ensureKnownClientsButton();
}

function generateDeliveryOrder(format) {
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
    
    if (format === 'excel') {
        generateExcelDO(deliveryOrderData);
    } else {
        generatePdfDO(deliveryOrderData);
    }
}

function generatePdfDO(data) {
    // Format the date for display
    const formattedDate = new Date(data.doDate).toLocaleDateString('en-GB', { 
        day: '2-digit', 
        month: 'short', 
        year: 'numeric' 
    });
    
    // Create a new window for the delivery order
    const doWindow = window.open('', '_blank', 'width=800,height=1000');
    
    // Generate pages content
    const pagesContent = generatePagesContent(data, formattedDate);
    
    // Get the HTML template with populated data
    const template = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Delivery Order - ${data.jobTitle}</title>
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
        
        .logo {
            height: 60px;
            width: auto;
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

    </style>
</head>
<body>
    ${pagesContent}
    
    <div class="footer">
        AVEC VISION PRIVATE LIMITED<br>
        601 SIMS DRIVE PAN-I COMPLEX #04-10 SINGAPORE 387382 TEL 65.9743.3660 CO REG 202122775G
    </div>
    
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

function generatePagesContent(data, formattedDate) {
    const departments = groupItemsByDepartment(data.event);
    const maxRowsPerPage = 24;
    let pages = [];
    let currentPageItems = [];
    let currentRowCount = 1; 
    
    // Check if we have any content
    const allItems = Object.values(departments).flat();
    if (allItems.length === 0) {
        pages.push([]);
    } else {
        // Process each department
        Object.keys(departments).forEach(dept => {
            if (departments[dept].length > 0) {
                const deptItems = departments[dept];
                
                // Check if we need to add department header
                if (currentRowCount + 1 > maxRowsPerPage && currentPageItems.length > 0) {
                    // Start new page
                    pages.push([...currentPageItems]);
                    currentPageItems = [];
                    currentRowCount = 1;
                }
                
                // Add department header
                currentPageItems.push({
                    type: 'department',
                    name: dept,
                    items: []
                });
                currentRowCount += 1;
                
                // Add items one by one
                // Add items one by one
                deptItems.forEach(item => {
                    console.log(`Processing item in ${dept}:`, item);
                    
                    // Calculate how many rows this item will take (base + asset IDs if enabled)
                    let itemRowCount = 1; // Base row
                    let itemAssetIds = [];
                    
                    if (data.showAssetIds) {
                        console.log('showAssetIds is enabled, getting asset IDs...');
                        itemAssetIds = getAssetIdsByItem(data.event, item, dept);
                        console.log(`Found ${itemAssetIds.length} asset IDs for this item:`, itemAssetIds);
                        if (itemAssetIds.length > 0) {
                            // Add rows for asset IDs (roughly 6-8 asset IDs per row)
                            itemRowCount += Math.ceil(itemAssetIds.length / 7);
                        }
                    } else {
                        console.log('showAssetIds is disabled');
                    }
                    
                    if (currentRowCount + itemRowCount > maxRowsPerPage) {
                        // Start new page
                        pages.push([...currentPageItems]);
                        currentPageItems = [];
                        currentRowCount = 1; // Reset for job title row
                        
                        // Add department header to new page
                        currentPageItems.push({
                            type: 'department',
                            name: dept,
                            items: []
                        });
                        currentRowCount += 1;
                    }
                    
                    // Add item to current department on current page
                    const currentDept = currentPageItems[currentPageItems.length - 1];
                    currentDept.items.push({
                        ...item,
                        assetIds: data.showAssetIds ? itemAssetIds : []
                    });
                    currentRowCount += itemRowCount;
                });
            }
        });
        
        // Add the last page if it has items
        if (currentPageItems.length > 0) {
            pages.push(currentPageItems);
        }
    }
    
    // Generate HTML for all pages
    let pagesHtml = '';
    
    pages.forEach((pageItems, pageIndex) => {
        const isFirstPage = pageIndex === 0;
        const isLastPage = pageIndex === pages.length - 1;
        
        if (!isFirstPage) {
            pagesHtml += '<div class="page-break"></div>';
        }
        
       pagesHtml += `
            <div class="page">
                <div style="display: flex; justify-content: flex-end; margin-bottom: 7px;">
                    <img src="/static/images/logo.png" alt="Company Logo" id="company-logo" style="height: 39px; width: auto; object-fit: contain"/>
                </div>
                <div class="header">
                    <div class="header-left">
                        <div class="deliver-to">DELIVER TO:</div>
                        <div class="client-info">
                            ${data.clientName}<br>
                            ${data.clientCompany ? data.clientCompany + '<br>' : ''}
                            ${data.deliveryAddress1 ? data.deliveryAddress1 + '<br>' : ''}
                            ${data.deliveryAddress2 ? data.deliveryAddress2 + '<br>' : ''}
                            ${data.deliveryAddress3 ? data.deliveryAddress3 + '<br>' : ''}
                        </div>
                        ${data.clientPhone ? `<div class="client-phone">Tel : ${data.clientPhone}</div>` : '<div class="client-phone">Tel : N/A</div>'}
                    </div>
                    <div class="header-right">
                        <div class="delivery-order-title">DELIVERY ORDER</div>
                        <div class="do-number">
                            No. : ${data.doNumber}<br>
                            Date : ${formattedDate}
                        </div>
                    </div>
                </div>
                
                <table class="items-table">
                    <thead>
                        <tr>
                            <th class="description-header">DESCRIPTION</th>
                            <th class="quantity-header">QUANTITY</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td class="job-title">Job Title : ${data.jobTitle}${data.jobLocation ? '<br>' + data.jobLocation : ''}</td>
                            <td class="quantity-col"></td>
                        </tr>
        `;
        
        // Add items for this page
        pageItems.forEach(pageItem => {
            if (pageItem.type === 'department') {
                pagesHtml += `<tr><td class="department-header" colspan="2">${pageItem.name}:</td></tr>`;
                pageItem.items.forEach(item => {
                    pagesHtml += `
                        <tr>
                            <td>${item.description}${item.assetIds && item.assetIds.length > 0 ? '<br><span style="font-size: 8px; color: #666; font-style: italic;">Asset IDs: ' + item.assetIds.join(', ') + '</span>' : ''}</td>
                            <td class="quantity-col">${item.quantity}</td>
                        </tr>
                    `;
                });
            }
        });
        
        pagesHtml += `
                    </tbody>
                </table>
        `;
        
        // Add comments section only on last page
        if (isLastPage) {
            pagesHtml += `
                <div class="comments-section">
                    <div class="other-comments">Other Comments: ${data.additionalComments || ''}</div>
                    <div class="received-text">Received in good order & condition</div>
                </div>
                <div style="position: absolute; bottom: -10mm; right: 0;">
                    <div class="signature-line">
                        Company's Stamp & Signature
                    </div>
                </div>
            `;
        }
        
        pagesHtml += `
            </div>
        `;
    });
    
    return pagesHtml;
}

function generateExcelDO(data) {
    // Import SheetJS if not already loaded
    if (typeof XLSX === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        script.onload = () => generateExcelDO(data);
        document.head.appendChild(script);
        return;
    }
    
    // Format the date for display
    const formattedDate = new Date(data.doDate).toLocaleDateString('en-GB', { 
        day: '2-digit', 
        month: 'short', 
        year: 'numeric' 
    });
    
    // Prepare data for Excel
    const excelData = [];
    
    // Header information
    excelData.push(['DELIVERY ORDER']);
    excelData.push([]);
    excelData.push(['DELIVER TO:', '', '', 'No.:  ', data.doNumber]);
    excelData.push([data.clientName, '', '', 'Date: ', formattedDate]);
    if (data.clientCompany) excelData.push([data.clientCompany]);
    if (data.deliveryAddress1) excelData.push([data.deliveryAddress1]);
    if (data.deliveryAddress2) excelData.push([data.deliveryAddress2]);
    if (data.deliveryAddress3) excelData.push([data.deliveryAddress3]);
    if (data.clientPhone) excelData.push([`Tel. ${data.clientPhone}`]);
    excelData.push([]);
    
    // Table headers
    excelData.push(['DESCRIPTION', 'QUANTITY']);
    
    // Job title row
    excelData.push([`Job Title :  ${data.jobTitle}`, '']);
    if (data.jobLocation) excelData.push([data.jobLocation, '']);
    
    // Group items by department
    const departments = groupItemsByDepartment(data.event);
    
    // Add items by department
    Object.keys(departments).forEach(dept => {
        if (departments[dept].length > 0) {
            excelData.push([`${dept}:`]);
            departments[dept].forEach(item => {
                excelData.push([item.description, item.quantity]);
            });
        }
    });
    
    excelData.push([]);
    excelData.push([`Other Comments: ${data.additionalComments || ''}`, 'Received in good order & condition']);
    excelData.push([]);
    excelData.push(["Company's Stamp & Signature"]);
    excelData.push([]);
    excelData.push(['AVEC VISION PRIVATE LIMITED']);
    excelData.push(['25 KAKI BUKIT ROAD 4 #07-55 SYNERGY@KB SINGAPORE 417800 TEL 65.6747.5201 CO REG 202122775G']);
    
    // Create workbook
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(excelData);
    
    // Set column widths
    ws['!cols'] = [
        { width: 60 }, // Description column
        { width: 12 }  // Quantity column
    ];
    
    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, 'Delivery Order');
    
    // Generate and download file
    const fileName = `DO_${data.doNumber}_${data.jobTitle.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`;
    XLSX.writeFile(wb, fileName);
    
    showNotification('success', 'Excel delivery order generated successfully');
}

// Keep the existing helper functions
function generateItemRows(event) {
    let html = '';
    const departments = groupItemsByDepartment(event);
    
    // Generate HTML for each department
    Object.keys(departments).forEach(dept => {
        if (departments[dept].length > 0) {
            html += `<tr><td class="department-header" colspan="2">${dept}:</td></tr>`;
            departments[dept].forEach(item => {
                html += `
                    <tr>
                        <td>${item.description}</td>
                        <td class="quantity-col">${item.quantity}</td>
                    </tr>
                `;
            });
        }
    });
    
    return html;
}

// Function to ensure assets are loaded before using them
async function ensureAssetsLoaded() {
    if (!assets || assets.length === 0) {
        console.log('Assets not loaded, fetching from API...');
        try {
            const response = await apiCall('/api/assets');
            if (response.success) {
                assets = response.data;
                console.log(`Loaded ${assets.length} assets for delivery order`);
            } else {
                console.error('Failed to load assets:', response);
            }
        } catch (error) {
            console.error('Error loading assets:', error);
        }
    } else {
        console.log(`Using ${assets.length} pre-loaded assets`);
    }
}

// Add these functions before the populateDeliveryItemsPreview function

// Helper function to reorder items within a department
// Replace the existing reordering functions with these enhanced versions

// Enhanced helper function to reorder any type of items within a department
function reorderDoItems(eventId, dept, fromIndex, toIndex) {
  const state = getDoEdits(eventId);
  
  // Get the current items for this department from groupItemsByDepartment
  const event = events.find(e => e.id === eventId || e.event_id === eventId);
  if (!event) return false;
  
  const depts = groupItemsByDepartment(event);
  const items = depts[dept] || [];
  
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || 
      fromIndex >= items.length || toIndex >= items.length) {
    return false;
  }

  // Create a new ordering array for this department if it doesn't exist
  if (!state.ordering) {
    state.ordering = {};
  }
  if (!state.ordering[dept]) {
    // Initialize ordering with current item keys
    state.ordering[dept] = items.map(item => item.key);
  }

  // Reorder in the ordering array
  const ordering = [...state.ordering[dept]];
  const [movedKey] = ordering.splice(fromIndex, 1);
  ordering.splice(toIndex, 0, movedKey);
  
  state.ordering[dept] = ordering;
  saveDoEdits(eventId, state);
  return true;
}

// Enhanced function to apply ordering to grouped items
function applyDoOrdering(items, dept, eventId) {
  const state = getDoEdits(eventId);
  
  if (!state.ordering || !state.ordering[dept]) {
    return items; // Return original order if no custom ordering
  }
  
  const ordering = state.ordering[dept];
  const orderedItems = [];
  const itemsMap = new Map(items.map(item => [item.key, item]));
  
  // First, add items in the specified order
  ordering.forEach(key => {
    const item = itemsMap.get(key);
    if (item) {
      orderedItems.push(item);
      itemsMap.delete(key); // Remove from map to avoid duplicates
    }
  });
  
  // Then, add any new items that weren't in the original ordering
  itemsMap.forEach(item => {
    orderedItems.push(item);
  });
  
  return orderedItems;
}

// Setup drag and drop handlers for DO items (enhanced)
function setupDoItemDragHandlers(previewContainer, eventId) {
  let draggedElement = null;
  let draggedIndex = null;
  let draggedDept = null;

  previewContainer.querySelectorAll('.do-item-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      draggedElement = e.target;
      draggedIndex = parseInt(e.target.getAttribute('data-index'));
      draggedDept = e.target.getAttribute('data-dept');
      e.target.classList.add('dragging');
      
      // Set drag data
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/html', e.target.outerHTML);
    });

    row.addEventListener('dragend', (e) => {
      e.target.classList.remove('dragging');
      draggedElement = null;
      draggedIndex = null;
      draggedDept = null;
      
      // Remove drag-over class from all rows
      previewContainer.querySelectorAll('.do-item-row').forEach(r => r.classList.remove('drag-over'));
    });

    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      
      // Only allow dropping within same department
      const targetDept = e.target.closest('.do-item-row').getAttribute('data-dept');
      if (targetDept === draggedDept) {
        e.target.closest('.do-item-row').classList.add('drag-over');
      }
    });

    row.addEventListener('dragleave', (e) => {
      e.target.closest('.do-item-row').classList.remove('drag-over');
    });

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetRow = e.target.closest('.do-item-row');
      const targetIndex = parseInt(targetRow.getAttribute('data-index'));
      const targetDept = targetRow.getAttribute('data-dept');
      
      targetRow.classList.remove('drag-over');
      
      // Only allow dropping within same department
      if (targetDept !== draggedDept || targetIndex === draggedIndex) {
        return;
      }

      // Attempt to reorder the items
      if (reorderDoItems(eventId, draggedDept, draggedIndex, targetIndex)) {
        // Refresh the display
        const event = events.find(e => e.id === eventId || e.event_id === eventId);
        if (event) {
          populateDeliveryItemsPreview(event);
        }
        if (typeof showNotification === 'function') {
          showNotification('success', 'Items reordered successfully');
        }
      } else {
        if (typeof showNotification === 'function') {
          showNotification('warning', 'Unable to reorder items');
        }
      }
    });
  });

  // Prevent drag on form inputs
  previewContainer.querySelectorAll('input').forEach(input => {
    input.addEventListener('dragstart', (e) => {
      e.preventDefault();
      return false;
    });
  });
}

// Helper function to clear ordering when DO edits are reset
function clearDoOrdering(eventId) {
  const state = getDoEdits(eventId);
  if (state.ordering) {
    delete state.ordering;
    saveDoEdits(eventId, state);
  }
}

// Setup drag and drop handlers for DO items
function setupDoItemDragHandlers(previewContainer, eventId) {
  let draggedElement = null;
  let draggedIndex = null;
  let draggedDept = null;

  previewContainer.querySelectorAll('.do-item-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      draggedElement = e.target;
      draggedIndex = parseInt(e.target.getAttribute('data-index'));
      draggedDept = e.target.getAttribute('data-dept');
      e.target.classList.add('dragging');
      
      // Set drag data
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/html', e.target.outerHTML);
    });

    row.addEventListener('dragend', (e) => {
      e.target.classList.remove('dragging');
      draggedElement = null;
      draggedIndex = null;
      draggedDept = null;
      
      // Remove drag-over class from all rows
      previewContainer.querySelectorAll('.do-item-row').forEach(r => r.classList.remove('drag-over'));
    });

    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      
      // Only allow dropping within same department
      const targetDept = e.target.closest('.do-item-row').getAttribute('data-dept');
      if (targetDept === draggedDept) {
        e.target.closest('.do-item-row').classList.add('drag-over');
      }
    });

    row.addEventListener('dragleave', (e) => {
      e.target.closest('.do-item-row').classList.remove('drag-over');
    });

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetRow = e.target.closest('.do-item-row');
      const targetIndex = parseInt(targetRow.getAttribute('data-index'));
      const targetDept = targetRow.getAttribute('data-dept');
      
      targetRow.classList.remove('drag-over');
      
      // Only allow dropping within same department
      if (targetDept !== draggedDept || targetIndex === draggedIndex) {
        return;
      }

      // Attempt to reorder the items
      if (reorderDoItems(eventId, draggedDept, draggedIndex, targetIndex)) {
        // Refresh the display
        const event = events.find(e => e.id === eventId || e.event_id === eventId);
        if (event) {
          populateDeliveryItemsPreview(event);
        }
        if (typeof showNotification === 'function') {
          showNotification('success', 'Items reordered successfully');
        }
      } else {
        if (typeof showNotification === 'function') {
          showNotification('warning', 'Can only reorder custom items within the same department');
        }
      }
    });
  });
}

// Helper function to update item indices after reordering
function updateDoItemIndices(eventId, dept) {
  const state = getDoEdits(eventId);
  
  // Re-index custom items to maintain consistency
  if (state.custom[dept]) {
    state.custom[dept] = state.custom[dept].map((item, index) => ({...item}));
    saveDoEdits(eventId, state);
  }
}

// NON-BULLET DO PREVIEW + EDIT MODE with consistent styling
async function populateDeliveryItemsPreview(event) {
  const previewContainer = document.getElementById('deliveryItemsPreview');
  if (!previewContainer) return;

  try { 
    if (typeof ensureAssetsLoaded === 'function') await ensureAssetsLoaded(); 
  } catch {}

  const eventId = event.id || event.event_id || window.currentEventId || '0';
  const edits = getDoEdits(eventId);

  const render = () => {
    const depts = groupItemsByDepartment(event);
    const editMode = !!document.querySelector('#doEditToggle')?.checked;

    // Updated styles to match application theme
    let html = `
      <style>
        .do-items-container {
          background: white;
          border-radius: 8px;
          overflow: hidden;
        }
        .do-toolbar {
          background: #f8f9fa;
          padding: 15px 20px;
          border-bottom: 1px solid #e9ecef;
          display: flex;
          gap: 15px;
          align-items: center;
        }
        .do-toolbar label {
          display: flex;
          gap: 8px;
          align-items: center;
          font-weight: 500;
          color: #495057;
          cursor: pointer;
        }
        .do-department-section {
          border-bottom: 1px solid #f1f3f4;
        }
        .do-department-section:last-child {
          border-bottom: none;
        }
        .do-dept-header {
          background: #f8f9fa;
          padding: 12px 20px;
          font-weight: 600;
          color: #495057;
          border-bottom: 1px solid #e9ecef;
        }
        .do-items-list {
          padding: 0;
        }
        .do-item-row {
          display: flex;
          align-items: center;
          padding: 12px 20px;
          border-bottom: 1px solid #f8f9fa;
          transition: background-color 0.2s ease;
        }
        .do-item-row:hover {
          background-color: #f8f9fa;
        }
        .do-item-row:last-child {
          border-bottom: none;
        }
        .do-item-description {
          flex: 1;
          min-width: 0;
          margin-right: 15px;
        }
        .do-item-description input {
          width: 100%;
          border: 1px solid #e9ecef;
          border-radius: 4px;
          padding: 8px 12px;
          font-size: 14px;
        }
        .do-item-description input:focus {
          outline: none;
          border-color: #667eea;
          box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.2);
        }
        .do-item-quantity {
          width: 80px;
          margin-right: 15px;
        }
        .do-item-quantity input {
          width: 100%;
          text-align: center;
          border: 1px solid #e9ecef;
          border-radius: 4px;
          padding: 8px;
          font-size: 14px;
          font-weight: 600;
        }
        .do-item-quantity input:focus {
          outline: none;
          border-color: #667eea;
          box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.2);
        }
        .do-quantity-badge {
          display: inline-block;
          background: #6f42c1;
          color: white;
          padding: 4px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
          min-width: 32px;
          text-align: center;
        }
        .do-item-actions {
          display: flex;
          gap: 8px;
        }
        .do-add-section {
          background: #f8f9fa;
          padding: 15px 20px;
          border-top: 1px solid #e9ecef;
        }
        .do-add-form {
          display: flex;
          gap: 10px;
          align-items: center;
        }
        .do-add-description {
          flex: 1;
          min-width: 300px;
        }
        .do-add-quantity {
          width: 80px;
        }
        .no-items-message {
          padding: 40px 20px;
          text-align: center;
          color: #6c757d;
          font-style: italic;
        }

        .do-item-row.dragging {
          opacity: 0.5;
        }
        .do-item-row.drag-over {
          border-top: 2px solid #667eea;
        }
        .do-drag-handle {
          cursor: grab;
          padding: 8px;
          margin-right: 8px;
          color: #6c757d;
          font-size: 14px;
          user-select: none;
        }
        .do-drag-handle:hover {
          color: #495057;
        }
        .do-drag-handle:active {
          cursor: grabbing;
        }
      </style>

      <div class="do-items-container">
        <div class="do-toolbar">
          <label>
            <input type="checkbox" id="doEditToggle"${editMode ? ' checked' : ''}> 
            <span>Edit items for delivery order</span>
          </label>
          <button class="btn btn-secondary" id="doResetEdits" title="Reset all edits and return to original items">
            Reset Edits
          </button>
        </div>
    `;

    const esc = (s) => escapeHtml(s);
    const escA = (s) => (typeof escapeHtmlAttr === 'function' ? escapeHtmlAttr(s) : esc(s));

    // Generate department sections
    const section = (deptName, items) => {
      const rows = items.map((item, i) => {
        const isCustom = item.source?.startsWith('do-custom') || item.source === 'custom-prepared' || item.source === 'custom-assets-dept';
        const canDelete = editMode && isCustom;
        
        if (editMode) {
          return `
            <div class="do-item-row" draggable="true" data-key="${escA(item.key)}" data-kind="${escA(item.source || '')}" data-dept="${escA(deptName)}" data-index="${i}">
              <div class="do-drag-handle">⋮⋮</div>
              <div class="do-item-description">
                <input type="text" class="do-desc form-input" value="${escA(item.description)}" placeholder="Item description">
              </div>
              <div class="do-item-quantity">
                <input type="number" class="do-qty form-input" value="${item.quantity}" min="1" max="999">
              </div>
              <div class="do-item-actions">
                <button class="btn btn-primary btn-sm do-save">Save</button>
                ${canDelete ? '<button class="btn btn-danger btn-sm do-del">Delete</button>' : ''}
              </div>
            </div>
          `;
        } else {
          return `
            <div class="do-item-row">
              <div class="do-item-description">
                <span style="color: #495057; font-weight: 500;">${esc(item.description)}</span>
              </div>
              <div class="do-item-quantity">
                <span class="do-quantity-badge">${item.quantity}</span>
              </div>
              <div class="do-item-actions">
                <!-- Read-only mode -->
              </div>
            </div>
          `;
        }
      }).join('');

      // Add section for new items (edit mode only)
      const addSection = !editMode ? '' : `
        <div class="do-add-section">
          <div class="do-add-form">
            <div class="do-add-description">
              <input type="text" class="form-input do-add-desc" placeholder="Add custom item to ${deptName} department">
            </div>
            <div class="do-add-quantity">
              <input type="number" class="form-input do-add-qty" value="1" min="1" max="999">
            </div>
            <button class="btn btn-primary do-add-btn" data-dept="${escA(deptName)}">
              Add Item
            </button>
          </div>
        </div>
      `;

      return `
        <div class="do-department-section">
          <div class="do-dept-header">${esc(deptName)} Department</div>
          <div class="do-items-list" data-dept="${escA(deptName)}">
            ${rows || '<div class="no-items-message">No items in this department</div>'}
          </div>
          ${addSection}
        </div>
      `;
    };

    let body = '';
    ['Audio', 'Lighting', 'Video', 'MISC'].forEach(dept => {
      if ((depts[dept] || []).length > 0 || (edits.custom[dept] || []).length > 0 || editMode) {
        body += section(dept, depts[dept] || []);
      }
    });

    if (!body.trim()) {
      body = '<div class="no-items-message">No items assigned to this event.</div>';
    }

    html += body + '</div>';
    previewContainer.innerHTML = html;

    // Wire up event handlers
    const resetBtn = document.getElementById('doResetEdits');
    if (resetBtn) {
      resetBtn.onclick = () => {
        clearDoEdits(eventId);
        clearDoOrdering(eventId); // Add this line
        if (typeof showNotification === 'function') {
          showNotification('success', 'DO edits reset');
        }
        populateDeliveryItemsPreview(event);
      };
    }

    const toggle = document.getElementById('doEditToggle');
    if (toggle) {
      toggle.onchange = () => populateDeliveryItemsPreview(event);
    }

    // Save / delete / add handlers
    previewContainer.querySelectorAll('.do-save').forEach(btn => {
      btn.onclick = (e) => {
        const row = e.target.closest('.do-item-row');
        const key = row.getAttribute('data-key');
        const kind = row.getAttribute('data-kind');
        const dept = row.getAttribute('data-dept');
        const idxStr = row.getAttribute('data-index');
        const desc = row.querySelector('.do-desc').value.trim();
        const qty = Math.max(1, parseInt(row.querySelector('.do-qty').value, 10) || 1);

        if (!desc) {
          showNotification('warning', 'Description is required');
          return;
        }

        const state = getDoEdits(eventId);
        if (kind === 'do-custom') {
          const i = parseInt(idxStr, 10);
          if (Number.isInteger(i) && state.custom[dept] && state.custom[dept][i]) {
            state.custom[dept][i] = { description: desc, quantity: qty };
          }
        } else {
          state.overrides[key] = { description: desc, quantity: qty };
        }
        
        saveDoEdits(eventId, state);
        if (typeof showNotification === 'function') {
          showNotification('success', 'Item updated successfully');
        }
        populateDeliveryItemsPreview(event);
      };
    });

    previewContainer.querySelectorAll('.do-del').forEach(btn => {
      btn.onclick = async (e) => {
        const confirmed = await showCustomConfirm(
          'Delete Item', 
          'Are you sure you want to delete this item from the delivery order?'
        );
        
        if (!confirmed) return;

        const row = e.target.closest('.do-item-row');
        const dept = row.getAttribute('data-dept');
        const idxStr = row.getAttribute('data-index');
        const i = parseInt(idxStr, 10);
        const state = getDoEdits(eventId);
        
        if (Number.isInteger(i) && state.custom[dept]) {
          state.custom[dept].splice(i, 1);
          saveDoEdits(eventId, state);
          if (typeof showNotification === 'function') {
            showNotification('success', 'Item deleted successfully');
          }
          populateDeliveryItemsPreview(event);
        }
      };
    });

    previewContainer.querySelectorAll('.do-add-btn').forEach(btn => {
      btn.onclick = (e) => {
        const dept = e.currentTarget.getAttribute('data-dept');
        const wrap = e.currentTarget.closest('.do-add-form');
        const desc = wrap.querySelector('.do-add-desc').value.trim();
        const qty = Math.max(1, parseInt(wrap.querySelector('.do-add-qty').value, 10) || 1);
        
        if (!desc) {
          showNotification('warning', 'Description is required');
          wrap.querySelector('.do-add-desc').focus();
          return;
        }

        const state = getDoEdits(eventId);
        state.custom[dept].push({ description: desc, quantity: qty });
        saveDoEdits(eventId, state);
        
        // Clear the form
        wrap.querySelector('.do-add-desc').value = '';
        wrap.querySelector('.do-add-qty').value = '1';
        
        if (typeof showNotification === 'function') {
          showNotification('success', `Added item to ${dept} department`);
        }
        populateDeliveryItemsPreview(event);
      };
    });

    // Add keyboard shortcuts for form inputs
    previewContainer.querySelectorAll('.do-add-desc').forEach(input => {
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const addBtn = input.closest('.do-add-form').querySelector('.do-add-btn');
          if (addBtn) addBtn.click();
        }
      });
    });

    // Setup drag and drop handlers for reordering (only in edit mode)
    if (editMode) {
      setupDoItemDragHandlers(previewContainer, eventId);
    }

    // Also update the drag handles to prevent dragging on form inputs
    previewContainer.querySelectorAll('.do-drag-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        // Prevent drag from starting on input fields
        const row = handle.closest('.do-item-row');
        const inputs = row.querySelectorAll('input');
        inputs.forEach(input => {
          input.setAttribute('draggable', 'false');
        });
      });
    });
  };

  render();
}

function groupItemsByDepartment(event) {
  const departments = { Audio: [], Lighting: [], Video: [], MISC: [] };
  const deptName = (code) => (code === 'AX' ? 'Audio' : code === 'LX' ? 'Lighting' : code === 'VX' ? 'Video' : 'MISC');

  // 1) Base groups from modelGroups (what the job actually asked for)
  if (event.modelGroups && Object.keys(event.modelGroups).length) {
    Object.values(event.modelGroups).forEach(mg => {
      const dname = deptName(mg.department);
      const baseDesc = `${mg.brand||''} ${mg.model||''}${mg.description ? ' - ' + mg.description : ''}`.trim();
      departments[dname].push({
        key: makeModelKey(mg),
        description: baseDesc,
        quantity: String(mg.requiredQuantity || 0),
        source: 'model'
      });
    });
  }

  // 2) Custom assets already assigned to the event via prepared_items ([MISC]/[LOAN]) → placed under MISC
  if (Array.isArray(event.prepared_items) && event.prepared_items.length) {
    const grouped = {};
    event.prepared_items.forEach(id => {
      if (typeof id !== 'string') return;
      if (id.startsWith('[MISC]') || id.startsWith('[LOAN]')) {
        const type = id.startsWith('[MISC]') ? 'MISC' : 'LOAN';
        const parts = id.substring(type.length + 2 /* [] */).split(';');
        const desc = (parts[0] || (type === 'MISC' ? 'Misc Item' : 'Loan Item')).trim();
        const qty = parseInt(parts[1], 10) || 1;
        grouped[desc] = (grouped[desc] || 0) + qty;
      }
    });
    let idx = 0;
    Object.entries(grouped).forEach(([desc, qty]) => {
      departments.MISC.push({
        key: `CA|MISC|${idx++}|${desc}`,
        description: desc,
        quantity: String(qty),
        source: 'custom-prepared'
      });
    });
  }

  // 3) Also check assetsByDepartment for custom assets (MISC department)
  if (event.assetsByDepartment && event.assetsByDepartment.MISC) {
    const customAssetsFromDept = {};
    event.assetsByDepartment.MISC.forEach(asset => {
      if (asset.id && (asset.id.startsWith('[MISC]') || asset.id.startsWith('[LOAN]'))) {
        const type = asset.id.startsWith('[MISC]') ? 'MISC' : 'LOAN';
        const parts = asset.id.substring(type.length + 2).split(';');
        const desc = (parts[0] || (type === 'MISC' ? 'Misc Item' : 'Loan Item')).trim();
        const qty = parseInt(parts[1], 10) || 1;
        
        // Check if this custom asset is already counted from prepared_items
        const alreadyCounted = departments.MISC.some(item => 
          item.description === desc && item.source === 'custom-prepared'
        );
        
        if (!alreadyCounted) {
          customAssetsFromDept[desc] = (customAssetsFromDept[desc] || 0) + qty;
        }
      }
    });
    
    let idx = departments.MISC.length;
    Object.entries(customAssetsFromDept).forEach(([desc, qty]) => {
      departments.MISC.push({
        key: `CA|MISC|${idx++}|${desc}`,
        description: desc,
        quantity: String(qty),
        source: 'custom-assets-dept'
      });
    });
  }

  // 4) Apply DO display overrides + DO-only custom additions (stored locally per event)
  const eventId = event.id || event.event_id || event.eventId || window.currentEventId || '0';
  const edits = getDoEdits(eventId);

  // 4a) Apply overrides (by item.key)
  ['Audio','Lighting','Video','MISC'].forEach(d => {
    departments[d].forEach((item) => {
      const ov = edits.overrides[item.key];
      if (ov) {
        item.description = ov.description || item.description;
        item.quantity = String(ov.quantity || item.quantity);
      }
    });
  });

  // 4b) Append DO-only customs (user added just for DO printout)
  if (edits && edits.custom) {
    ['Audio','Lighting','Video','MISC'].forEach(d => {
      (edits.custom[d] || []).forEach((ci, i) => {
        departments[d].push({
          key: `DOCUSTOM|${d}|${i}`,
          description: ci.description,
          quantity: String(ci.quantity || 1),
          source: 'do-custom'
        });
      });
    });
  }

  // 5) Apply custom ordering if it exists
  ['Audio','Lighting','Video','MISC'].forEach(d => {
    departments[d] = applyDoOrdering(departments[d], d, eventId);
  });

  console.log('Final grouped departments:', departments);
  return departments;
}

function getAssetIdsByItem(event, item, department) {
    console.log('=== getAssetIdsByItem Debug ===');
    console.log('Department:', department);
    console.log('Item:', item);
    console.log('Item key:', item.key);
    console.log('Item source:', item.source);
    
    const assetIds = [];
    
    if (!event.assetsByDepartment) {
        console.log('No assetsByDepartment found in event');
        return assetIds;
    }
    
    console.log('Available departments:', Object.keys(event.assetsByDepartment));
    
    // Map department names to their codes
    const deptCodeMap = {
        'Audio': 'AX',
        'Lighting': 'LX', 
        'Video': 'VX',
        'MISC': 'MISC'
    };
    
    const deptCode = deptCodeMap[department] || department;
    console.log(`Mapped department "${department}" to code "${deptCode}"`);
    
    if (!event.assetsByDepartment[deptCode]) {
        console.log(`No assets found for department code: ${deptCode}`);
        return assetIds;
    }
    
    const departmentAssets = event.assetsByDepartment[deptCode];
    console.log(`Found ${departmentAssets.length} assets in ${deptCode} department:`, departmentAssets);
    
    // For regular inventory items, find assets that match the item description
    if (item.source === 'model') {
        const itemKey = item.key;
        const keyParts = itemKey.split('|');
        console.log('Key parts:', keyParts);
        
        if (keyParts.length >= 3) {
            const brand = keyParts[2]; // Brand is at index 2
            const model = keyParts[3]; // Model is at index 3
            console.log(`Looking for assets with brand: "${brand}", model: "${model}"`);
            
            // Find assets that match this brand/model combination
            departmentAssets.forEach(asset => {
                // Skip custom assets (they don't have brand/model)
                if (asset.id.startsWith('[MISC]') || asset.id.startsWith('[LOAN]')) {
                    console.log(`Skipping custom asset: ${asset.id}`);
                    return;
                }
                
                console.log(`Checking asset ${asset.id}:`, {
                    id: asset.id,
                    brand: asset.brand,
                    model: asset.model,
                    startsWithModel: asset.id.startsWith('[MODEL]')
                });
                
                if (!asset.id.startsWith('[MODEL]') && 
                    asset.brand === brand && 
                    asset.model === model) {
                    console.log(`✓ Match found: ${asset.id}`);
                    assetIds.push(asset.id);
                } else {
                    console.log(`✗ No match for ${asset.id} (brand: "${asset.brand}" vs "${brand}", model: "${asset.model}" vs "${model}")`);
                }
            });
        }
    } else {
        console.log(`Item source is "${item.source}", not "model" - skipping asset ID lookup`);
    }
    
    console.log('Final asset IDs:', assetIds);
    console.log('=== End Debug ===');
    
    return assetIds.sort();
}

function exportLogs() {
  if (logs.length === 0) {
    showNotification("warning", "No logs to export");
    return;
  }

  const csvContent =
    "data:text/csv;charset=utf-8," +
    "Timestamp,User,Action\n" +
    logs
      .map((log) => `"${log.timestamp}","${log.user}","${log.action}"`)
      .join("\n");

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", "activity_logs.csv");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showNotification("success", "Logs exported successfully!");
}

function logout() {
  if (confirm("Are you sure you want to logout?")) {
    window.location.href = "/logout";
  }
}

// Close modals when clicking outside
window.addEventListener("click", function (e) {
  if (e.target.classList.contains("modal")) {
    e.target.classList.remove("active");
  }
});

// Keyboard shortcuts
document.addEventListener("keydown", function (e) {
  // Escape key closes modals
  if (e.key === "Escape") {
    document.querySelectorAll(".modal.active").forEach((modal) => {
      modal.classList.remove("active");
    });
  }

  // Ctrl+N for new event
  if (e.ctrlKey && e.key === "n") {
    e.preventDefault();
    openModal("addEventModal");
  }

  // Ctrl+Shift+N for new asset
  if (e.ctrlKey && e.shiftKey && e.key === "N") {
    e.preventDefault();
    openModal("addAssetModal");
  }
});

// Initialize application
async function initializeApp() {
  try {
    // Set today's date as default for event forms
    const today = new Date().toISOString().split("T")[0];
    
    // Check if elements exist before setting values
    const startDateEl = document.getElementById("eventStartDate");
    const endDateEl = document.getElementById("eventEndDate");

    if (startDateEl) startDateEl.value = today;
    if (endDateEl) endDateEl.value = today;

    // Also set defaults for edit form if it exists
    const editStartDateEl = document.getElementById("editEventStartDate");
    const editEndDateEl = document.getElementById("editEventEndDate");
    
    if (editStartDateEl) editStartDateEl.value = today;
    if (editEndDateEl) editEndDateEl.value = today;

    // Add a small delay to ensure all DOM elements are ready
    setTimeout(async () => {
      // Load initial data
      await loadDashboard();
    }, 200);
  } catch (error) {
    console.error("Error initializing application:", error);
    showNotification("error", "Failed to initialize application");
  }
}

// Close maintenance log modal when clicking outside
document.addEventListener('click', function(e) {
  const modal = document.getElementById('maintenanceLogModal');
  if (modal && e.target === modal) {
    closeMaintenanceLogModal();
  }
});

// Handle escape key for maintenance log modal
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    const modal = document.getElementById('maintenanceLogModal');
    if (modal) {
      closeMaintenanceLogModal();
    }
  }
});

// Auto-refresh data every 6 seconds
setInterval(async () => {
  try {
    const currentSection = document.querySelector(".content-section.active");
    if (currentSection) {
      const sectionId = currentSection.id.replace("-section", "");
      switch (sectionId) {
        case "dashboard":
          await loadDashboard();
          break;
        case "events":
          await loadAllEvents();
          break;
        case "inventory":
          await loadInventory();
          break;
        case "logs":
          await loadLogs();
          break;
      }
    }
  } catch (error) {
    console.error("Auto-refresh error:", error);
  }
}, 6000);

document.addEventListener('DOMContentLoaded', function() {
    setupSingleAssetClickHandler();
});

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
  if (a3) a3.value = rec.address3 || (rec.postalCode ? `${rec.postalCode}` : '');
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
// PATCH B – full replacement of openClientsManager (adds Edit & Delete) with consistent styling
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
