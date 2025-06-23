// Global variables
let currentUser = null;
let events = [];
let assets = [];
let containers = [];
let logs = [];
let stats = {};

// Global utility function for HTML escaping
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Global utility function for JavaScript string escaping
function escapeJs(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
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
      break;
    case "asset-check":
      loadAssetCheck();
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
    }
}

// Data loading functions
async function loadDashboard() {
  try {
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
    }, 300);
  } catch (error) {
    console.error("Error loading dashboard:", error);
  }
}

async function loadAllEvents() {
    try {
        const response = await apiCall('/api/events');
        events = response.data;
        
        const container = document.getElementById('all-events');
        container.innerHTML = '';
        
        if (events.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No events found. Create your first event!</p>';
            return;
        }
        
        events.forEach(event => {
            container.appendChild(createEventCard(event));
        });
    } catch (error) {
        document.getElementById('all-events').innerHTML = '<p style="color: red; text-align: center;">Error loading events</p>';
    }
}

function createEventCard(event) {
    const card = document.createElement('div');
    card.className = `event-card state-${event.state.toLowerCase()}`;
    
    const formatDate = (dateStr) => {
        return new Date(dateStr).toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric', 
            year: 'numeric' 
        });
    };
    
    // Helper function to escape HTML
    const escapeHtml = (str) => {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    };
    
    const dateRange = event.startDate === event.endDate 
        ? formatDate(event.startDate)
        : `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`;
    
    // Simple asset count display
    let assetSummary = '';
    if (event.assetCount > 0) {
        assetSummary = `<div style="margin: 10px 0; font-size: 12px; color: #666;">${event.preparedCount}/${event.assetCount} assets prepared</div>`;
    } else {
        assetSummary = '<div style="margin: 10px 0; font-size: 12px; color: #999; font-style: italic;">No assets assigned</div>';
    }
    
    card.innerHTML = `
        <div class="event-header">
            <div class="event-id">ID: ${event.id}</div>
            <div class="event-state state-${event.state.toLowerCase()}">${escapeHtml(event.state)}</div>
        </div>
        <div class="event-title">${escapeHtml(event.name)}</div>
        <div class="event-date">${escapeHtml(dateRange)}</div>
        ${assetSummary}
        <div class="event-actions">
            <button class="btn btn-primary" onclick="viewEvent(${event.id})">View</button>
            <button class="btn btn-warning" onclick="editEvent(${event.id})">Edit</button>
            <button class="btn btn-danger" onclick="deleteEvent(${event.id})">Delete</button>
        </div>
    `;
    
    return card;
}

function getModelStatusIcon(status) {
    switch(status) {
        case 'returned': return '↩️';
        case 'ready': return '✅';
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
                    <button class="btn btn-primary" onclick="viewAsset('${
                      asset.id
                    }')">View</button>
                    <button class="btn btn-warning" onclick="editAsset('${
                      asset.id
                    }')">Edit</button>
                </td>
            </tr>
        `;
  });

  tableHTML += "</tbody></table>";
  container.innerHTML = tableHTML;
}

async function loadContainers() {
  try {
    const response = await apiCall("/api/containers");
    containers = response.data;

    const container = document.getElementById("containers-list");
    container.innerHTML = "";

    if (containers.length === 0) {
      container.innerHTML =
        '<p style="text-align: center; color: #666; padding: 40px;">No containers found.</p>';
      return;
    }

    containers.forEach((cont) => {
      const containerCard = document.createElement("div");
      containerCard.className = "event-card";
      containerCard.innerHTML = `
                <div class="event-title">${cont.id}</div>
                <div style="margin: 15px 0;">
                    <small style="color: #666;">${cont.assetCount} assets in container</small>
                </div>
                <div class="event-actions">
                    <button class="btn btn-primary" onclick="viewContainer('${cont.id}')">View Contents</button>
                    <button class="btn btn-warning" onclick="editContainer('${cont.id}')">Edit</button>
                </div>
            `;
      container.appendChild(containerCard);
    });
  } catch (error) {
    document.getElementById("containers-list").innerHTML =
      '<p style="color: red; text-align: center;">Error loading containers</p>';
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
    const preparableEvents = response.data.filter(
      (event) =>
        event.state !== "Closed" && // Allow all events except closed ones
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

  const formatDate = (dateStr) => {
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
  }

  const progressPercent =
    totalRequired > 0 ? Math.round((totalAssigned / totalRequired) * 100) : 0;

  card.innerHTML = `
        <div class="event-header">
            <div class="event-id">ID: ${event.id}</div>
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
            apiCall('/api/assets/available')
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

                <!-- Model Requirements -->
                <div id="model-requirements">
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
                
                content += `
                    <div class="dept-section" style="margin-bottom: 30px;">
                        <h4 style="color: #495057; margin-bottom: 15px; padding: 10px; background: #f8f9fa; border-radius: 8px;">
                            ${dept} Department
                        </h4>
                `;
                
                modelGroups.forEach(modelGroup => {
                    // Find available assets of this model
                    const modelAvailableAssets = availableAssets.filter(a => 
                        a.brand === modelGroup.brand && 
                        a.model === modelGroup.model && 
                        a.department === modelGroup.department
                    );
                    
                    // Get assigned assets for this model
                    const assignedAssets = modelGroup.assignedAssets.map(a => a.id);
                    
                    content += createModelPreparationSection(
                        eventId, modelGroup.brand, modelGroup.model, modelGroup.description, 
                        modelGroup.requiredQuantity, modelAvailableAssets, assignedAssets
                    );
                });
                
                content += '</div>';
            });
        }
        
        // Also check for model assignments in prepared_items (fallback for older events)
        if (event.assetsByDepartment && Object.keys(event.assetsByDepartment).length > 0) {
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
                                const requiredQty = parseInt(parts[3]);
                                const description = parts[4] || '';
                                
                                // Skip if already processed in modelGroups
                                const modelKey = `${dept}|${brand}|${model}`;
                                const alreadyProcessed = event.modelGroups && event.modelGroups[modelKey];
                                
                                if (!alreadyProcessed) {
                                    if (!hasAddedDeptHeader) {
                                        content += `
                                            <div class="dept-section" style="margin-bottom: 30px;">
                                                <h4 style="color: #495057; margin-bottom: 15px; padding: 10px; background: #f8f9fa; border-radius: 8px;">
                                                    ${dept} Department
                                                </h4>
                                        `;
                                        hasAddedDeptHeader = true;
                                    }
                                    
                                    // Find available assets of this model
                                    const modelAvailableAssets = availableAssets.filter(a => 
                                        a.brand === brand && a.model === model && a.department === dept
                                    );
                                    
                                    // Find already assigned specific assets
                                    const assignedAssets = event.actuallyPrepared ? 
                                        event.actuallyPrepared.filter(assetId => {
                                            const availableAsset = availableAssets.find(a => a.id === assetId);
                                            return availableAsset && availableAsset.brand === brand && availableAsset.model === model;
                                        }) : [];
                                    
                                    content += createModelPreparationSection(
                                        eventId, brand, model, description, requiredQty, 
                                        modelAvailableAssets, assignedAssets
                                    );
                                }
                            }
                        } catch (e) {
                            console.error('Error parsing model assignment:', e);
                        }
                    });
                    
                    if (hasAddedDeptHeader) {
                        content += '</div>';
                    }
                }
            });
        }
        
        if (!event.modelGroups || Object.keys(event.modelGroups).length === 0) {
            content += '<p style="text-align: center; color: #666; padding: 40px;">No model assignments found for this event.</p>';
        }
        
        content += `
                </div>
                
                <!-- Universal Asset Input -->
                <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #e9ecef;">
                    <h4 style="color: #495057; margin-bottom: 15px;">Prepare or Assign Assets</h4>
                    <p style="color: #666; font-size: 14px; margin-bottom: 15px;">Scan or enter any asset ID. If assigned to this event, it will be marked as prepared. If not assigned, you'll be prompted to assign it.</p>
                    <div class="form-group">
                        <input type="text" class="form-input" id="universalAssetInput" 
                               placeholder="Enter Asset ID or Serial Number..." 
                               onkeypress="if(event.key==='Enter') processUniversalAsset(${eventId})"
                               style="font-size: 16px; padding: 12px;">
                        <button class="btn btn-success" style="margin-top: 10px; margin-right: 10px;" onclick="processUniversalAsset(${eventId})">Process Asset</button>
                        <button class="btn btn-secondary" style="margin-top: 10px;" onclick="clearUniversalInput()">Clear</button>
                    </div>
                    <div id="universal-asset-feedback" style="margin-top: 15px; min-height: 20px;">
                        <!-- Feedback messages will appear here -->
                    </div>
                </div>
                
                <!-- All Assets Assigned to Event -->
                <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #e9ecef;">
                    <h4 style="color: #495057; margin-bottom: 15px;">All Assets Assigned to Event</h4>
        `;

        // Show all assigned assets with their preparation status
        if (event.assetsByDepartment && Object.keys(event.assetsByDepartment).length > 0) {
            content += `
                        <div style="border: 1px solid #e9ecef; border-radius: 8px; max-height: 400px; overflow-y: auto; margin-top: 15px;">
                            <div style="background: #f8f9fa; padding: 8px 12px; font-weight: bold; border-bottom: 1px solid #e9ecef;">
                                All Assets Assigned to Event
                            </div>
            `;
            
            Object.keys(event.assetsByDepartment).forEach(dept => {
                const assets = event.assetsByDepartment[dept];
                
                // Add department header if there are non-model assets
                const nonModelAssets = assets.filter(asset => !asset.id.startsWith('[MODEL]'));
                if (nonModelAssets.length > 0) {
                    content += `
                        <div style="background: #f1f3f4; padding: 6px 12px; font-weight: 500; font-size: 13px; border-bottom: 1px solid #e9ecef;">
                            ${dept} Department
                        </div>
                    `;
                }
                
                assets.forEach(asset => {
                    if (!asset.id.startsWith('[MODEL]')) {
                        const isPrepared = event.actuallyPrepared && event.actuallyPrepared.includes(asset.id);
                        const isReturned = event.returnedItems && event.returnedItems.includes(asset.id);
                        
                        let statusIcon = '📋';
                        let statusColor = '#6c757d';
                        let statusText = 'Assigned';
                        let actionButton = `<button class="btn btn-success" style="padding: 4px 8px; font-size: 11px;" onclick="prepareSpecificAsset(${eventId}, '${asset.id}')">Prepare</button>`;
                        
                        if (isReturned) {
                            statusIcon = '↩️';
                            statusColor = '#dc3545';
                            statusText = 'Returned';
                            actionButton = '<span style="color: #dc3545; font-size: 11px;">Returned</span>';
                        } else if (isPrepared) {
                            statusIcon = '✅';
                            statusColor = '#28a745';
                            statusText = 'Prepared';
                            actionButton = `<button class="btn btn-warning" style="padding: 4px 8px; font-size: 11px;" onclick="unprepareSpecificAsset(${eventId}, '${asset.id}')">Unprepare</button>`;
                        }
                        
                        // Add extra asset indicator
                        const extraBadge = asset.isExtra ? '<span style="background: #fff3cd; color: #856404; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 10px;">EXTRA</span>' : '';
                        
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
            });
            
            content += '</div>';
        } else {
            content += '<p style="text-align: center; color: #666; padding: 20px; border: 1px solid #e9ecef; border-radius: 8px; margin-top: 15px;">No individual assets assigned to this event.</p>';
        }

        content += `
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
                    <div style="color: #999; font-size: 11px;">${asset.description || ''}</div>
                    <span class="asset-badge dept-${asset.department.toLowerCase()}">${asset.department}</span>
                </div>
                <button class="btn btn-warning" style="padding: 4px 8px; font-size: 11px; background: #ff8c00;" onclick="assignAdditionalAsset(${eventId}, '${asset.id}')">Assign as Extra</button>
            </div>
        `;
    });
    
    resultsContainer.innerHTML = content;
}

async function assignAdditionalAsset(eventId, assetId) {
    try {
        await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId });
        showNotification('success', `Assigned ${assetId} as additional asset`);
        
        // Remove from search results
        const assetElement = document.querySelector(`[onclick*="assignAdditionalAsset(${eventId}, '${assetId}')"]`).closest('div');
        if (assetElement) {
            assetElement.remove();
        }
        
        // Update available assets
        if (window.currentAdditionalAssets) {
            window.currentAdditionalAssets = window.currentAdditionalAssets.filter(a => a.id !== assetId);
        }
        
        // Refresh the preparation modal
        setTimeout(() => {
            openPrepareEventModal(eventId);
        }, 500);
        
    } catch (error) {
        showNotification('error', `Failed to assign asset: ${error.message}`);
    }
}

async function prepareAssignedAsset(eventId) {
    const input = document.getElementById('assignedAssetPrepare');
    const assetId = input.value.trim();
    
    if (!assetId) {
        showNotification('warning', 'Please enter an asset ID');
        return;
    }
    
    try {
        await apiCall(`/api/events/${eventId}/prepare`, 'POST', { assetId });
        showNotification('success', `${assetId} marked as prepared`);
        
        // Clear input
        input.value = '';
        
        // Refresh the preparation modal
        setTimeout(() => {
            openPrepareEventModal(eventId);
        }, 500);
        
    } catch (error) {
        showNotification('error', `Failed to prepare asset: ${error.message}`);
    }
}

async function prepareSpecificAsset(eventId, assetId) {
    try {
        await apiCall(`/api/events/${eventId}/prepare`, 'POST', { assetId });
        showNotification('success', `${assetId} marked as prepared`);
        
        // Refresh the preparation modal
        setTimeout(() => {
            openPrepareEventModal(eventId);
        }, 500);
        
    } catch (error) {
        showNotification('error', `Failed to prepare asset: ${error.message}`);
    }
}

async function unprepareSpecificAsset(eventId, assetId) {
    try {
        await apiCall(`/api/events/${eventId}/unprepare`, 'POST', { assetId });
        showNotification('success', `${assetId} unprepared`);
        
        // Refresh the preparation modal
        setTimeout(() => {
            openPrepareEventModal(eventId);
        }, 500);
        
    } catch (error) {
        showNotification('error', `Failed to unprepare asset: ${error.message}`);
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
        await apiCall(`/api/events/${eventId}/unassign-specific`, 'POST', { assetId });
        showNotification('success', `Unassigned ${assetId} from event`);
        
        // Refresh the preparation modal
        setTimeout(() => {
            openPrepareEventModal(eventId);
        }, 500);
        
        // Also refresh the prepare events list if it's active
        if (document.getElementById('prepare-section').classList.contains('active')) {
            setTimeout(() => {
                loadPrepareEvents();
            }, 700);
        }
        
    } catch (error) {
        showNotification('error', `Failed to unassign asset: ${error.message}`);
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
                            
                            // Check if this asset matches the model requirement
                            if (assetDetails.department === reqDept && 
                                assetDetails.brand === reqBrand && 
                                assetDetails.model === reqModel) {
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

async function assignAndPrepareAsset(eventId, assetId) {
    const feedbackDiv = document.getElementById('universal-asset-feedback');
    const input = document.getElementById('universalAssetInput');
    
    try {
        // Just assign the asset to the event - it will be automatically prepared as an extra asset
        await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId });
        
        showFeedback(feedbackDiv, 'success', `✅ ${assetId} assigned and prepared as extra asset`);
        
        // Clear input and focus back on it
        input.value = '';
        input.focus();
        
        // Update just the asset list section without full refresh
        setTimeout(() => {
            updateAssetListSection(eventId);
        }, 500);
        
    } catch (error) {
        showFeedback(feedbackDiv, 'error', `Failed to assign asset: ${error.message}`);
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
    // Find the "All Assets Assigned to Event" container
    const allAssetsContainer = document.querySelector('div[style*="All Assets Assigned to Event"]');
    if (!allAssetsContainer) return;
    
    // Find the parent container that includes the border
    const parentContainer = allAssetsContainer.closest('div[style*="border: 1px solid #e9ecef"]');
    if (!parentContainer) return;
    
    let content = `
        <div style="background: #f8f9fa; padding: 8px 12px; font-weight: bold; border-bottom: 1px solid #e9ecef;">
            All Assets Assigned to Event
        </div>
    `;
    
    if (event.assetsByDepartment && Object.keys(event.assetsByDepartment).length > 0) {
        Object.keys(event.assetsByDepartment).forEach(dept => {
            const assets = event.assetsByDepartment[dept];
            
            // Add department header if there are non-model assets
            const nonModelAssets = assets.filter(asset => !asset.id.startsWith('[MODEL]'));
            if (nonModelAssets.length > 0) {
                content += `
                    <div style="background: #f1f3f4; padding: 6px 12px; font-weight: 500; font-size: 13px; border-bottom: 1px solid #e9ecef;">
                        ${dept} Department
                    </div>
                `;
            }
            
            assets.forEach(asset => {
                if (!asset.id.startsWith('[MODEL]')) {
                    const isPrepared = event.actuallyPrepared && event.actuallyPrepared.includes(asset.id);
                    const isReturned = event.returnedItems && event.returnedItems.includes(asset.id);
                    
                    let statusIcon = '📋';
                    let statusColor = '#6c757d';
                    let statusText = 'Assigned';
                    let actionButton = `<button class="btn btn-success" style="padding: 4px 8px; font-size: 11px;" onclick="prepareSpecificAsset(${eventId}, '${asset.id}')">Prepare</button>`;
                    
                    if (isReturned) {
                        statusIcon = '↩️';
                        statusColor = '#dc3545';
                        statusText = 'Returned';
                        actionButton = '<span style="color: #dc3545; font-size: 11px;">Returned</span>';
                    } else if (isPrepared) {
                        statusIcon = '✅';
                        statusColor = '#28a745';
                        statusText = 'Prepared';
                        actionButton = `<button class="btn btn-warning" style="padding: 4px 8px; font-size: 11px;" onclick="unprepareSpecificAsset(${eventId}, '${asset.id}')">Unprepare</button>`;
                    }
                    
                    // Add extra asset indicator
                    const extraBadge = asset.isExtra ? '<span style="background: #fff3cd; color: #856404; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 10px;">EXTRA</span>' : '';
                    
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
        });
    } else {
        content += '<p style="text-align: center; color: #666; padding: 20px;">No individual assets assigned to this event.</p>';
    }
    
    parentContainer.innerHTML = content;
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
    const response = await apiCall("/api/events");
    const returnableEvents = response.data.filter((event) => {
      const hasPreparedAssets = event.preparedCount > 0;
      const hasUnreturnedAssets = event.preparedCount > event.returnedCount;
      
      // Include events that have assets that can be returned, regardless of state
      return hasPreparedAssets && hasUnreturnedAssets && event.state !== 'Closed';
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

  const formatDate = (dateStr) => {
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

  const returnedCount = event.returnedCount || 0;
  const totalCount = event.preparedCount || 0;

  card.innerHTML = `
        <div class="event-header">
            <div class="event-id">ID: ${event.id}</div>
            <div class="event-state state-${event.state.toLowerCase()}">${escapeHtml(event.state)}</div>
        </div>
        <div class="event-title">${escapeHtml(event.name)}</div>
        <div class="event-date">${escapeHtml(dateRange)}</div>
        <div style="margin: 15px 0;">
            <small style="color: #666;">${returnedCount}/${totalCount} assets returned</small>
        </div>
        <div class="event-actions">
            <button class="btn btn-warning" onclick="openReturnAssetsModal(${event.id})">Return Assets</button>
            <button class="btn btn-primary" onclick="viewEvent(${event.id})">View Details</button>
        </div>
    `;

  return card;
}

async function openReturnAssetsModal(eventId) {
    try {
        const response = await apiCall(`/api/events/${eventId}`);
        const event = response.data;
        
        document.getElementById('returnAssetsEventTitle').textContent = `Return Assets - Event ${event.id}: ${event.name}`;
        
        let content = `
            <div class="return-assets-interface">
                <!-- Event Summary -->
                <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
                    <h4 style="margin-bottom: 10px; color: #495057;">Event Summary</h4>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; text-align: center;">
                        <div>
                            <div style="font-size: 20px; font-weight: bold; color: #28a745;">${event.totalPrepared}</div>
                            <div style="color: #666; font-size: 12px;">Prepared</div>
                        </div>
                        <div>
                            <div style="font-size: 20px; font-weight: bold; color: #dc3545;">${event.totalReturned}</div>
                            <div style="color: #666; font-size: 12px;">Returned</div>
                        </div>
                        <div>
                            <div style="font-size: 20px; font-weight: bold; color: #ffc107;">${event.totalPrepared - event.totalReturned}</div>
                            <div style="color: #666; font-size: 12px;">Still Out</div>
                        </div>
                    </div>
                </div>

                <!-- Assets to Return -->
                <div id="assets-to-return">
                    <h4 style="color: #495057; margin-bottom: 15px;">Assets Available for Return</h4>
        `;
        
        if (event.assetsByDepartment && Object.keys(event.assetsByDepartment).length > 0) {
            Object.keys(event.assetsByDepartment).sort().forEach(dept => {
                const assets = event.assetsByDepartment[dept];
                
                const assetsToReturn = assets.filter(asset => 
                    asset.status === 'prepared' && !asset.id.startsWith('[MODEL]')
                );
                
                if (assetsToReturn.length > 0) {
                    content += `
                        <div class="dept-section" style="margin-bottom: 20px;">
                            <h5 style="color: #495057; margin-bottom: 10px; padding: 8px; background: #f8f9fa; border-radius: 6px;">
                                ${dept} Department (${assetsToReturn.length} assets)
                            </h5>
                            <div style="border: 1px solid #e9ecef; border-radius: 8px; overflow: hidden;">
                    `;
                    
                    assetsToReturn.forEach(asset => {
                        const extraBadge = asset.isExtra ? 
                            '<span style="background: #fff3cd; color: #856404; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 10px;">EXTRA</span>' : '';
                        
                        content += `
                            <div class="return-asset-item" style="padding: 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center; cursor: pointer; transition: background-color 0.2s;"
                                 onmouseover="this.style.backgroundColor='#f8f9fa'" 
                                 onmouseout="this.style.backgroundColor='white'"
                                 onclick="returnSpecificAsset(${eventId}, '${asset.id}')">
                                <div style="flex: 1;">
                                    <div style="font-weight: 500; font-size: 14px;">
                                        ✅ ${asset.id}${extraBadge}
                                    </div>
                                    <div style="color: #666; font-size: 12px; margin-top: 2px;">${asset.name || ''}</div>
                                    ${asset.serial ? `<div style="color: #999; font-size: 11px;">SN: ${asset.serial}</div>` : ''}
                                    ${asset.location ? `<div style="color: #007bff; font-size: 11px;">📍 ${asset.location}</div>` : ''}
                                </div>
                                <div style="margin-left: 15px;">
                                    <button class="btn btn-warning" style="padding: 6px 12px; font-size: 12px;" onclick="event.stopPropagation(); returnSpecificAsset(${eventId}, '${asset.id}')">
                                        Return
                                    </button>
                                </div>
                            </div>
                        `;
                    });
                    content += '</div></div>';
                }
            });
        }
        
        if (!event.assetsByDepartment || Object.keys(event.assetsByDepartment).length === 0) {
            content += '<p style="text-align: center; color: #666; padding: 40px;">No assets found for this event.</p>';
        } else {
            // Check for assets to return
            let hasAssetsToReturn = false;
            Object.values(event.assetsByDepartment).forEach(assets => {
                if (assets.some(asset => asset.status === 'prepared' && !asset.id.startsWith('[MODEL]'))) {
                    hasAssetsToReturn = true;
                }
            });
            
            if (!hasAssetsToReturn) {
                content += '<p style="text-align: center; color: #666; padding: 40px;">All assets have already been returned for this event.</p>';
            }
        }
        
        content += `
                </div>
                <!-- Manual Return -->
                <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #e9ecef;">
                    <h4 style="color: #495057; margin-bottom: 15px;">Manual Return</h4>
                    <p style="color: #666; font-size: 14px; margin-bottom: 15px;">Scan or enter any asset ID to return it</p>
                    <div class="form-group">
                        <input type="text" class="form-input" id="manualReturnAssetId" 
                               placeholder="Enter Asset ID or Serial Number..." 
                               onkeypress="if(event.key==='Enter') returnManualAsset(${eventId})">
                        <button class="btn btn-warning" style="margin-top: 10px;" onclick="returnManualAsset(${eventId})">Return Asset</button>
                    </div>
                </div>
                
                <!-- Actions -->
                <div style="margin-top: 20px; text-align: right; padding-top: 20px; border-top: 2px solid #e9ecef;">
                    <button class="btn btn-secondary" onclick="closeModal('returnAssetsModal')">Close</button>
                    <button class="btn btn-primary" onclick="finishReturningAssets(${eventId})">Finish</button>
                </div>
            </div>
        `;
        
        document.getElementById('returnAssetsContent').innerHTML = content;
        openModal('returnAssetsModal');
        
    } catch (error) {
        showNotification('error', 'Failed to load return assets interface');
        console.error('Error loading return assets modal:', error);
    }
}

async function loadTransferHistory() {
  try {
    const response = await apiCall("/api/events");
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

  const formatDate = (dateStr) => {
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

    document.getElementById(
      "eventDetailsTitle"
    ).textContent = `Event ${event.id}: ${event.name}`;

    const formatDate = (dateStr) => {
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
                <div style="background: #f8f9fa; padding: 10px 15px; font-weight: 500; font-size: 14px; border-bottom: 1px solid #e9ecef;">
                    ${escapeHtml(dept)} Department
                </div>
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

        content += '</div>';
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
        content += '<div style="margin-bottom: 25px;"><h4 style="color: #495057; margin-bottom: 15px; font-size: 16px;">📋 Individual Assets</h4>';

        Object.keys(event.assetsByDepartment).sort().forEach((dept) => {
          const assets = event.assetsByDepartment[dept];
          const individualAssets = assets.filter(asset => !asset.id.startsWith('[MODEL]'));
          
          if (individualAssets.length > 0) {
            content += `
                <div style="border: 1px solid #e9ecef; border-radius: 8px; margin-bottom: 15px; overflow: hidden;">
                    <div style="background: #f8f9fa; padding: 8px 15px; font-weight: 500; font-size: 14px; border-bottom: 1px solid #e9ecef;">
                        ${escapeHtml(dept)} Department (${individualAssets.length})
                    </div>
                    <div style="padding: 10px 15px;">
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

    openModal("eventDetailsModal");
  } catch (error) {
    showNotification("error", "Failed to load event details");
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
  document.getElementById("maintenanceAssetId").value = assetId;
  openModal("maintenanceModal");
}

function populateTransferDropdowns(events) {
  const fromSelect = document.getElementById("transferFromEvent");
  const toSelect = document.getElementById("transferToEvent");

  // Clear existing options
  fromSelect.innerHTML = '<option value="">Select source event...</option>';
  toSelect.innerHTML = '<option value="">Select destination event...</option>';

  events.forEach((event) => {
    const option1 = document.createElement("option");
    option1.value = event.id;
    option1.textContent = `${event.id}: ${event.name}`;
    fromSelect.appendChild(option1);

    const option2 = document.createElement("option");
    option2.value = event.id;
    option2.textContent = `${event.id}: ${event.name}`;
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

async function editEvent(eventId) {
  try {
    const response = await apiCall(`/api/events/${eventId}`);
    const event = response.data;

    document.getElementById(
      "eventDetailsTitle"
    ).textContent = `Edit Event ${event.id}: ${event.name}`;

    const formatDate = (dateStr) => {
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
                        <label class="form-label">Start Date</label>
                        <input type="date" class="form-input" id="editEventStartDate" value="${event.startDate}" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label">End Date</label>
                        <input type="date" class="form-input" id="editEventEndDate" value="${event.endDate}" required>
                    </div>
                    <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
                        <button type="button" class="btn btn-secondary" onclick="closeModal('eventDetailsModal')">Cancel</button>
                        <button type="submit" class="btn btn-primary">Update Event</button>
                    </div>
                </form>
            </div>
            
            <div id="edit-assets-tab" class="edit-tab-content" style="display: none;">
                <div style="margin-bottom: 30px;">
                    <h4 style="color: #495057; margin-bottom: 15px;">Current Assets (${event.totalAssets})</h4>
                    <div id="current-assets-container" style="border: 1px solid #e9ecef; border-radius: 8px; min-height: 200px;">
        `;

    // Show current assets - including ALL assets (model assignments AND individual assets)
    if (event.assetsByDepartment && Object.keys(event.assetsByDepartment).length > 0) {
      Object.keys(event.assetsByDepartment)
        .sort()
        .forEach((dept) => {
          const assets = event.assetsByDepartment[dept];
          
          if (assets.length > 0) {
            content += `
                        <div style="background: #f8f9fa; padding: 8px 12px; font-weight: bold; border-bottom: 1px solid #e9ecef;">
                            ${escapeHtml(dept)} Department (${assets.length} items)
                        </div>
                    `;

            assets.forEach((asset) => {
              let statusIcon = '📋';
              let statusColor = '#6c757d';
              let statusText = 'Assigned';
              
              if (asset.status === 'returned') {
                statusIcon = '↩️';
                statusColor = '#dc3545';
                statusText = 'Returned';
              } else if (asset.status === 'prepared') {
                statusIcon = '✅';
                statusColor = '#28a745';
                statusText = 'Prepared';
              }

              // Handle different asset types
              if (asset.isModel) {
                // Model assignment - FIXED to show description properly
                content += `
                            <div class="model-assignment" style="padding: 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center; background: #f8f9fa;">
                                <div style="flex: 1;">
                                    <div style="font-weight: 500; color: #495057; margin-bottom: 4px;">
                                        📦 ${asset.quantity}x ${escapeHtml(asset.brand)} ${escapeHtml(asset.model)}
                                    </div>
                                    <div style="color: #666; font-size: 12px; margin-bottom: 2px;">
                                        ${escapeHtml(asset.description || '')}
                                    </div>
                                    <div style="color: #999; font-size: 10px; font-style: italic;">
                                        Model requirement - assign specific assets during preparation
                                    </div>
                                </div>
                                <div style="display: flex; gap: 5px;">
                                    <button class="btn btn-warning edit-model-qty-btn" style="padding: 3px 6px; font-size: 10px;" 
                                            data-event-id="${event.id}" 
                                            data-brand="${escapeHtml(asset.brand)}" 
                                            data-model="${escapeHtml(asset.model)}" 
                                            data-department="${escapeHtml(dept)}">Edit Qty</button>
                                    <button class="btn btn-danger remove-model-btn" style="padding: 3px 6px; font-size: 10px;" 
                                            data-event-id="${event.id}" 
                                            data-brand="${escapeHtml(asset.brand)}" 
                                            data-model="${escapeHtml(asset.model)}" 
                                            data-department="${escapeHtml(dept)}">Remove</button>
                                </div>
                            </div>
                        `;
              } else if (asset.isLoanOrMisc) {
                // Loan/Misc item
                const extraBadge = asset.isExtra ? '<span style="background: #fff3cd; color: #856404; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 10px;">EXTRA</span>' : '';
                
                content += `
                            <div style="padding: 10px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <span>${statusIcon} ${escapeHtml(asset.id)}</span>
                                    ${extraBadge}
                                    <div style="color: ${statusColor}; font-size: 11px; margin-top: 2px;">${statusText}</div>
                                </div>
                                <button class="btn btn-danger remove-asset-btn" style="padding: 4px 8px; font-size: 11px;" 
                                        data-event-id="${event.id}" 
                                        data-asset-id="${escapeHtml(asset.id)}">Remove</button>
                            </div>
                        `;
              } else {
                // Regular asset
                const extraBadge = asset.isExtra ? '<span style="background: #fff3cd; color: #856404; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 10px;">EXTRA</span>' : '';
                
                content += `
                            <div style="padding: 10px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                                <div>
                                    <span>${statusIcon} ${escapeHtml(asset.id)}</span>
                                    <span style="color: #666; font-size: 12px; margin-left: 10px;">${escapeHtml(asset.name || '')}</span>
                                    ${extraBadge}
                                    <div style="color: ${statusColor}; font-size: 11px; margin-top: 2px;">${statusText}</div>
                                </div>
                                <button class="btn btn-danger remove-asset-btn" style="padding: 4px 8px; font-size: 11px;" 
                                        data-event-id="${event.id}" 
                                        data-asset-id="${escapeHtml(asset.id)}">Remove</button>
                            </div>
                        `;
              }
            });
          }
        });
    } else {
      content += '<p style="text-align: center; color: #666; padding: 40px;">No assets assigned to this event.</p>';
    }

    content += `
                    </div>
                </div>
                
                <div>
                    <h4 style="color: #495057; margin-bottom: 15px;">Add Assets</h4>
                    <div class="form-group">
                        <input type="text" class="form-input" placeholder="Search available assets..." 
                               onkeyup="filterAvailableAssetsSimple(this.value)" id="edit-asset-search">
                    </div>
                    <div id="available-assets-simple" style="border: 1px solid #e9ecef; border-radius: 8px; max-height: 300px; overflow-y: auto;">
                        <p style="text-align: center; color: #666; padding: 20px;">Type to search for available assets...</p>
                    </div>
                </div>
            </div>
        `;

    document.getElementById("eventDetailsContent").innerHTML = content;
    openModal("eventDetailsModal");

    // Load available assets for the assets tab
    loadAvailableAssetsForEdit(event.id);
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

// Load assets for editing (simplified)
async function loadEditEventAssets(eventId) {
  try {
    const [eventResponse, availableAssetsResponse] = await Promise.all([
      apiCall(`/api/events/${eventId}`),
      apiCall("/api/assets/available"),
    ]);

    const event = eventResponse.data;
    const availableAssets = availableAssetsResponse.data;

    // Build simplified assets interface
    let content = `
            <div class="simplified-assets-interface">
                <!-- Current Asset Models -->
                <div style="margin-bottom: 30px;">
                    <h4 style="color: #495057; margin-bottom: 15px;">Assets Required for Event</h4>
                    <div id="current-asset-models" style="border: 1px solid #e9ecef; border-radius: 8px; min-height: 200px;">
        `;

    // Group current assets by model for simplified display
    const assetModels = {};
    if (event.preparedItems && event.preparedItems.length > 0) {
      // Process current assets to show simplified model counts
      event.preparedItems.forEach((assetId) => {
        // For now, just show individual assets - we'll enhance this later
        content += `
                    <div style="padding: 10px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                        <span>${assetId}</span>
                        <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="removeAssetFromEvent(${eventId}, '${assetId}')">Remove</button>
                    </div>
                `;
      });
    } else {
      content +=
        '<p style="text-align: center; color: #666; padding: 40px;">No assets assigned to this event.</p>';
    }

    content += `
                    </div>
                </div>
                
                <!-- Add Asset Models -->
                <div>
                    <h4 style="color: #495057; margin-bottom: 15px;">Add Assets</h4>
                    <div class="form-group">
                        <input type="text" class="form-input" id="addAssetSearch" 
                               placeholder="Search available assets..." 
                               onkeyup="filterAddAssets()">
                    </div>
                    <div id="available-assets-simplified" style="border: 1px solid #e9ecef; border-radius: 8px; max-height: 300px; overflow-y: auto;">
        `;

    // Show available assets in simplified format
    const assetsByModel = {};
    availableAssets.forEach((asset) => {
      const modelKey = `${asset.brand} ${asset.model}`;
      if (!assetsByModel[modelKey]) {
        assetsByModel[modelKey] = {
          model: modelKey,
          department: asset.department,
          count: 0,
          description: asset.description,
          assets: [],
        };
      }
      assetsByModel[modelKey].count++;
      assetsByModel[modelKey].assets.push(asset);
    });

    Object.values(assetsByModel).forEach((modelGroup) => {
      const deptInfo = getDepartmentInfo(modelGroup.department);
      content += `
                <div class="model-group" style="padding: 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-weight: 500;">${modelGroup.model}</div>
                        <div style="color: #666; font-size: 12px;">${
                          modelGroup.description
                        }</div>
                        <span class="asset-badge dept-${modelGroup.department.toLowerCase()}">${
        modelGroup.department
      }</span>
                        <span style="color: #999; font-size: 11px; margin-left: 10px;">${
                          modelGroup.count
                        } available</span>
                    </div>
                    <button class="btn btn-success" style="padding: 6px 12px; font-size: 12px;" onclick="addAssetModelToEvent(${eventId}, '${
        modelGroup.model
      }', '${modelGroup.department}')">Add One</button>
                </div>
            `;
    });

    content += `
                    </div>
                </div>
            </div>
        `;

    document.getElementById("editEventAssetsContent").innerHTML = content;
  } catch (error) {
    showNotification("error", "Failed to load assets for editing");
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
    const response = await apiCall("/api/assets/available");
    const availableAssets = response.data;

    // Store for search functionality
    window.currentEditAvailableAssets = availableAssets;
    window.currentEditEventId = eventId;
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
        `Only ${maxCanAdd} ${brand} ${model} available. You requested ${requestedQuantity}.`
      );

      // Update the input to show max available
      if (qtyInput) {
        qtyInput.value = Math.max(1, maxCanAdd);
        qtyInput.max = maxCanAdd;
      }
      return;
    }

    if (maxCanAdd === 0) {
      showNotification("error", `No ${brand} ${model} available.`);

      // Remove the model from search results
      if (qtyInput) {
        const modelElement = qtyInput.closest('div[style*="padding: 12px"]');
        if (modelElement) {
          modelElement.remove();
        }
      }
      return;
    }

    // Proceed with adding the model
    await apiCall(`/api/events/${eventId}/models`, "POST", {
      brand: brand,
      model: model,
      department: department,
      description: description,
      quantity: requestedQuantity,
    });

    showNotification(
      "success",
      `Added ${requestedQuantity}x ${brand} ${model} to event`
    );

    // Update available count in the search results
    const newCount = Math.max(0, availableCount - requestedQuantity);

    // Update the display
    if (newCount <= 0) {
      // Remove the entire model row if no more available
      if (qtyInput) {
        const modelElement = qtyInput.closest('div[style*="padding: 12px"]');
        if (modelElement) {
          modelElement.remove();
        }
      }
    } else {
      // Update the available count
      if (qtyInput) {
        const countSpan = qtyInput.parentElement.parentElement.querySelector(
          'span[style*="color: #28a745"]'
        );
        if (countSpan) {
          countSpan.textContent = `${newCount} available`;
        }
        qtyInput.max = newCount;
        qtyInput.value = Math.min(1, newCount);
      }
    }

    // Update available assets list to remove used assets
    if (window.currentEditAvailableAssets) {
      let removedCount = 0;
      window.currentEditAvailableAssets =
        window.currentEditAvailableAssets.filter((asset) => {
          if (
            asset.brand === brand &&
            asset.model === model &&
            removedCount < requestedQuantity
          ) {
            removedCount++;
            return false;
          }
          return true;
        });
    }

    // Update only the current assets section (preserves search box)
    await updateCurrentAssetsOnly(eventId);
  } catch (error) {
    showNotification("error", `Failed to add model: ${error.message}`);
  }
}
async function removeModelFromEvent(eventId, brand, model, department) {
  if (!confirm(`Remove all ${brand} ${model} from this event?`)) {
    return;
  }

  try {
    await apiCall(`/api/events/${eventId}/models`, "DELETE", {
      brand: brand,
      model: model,
      department: department,
    });
    await refreshAvailableAssetsAfterRemoval(eventId);
    showNotification("success", `${brand} ${model} removed from event`);

    // Update only the current assets section (preserves search box)
    await updateCurrentAssetsOnly(eventId);

    // Optionally, refresh the search results to show the model as available again
    const searchInput = document.querySelector(
      '#edit-assets-tab input[placeholder="Search available assets..."]'
    );
    if (searchInput && searchInput.value.length >= 2) {
      // Re-trigger the search to update available assets
      filterAvailableAssetsSimple(searchInput.value);
    }
  } catch (error) {
    showNotification("error", `Failed to remove model: ${error.message}`);
  }
}

function editModelQuantity(eventId, brand, model, department) {
  // Find the current quantity
  let currentQuantity = 1;
  const modelElements = document.querySelectorAll(".model-assignment");
  for (let element of modelElements) {
    const text = element.textContent;
    if (text.includes(`${brand} ${model}`)) {
      const qtyMatch = text.match(/(\d+)x/);
      if (qtyMatch) {
        currentQuantity = parseInt(qtyMatch[1]);
        break;
      }
    }
  }

  // Calculate available assets
  const availableAssets = window.currentEditAvailableAssets || [];
  const modelAssets = availableAssets.filter(
    (a) => a.brand === brand && a.model === model
  );
  const maxQuantity = currentQuantity + modelAssets.length;

  // Populate modal
  document.getElementById(
    "editQuantityTitle"
  ).textContent = `Edit Quantity - ${brand} ${model}`;
  document.getElementById(
    "editQuantityLabel"
  ).textContent = `Current quantity: ${currentQuantity}`;
  document.getElementById("editQuantityInput").value = currentQuantity;
  document.getElementById("editQuantityInput").min = 1;
  document.getElementById("editQuantityInput").max = maxQuantity;

  // Show availability info with color coding
  const availableDiv = document.getElementById("editQuantityAvailable");
  if (modelAssets.length === 0) {
    availableDiv.innerHTML = `<span style="color: #dc3545;">⚠️ No additional assets available (max: ${currentQuantity})</span>`;
  } else {
    availableDiv.innerHTML = `<span style="color: #28a745;">✅ ${modelAssets.length} additional available (max: ${maxQuantity})</span>`;
  }

  // Store values in hidden fields
  document.getElementById("editQuantityEventId").value = eventId;
  document.getElementById("editQuantityBrand").value = brand;
  document.getElementById("editQuantityModel").value = model;
  document.getElementById("editQuantityDepartment").value = department;
  document.getElementById("editQuantityCurrentQty").value = currentQuantity;

  // Open modal
  openModal("editQuantityModal");
}

async function updateModelQuantity(
  eventId,
  brand,
  model,
  department,
  newQuantity,
  currentQuantity
) {
  try {
    // Remove the old model assignment
    await apiCall(`/api/events/${eventId}/models`, "DELETE", {
      brand: brand,
      model: model,
      department: department,
    });

    // Add the new model assignment with updated quantity
    await apiCall(`/api/events/${eventId}/models`, "POST", {
      brand: brand,
      model: model,
      department: department,
      description: "", // We'll need to preserve the original description
      quantity: newQuantity,
    });

    showNotification(
      "success",
      `Updated ${brand} ${model} quantity to ${newQuantity}`
    );

    // Update available assets count
    const quantityDifference = newQuantity - currentQuantity;
    if (window.currentEditAvailableAssets) {
      const availableAssets = window.currentEditAvailableAssets;
      const modelAssets = availableAssets.filter(
        (a) => a.brand === brand && a.model === model
      );

      if (quantityDifference > 0) {
        // Quantity increased - remove more assets from available
        let removedCount = 0;
        window.currentEditAvailableAssets =
          window.currentEditAvailableAssets.filter((asset) => {
            if (
              asset.brand === brand &&
              asset.model === model &&
              removedCount < quantityDifference
            ) {
              removedCount++;
              return false;
            }
            return true;
          });
      } else {
        // Quantity decreased - add assets back to available (this is complex, so we'll reload)
        const response = await apiCall("/api/assets/available");
        window.currentEditAvailableAssets = response.data;
      }
    }

    // Update the display
    await updateCurrentAssetsOnly(eventId);

    // Refresh search results if there's an active search
    const searchInput = document.querySelector(
      '#edit-assets-tab input[placeholder="Search available assets..."]'
    );
    if (searchInput && searchInput.value.length >= 2) {
      filterAvailableAssetsSimple(searchInput.value);
    }
  } catch (error) {
    showNotification("error", `Failed to update quantity: ${error.message}`);
  }
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
                            data-description="${escapeHtml(modelGroup.description || '')}"
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
                                            <button class="btn btn-warning" style="padding: 3px 6px; font-size: 10px;" onclick="editModelQuantity(${eventId}, '${brand}', '${model}', '${dept}')">Edit Qty</button>
                                            <button class="btn btn-danger" style="padding: 3px 6px; font-size: 10px;" onclick="removeModelFromEvent(${eventId}, '${brand}', '${model}', '${dept}')">Remove</button>
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

  let value = parseInt(input.value);

  // Check if value is valid
  if (isNaN(value) || value < 1) {
    input.value = 1;
    value = 1;
  }

  if (value > maxAvailable) {
    input.value = maxAvailable;
    value = maxAvailable;
    showNotification("warning", `Maximum ${maxAvailable} available`);
  }

  // Update the input styling based on validity
  if (value > maxAvailable || value < 1) {
    input.style.borderColor = "#dc3545";
    input.style.backgroundColor = "#fff5f5";
  } else {
    input.style.borderColor = "#ddd";
    input.style.backgroundColor = "white";
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
    try {
        await apiCall(`/api/events/${eventId}/assign-specific`, 'POST', { assetId });
        showNotification('success', `Assigned ${assetId} to event`);
        
        // Refresh the preparation modal
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
    editEventAssets(eventId);
  } catch (error) {
    showNotification("error", `Failed to add asset: ${error.message}`);
  }
}

async function removeAssetFromEvent(eventId, assetId) {
  if (
    !confirm(
      `Are you sure you want to remove asset ${assetId} from this event?`
    )
  ) {
    return;
  }

  try {
    // Try the correct endpoint format
    await apiCall(
      `/api/events/${eventId}/assets/${encodeURIComponent(assetId)}`,
      "DELETE"
    );
    showNotification("success", `Asset ${assetId} removed from event`);

    // Just update the specific asset item without full refresh
    const assetElement = document
      .querySelector(
        `[onclick*="removeAssetFromEvent(${eventId}, '${assetId}')"]`
      )
      .closest("div");
    if (assetElement) {
      assetElement.remove();
    }

    // Update the asset count
    const assetsHeader = document.querySelector("#edit-assets-tab h4");
    if (assetsHeader) {
      const currentText = assetsHeader.textContent;
      const currentCount = parseInt(currentText.match(/\d+/)[0]);
      assetsHeader.textContent = `Current Assets (${currentCount - 1})`;
    }
  } catch (error) {
    console.error("Remove asset error:", error);
    showNotification("error", `Failed to remove asset: ${error.message}`);
  }
}

function filterAvailableAssets() {
  const searchTerm =
    document.getElementById("availableAssetsSearch")?.value.toLowerCase() || "";
  const availableAssets = window.currentAvailableAssets || [];

  if (!searchTerm) {
    // Show all assets
    document.querySelectorAll('[class*="available-asset-"]').forEach((el) => {
      el.style.display = "flex";
    });
    return;
  }

  // Hide all assets first
  document.querySelectorAll('[class*="available-asset-"]').forEach((el) => {
    el.style.display = "none";
  });

  // Show matching assets
  availableAssets.forEach((asset) => {
    const searchableText =
      `${asset.id} ${asset.brand} ${asset.model} ${asset.description}`.toLowerCase();
    if (searchableText.includes(searchTerm)) {
      const element = document.querySelector(`.available-asset-${asset.id}`);
      if (element) {
        element.style.display = "flex";
      }
    }
  });
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
        <div class="form-group">
            <strong>Out of Commission:</strong> ${asset.isOOC ? "Yes" : "No"}
        </div>
    `;

  document.getElementById("assetDetailsContent").innerHTML = content;
  openModal("assetDetailsModal");
}

async function editAsset(assetId) {
  showNotification("info", `Edit asset ${assetId} - Feature coming soon`);
}

function viewContainer(containerId) {
  showNotification(
    "info",
    `View container ${containerId} - Feature coming soon`
  );
}

function editContainer(containerId) {
  showNotification(
    "info",
    `Edit container ${containerId} - Feature coming soon`
  );
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
                                <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="removeAssetFromEvent(${event.id}, '${asset.id}')">Remove</button>
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
              editModelQuantity(eventId, brand, model, department);
          }
      }
    
    if (e.target.classList.contains('remove-model-btn')) {
        e.preventDefault();
        const eventId = parseInt(e.target.getAttribute('data-event-id'));
        const brand = e.target.getAttribute('data-brand');
        const model = e.target.getAttribute('data-model');
        const department = e.target.getAttribute('data-department');
        
        if (eventId && brand && model && department) {
            removeModelFromEvent(eventId, brand, model, department);
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
      } catch (error) {
        showNotification("error", "Failed to update event");
      }
    }
  });

  // Prepare Asset Form
  document
    .getElementById("prepareAssetForm")
    .addEventListener("submit", async function (e) {
      e.preventDefault();

      const eventId = document.getElementById("prepareEventId").value;
      const assetId = document.getElementById("prepareAssetId").value;

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
        document.getElementById("prepareAssetForm").reset();
      } catch (error) {
        showNotification("error", "Failed to prepare asset");
      }
    });

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
  document
    .getElementById("bulkOOCForm")
    .addEventListener("submit", async function (e) {
      e.preventDefault();

      if (selectedOOCAssets.size === 0) {
        showNotification("warning", "No assets selected");
        return;
      }

      const logEntry = document.getElementById("bulkOOCLogEntry").value.trim();
      const newLocation = document.getElementById("bulkOOCNewLocation").value.trim();

      if (!logEntry) {
        showNotification("warning", "Please enter a maintenance description");
        return;
      }

      try {
        let successCount = 0;
        let errorCount = 0;
        
        // Process each selected asset
        for (const assetId of selectedOOCAssets) {
          try {
            await apiCall(`/api/assets/${encodeURIComponent(assetId)}/maintain`, "POST", {
              logEntry,
              newLocation: newLocation || "Store", // Default to Store if no location specified
              markOOC: false,
              unmarkOOC: true
            });
            successCount++;
          } catch (error) {
            console.error(`Failed to clear OOC for ${assetId}:`, error);
            errorCount++;
          }
        }

        closeModal("bulkOOCModal");
        
        if (successCount > 0) {
          const locationText = newLocation ? `and moved to ${newLocation}` : "and moved to Store";
          showNotification("success", `Cleared OOC status for ${successCount} asset${successCount > 1 ? 's' : ''} ${locationText}`);
        }
        
        if (errorCount > 0) {
          showNotification("error", `Failed to clear OOC status for ${errorCount} asset${errorCount > 1 ? 's' : ''}`);
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
        showNotification("error", "Failed to clear OOC status");
        console.error("Bulk OOC clear error:", error);
      }
    });

  // Maintenance Form
  document
  .getElementById("maintenanceForm")
  .addEventListener("submit", async function (e) {
    e.preventDefault();

    if (selectedMaintenanceAssets.size === 0) {
      showNotification("warning", "Please select at least one asset");
      return;
    }

    const logEntry = document.getElementById("maintenanceLogEntry").value.trim();
    const newLocation = document.getElementById("maintenanceNewLocation").value.trim();
    const oocStatusEl = document.querySelector('input[name="oocStatus"]:checked');
    
    if (!oocStatusEl) {
      showNotification("warning", "Please select an OOC status option");
      return;
    }
    
    const oocStatus = oocStatusEl.value;

    if (!logEntry) {
      showNotification("warning", "Please enter a maintenance log entry");
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
            logEntry,
            newLocation: newLocation || null,
            markOOC: oocStatus === 'mark',
            unmarkOOC: oocStatus === 'unmark'
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
        showNotification("success", `Maintenance logged for ${successCount} asset${successCount > 1 ? 's' : ''}`);
      }
      
      if (errorCount > 0) {
        console.error('Maintenance errors:', errors);
        showNotification("error", `Failed to log maintenance for ${errorCount} asset${errorCount > 1 ? 's' : ''}. Check console for details.`);
      }

      // Refresh maintenance view if it's active
      if (document.getElementById("maintenance-section").classList.contains("active")) {
        loadMaintenanceAssets();
      }

      // Refresh inventory view if it's active
      if (document.getElementById("inventory-section").classList.contains("active")) {
        loadInventory();
      }

      // Clear selections
      selectedMaintenanceAssets.clear();

    } catch (error) {
      showNotification("error", "Failed to log maintenance");
      console.error("Maintenance error:", error);
    }
  });

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
      // ... existing code ...
      
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
  });
  
  // Edit Quantity Form
  document
    .getElementById("editQuantityForm")
    .addEventListener("submit", async function (e) {
      e.preventDefault();

      const eventId = document.getElementById("editQuantityEventId").value;
      const brand = document.getElementById("editQuantityBrand").value;
      const model = document.getElementById("editQuantityModel").value;
      const department = document.getElementById(
        "editQuantityDepartment"
      ).value;
      const currentQuantity = parseInt(
        document.getElementById("editQuantityCurrentQty").value
      );
      const newQuantity = parseInt(
        document.getElementById("editQuantityInput").value
      );

      if (newQuantity === currentQuantity) {
        closeModal("editQuantityModal");
        return;
      }

      try {
        // Remove the old model assignment
        await apiCall(`/api/events/${eventId}/models`, "DELETE", {
          brand: brand,
          model: model,
          department: department,
        });

        // Add the new model assignment with updated quantity
        await apiCall(`/api/events/${eventId}/models`, "POST", {
          brand: brand,
          model: model,
          department: department,
          description: "", // Description will be preserved by backend
          quantity: newQuantity,
        });

        closeModal("editQuantityModal");
        showNotification(
          "success",
          `Updated ${brand} ${model} quantity to ${newQuantity}`
        );

        // Update available assets count
        const quantityDifference = newQuantity - currentQuantity;
        if (window.currentEditAvailableAssets) {
          if (quantityDifference > 0) {
            // Quantity increased - remove more assets from available
            let removedCount = 0;
            window.currentEditAvailableAssets =
              window.currentEditAvailableAssets.filter((asset) => {
                if (
                  asset.brand === brand &&
                  asset.model === model &&
                  removedCount < quantityDifference
                ) {
                  removedCount++;
                  return false;
                }
                return true;
              });
          } else {
            // Quantity decreased - reload available assets
            const response = await apiCall("/api/assets/available");
            window.currentEditAvailableAssets = response.data;
          }
        }

        // Update the display
        await updateCurrentAssetsOnly(eventId);

        // Refresh search results if there's an active search
        const searchInput = document.querySelector(
          '#edit-assets-tab input[placeholder="Search available assets..."]'
        );
        if (searchInput && searchInput.value.length >= 2) {
          filterAvailableAssetsSimple(searchInput.value);
        }
      } catch (error) {
        showNotification(
          "error",
          `Failed to update quantity: ${error.message}`
        );
      }
    });
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
  const assetSearchEl = document.getElementById('maintenanceAssetSearch');
  const availableAssetsEl = document.getElementById('availableMaintenanceAssets');
  const noChangeRadio = document.querySelector('input[name="oocStatus"][value="nochange"]');
  
  if (!logEntryEl || !newLocationEl || !assetSearchEl || !availableAssetsEl) {
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
    const searchableText = `${asset.id} ${asset.brand} ${asset.model} ${asset.serial || ''} ${asset.description || ''}`.toLowerCase();
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
          <div style="color: #999; font-size: 12px;">${escapeHtml(asset.description || '')}</div>
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
    const searchableText = `${asset.id} ${asset.brand} ${asset.model} ${asset.serial || ''} ${asset.description || ''}`.toLowerCase();
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
          <div style="color: #999; font-size: 12px;">${asset.description || ''}</div>
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
    const oocAssets = response.data.filter(asset => asset.isOOC);
    
    displayOOCAssets(oocAssets);
    
    // Set up search functionality
    const searchInput = document.getElementById("ooc-search");
    if (searchInput) {
      searchInput.removeEventListener("input", filterOOCAssets);
      searchInput.addEventListener("input", filterOOCAssets);
    }
    
  } catch (error) {
    document.getElementById("ooc-assets-list").innerHTML =
      '<p style="color: red; text-align: center;">Error loading OOC assets</p>';
  }
}

function displayOOCAssets(oocAssets) {
  const container = document.getElementById("ooc-assets-list");

  if (oocAssets.length === 0) {
    container.innerHTML =
      '<p style="text-align: center; color: #666; padding: 40px;">🎉 No assets are currently marked as Out of Commission!</p>';
    return;
  }

  let tableHTML = `
    <div style="margin-bottom: 15px; padding: 10px; background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px;">
      <strong>📋 Instructions:</strong> Select the assets that have been repaired/fixed and are ready to return to service. 
      You can select multiple assets and clear their OOC status together.
    </div>
    <table class="table">
      <thead>
        <tr>
          <th style="width: 40px;">
            <input type="checkbox" id="selectAllOOC" onchange="toggleAllOOCSelection()" class="ooc-asset-checkbox">
          </th>
          <th>Asset ID</th>
          <th>Brand</th>
          <th>Model</th>
          <th>Description</th>
          <th>Location</th>
          <th>Last Maintenance</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
  `;

  oocAssets.forEach((asset) => {
    const lastMaintenance =
      asset.maintenanceLogs && asset.maintenanceLogs.length > 0
        ? asset.maintenanceLogs[asset.maintenanceLogs.length - 1].split("\t")[0]
        : "Never";

    const isSelected = selectedOOCAssets.has(asset.id);

    tableHTML += `
      <tr class="ooc-asset-item ${isSelected ? 'selected' : ''}" onclick="toggleOOCAssetSelection('${asset.id}')">
        <td>
          <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleOOCAssetSelection('${asset.id}')" onclick="event.stopPropagation()" class="ooc-asset-checkbox">
        </td>
        <td style="font-weight: 500;">${asset.id}</td>
        <td>${asset.brand}</td>
        <td>${asset.model}</td>
        <td>${asset.description || 'N/A'}</td>
        <td>${asset.location || "Store"}</td>
        <td style="font-size: 12px;">${lastMaintenance}</td>
        <td>
          <button class="btn btn-success" style="padding: 4px 8px; font-size: 11px;" onclick="event.stopPropagation(); clearSingleOOC('${asset.id}')">
            Clear OOC
          </button>
        </td>
      </tr>
    `;
  });

  tableHTML += "</tbody></table>";
  container.innerHTML = tableHTML;
  
  updateBulkOOCButton();
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

function updateBulkOOCButton() {
  const button = document.getElementById("bulk-clear-ooc-btn");
  if (button) {
    button.disabled = selectedOOCAssets.size === 0;
    button.textContent = selectedOOCAssets.size > 0 
      ? `Clear OOC Status (${selectedOOCAssets.size})` 
      : 'Clear OOC Status';
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
  
  countElement.textContent = selectedOOCAssets.size;
  
  if (selectedOOCAssets.size === 0) {
    containerElement.innerHTML = '<div style="color: #666; font-style: italic;">No assets selected</div>';
    return;
  }
  
  let html = '<div style="display: grid; gap: 8px;">';
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
    }
  });
  html += '</div>';
  
  containerElement.innerHTML = html;
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
  
  // Show asset info
  const assetInfoDiv = document.getElementById('singleOOCAssetInfo');
  assetInfoDiv.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px;">
      <div><strong>Asset ID:</strong> ${asset.id}</div>
      <div><strong>Brand:</strong> ${asset.brand}</div>
      <div><strong>Model:</strong> ${asset.model}</div>
      <div><strong>Current Location:</strong> ${asset.location || 'Store'}</div>
    </div>
    ${asset.description ? `<div style="margin-top: 8px;"><strong>Description:</strong> ${asset.description}</div>` : ''}
  `;
  
  // Open the modal
  openModal('singleOOCModal');
}

async function processSingleOOCClear() {
  const assetId = document.getElementById('singleOOCAssetId').value;
  const logEntry = document.getElementById('singleOOCLogEntry').value.trim();
  const newLocation = document.getElementById('singleOOCNewLocation').value.trim();
  
  if (!logEntry) {
    showNotification("warning", "Please enter a maintenance description");
    return;
  }
  
  if (!newLocation) {
    showNotification("warning", "Please enter a location");
    return;
  }
  
  try {
    await apiCall(`/api/assets/${encodeURIComponent(assetId)}/maintain`, "POST", {
      logEntry: logEntry,
      newLocation: newLocation,
      markOOC: false,
      unmarkOOC: true
    });
    
    closeModal('singleOOCModal');
    showNotification("success", `Cleared OOC status for ${assetId} and moved to ${newLocation}`);
    
    // Refresh the OOC list
    loadOOCAssets();
    
    // Remove from selection if it was selected
    selectedOOCAssets.delete(assetId);
    updateBulkOOCButton();
    
  } catch (error) {
    showNotification("error", `Failed to clear OOC status: ${error.message}`);
  }
}

async function viewMaintenanceLog(assetId) {
  try {
    // Get the asset details
    const asset = assets.find(a => a.id === assetId);
    if (!asset) {
      showNotification('error', 'Asset not found');
      return;
    }
    
    // Create and show the maintenance log modal
    showMaintenanceLogModal(asset);
    
  } catch (error) {
    console.error('Error viewing maintenance log:', error);
    showNotification('error', 'Failed to load maintenance log');
  }
}

function showMaintenanceLogModal(asset) {
  // Create modal content
  const modalContent = `
    <div class="modal" id="maintenanceLogModal" style="display: flex; align-items: center; justify-content: center;">
      <div class="modal-content" style="max-width: 800px; width: 90%; max-height: 80vh; overflow-y: auto;">
        <div class="modal-header">
          <h3 class="modal-title">Maintenance Log - ${asset.id}</h3>
          <button class="close-btn" onclick="closeMaintenanceLogModal()">&times;</button>
        </div>
        <div class="modal-body">
          <!-- Asset Info -->
          <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
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
                <strong>OOC:</strong> ${asset.isOOC ? '<span style="color: #dc3545;">Yes</span>' : '<span style="color: #28a745;">No</span>'}
              </div>
            </div>
          </div>
          
          <!-- Maintenance Log -->
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
              <h4 style="margin: 0; color: #495057;">Maintenance History</h4>
              <button class="btn btn-primary" onclick="closeMaintenanceLogModal(); openMaintenanceModalForAsset('${asset.id}')">
                Log New Maintenance
              </button>
            </div>
            
            ${createMaintenanceLogTable(asset)}
          </div>
        </div>
        <div style="text-align: right; margin-top: 20px; padding-top: 15px; border-top: 1px solid #e9ecef;">
          <button class="btn btn-secondary" onclick="closeMaintenanceLogModal()">Close</button>
        </div>
      </div>
    </div>
  `;
  
  // Remove existing modal if any
  const existingModal = document.getElementById('maintenanceLogModal');
  if (existingModal) {
    existingModal.remove();
  }
  
  // Add modal to body
  document.body.insertAdjacentHTML('beforeend', modalContent);
  
  // Show modal
  document.getElementById('maintenanceLogModal').style.display = 'flex';
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
  const sortedLogs = [...asset.maintenanceLogs].reverse();
  
  let tableHTML = `
    <div style="border: 1px solid #e9ecef; border-radius: 8px; overflow: hidden;">
      <table class="table" style="margin: 0;">
        <thead style="background: #f8f9fa;">
          <tr>
            <th style="width: 120px;">Date</th>
            <th style="width: 100px;">User</th>
            <th>Maintenance Description</th>
          </tr>
        </thead>
        <tbody>
  `;
  
  sortedLogs.forEach((log, index) => {
    const parts = log.split('\t');
    if (parts.length >= 3) {
      const date = parts[0];
      const user = parts[1];
      const description = parts.slice(2).join('\t'); // In case description contains tabs
      
      // Alternate row colors
      const rowClass = index % 2 === 0 ? '' : 'style="background: #f8f9fa;"';
      
      tableHTML += `
        <tr ${rowClass}>
          <td style="font-size: 13px; color: #666;">${date}</td>
          <td style="font-size: 13px;"><strong>${user}</strong></td>
          <td style="font-size: 14px;">${description}</td>
        </tr>
      `;
    }
  });
  
  tableHTML += `
        </tbody>
      </table>
    </div>
    <div style="margin-top: 10px; text-align: center; color: #666; font-size: 12px;">
      Showing ${sortedLogs.length} maintenance record${sortedLogs.length !== 1 ? 's' : ''}
    </div>
  `;
  
  return tableHTML;
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
    
    let section = `
        <div class="model-prep-section" style="border: 1px solid #e9ecef; border-radius: 8px; padding: 15px; margin-bottom: 15px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <div>
                    <h5 style="margin: 0; color: #495057;">${requiredQty}x ${escapeHtml(brand)} ${escapeHtml(model)}</h5>
                    <div style="color: #666; font-size: 12px; margin-top: 2px;">${escapeHtml(description)}</div>
                </div>
                <div style="text-align: right;">
                    <div style="font-size: 14px; font-weight: 500; color: ${assignedCount >= requiredQty ? '#28a745' : '#ffc107'};">
                        ${assignedCount}/${requiredQty} assigned
                        ${assignedCount > requiredQty ? ` (+${assignedCount - requiredQty} extra)` : ''}
                    </div>
                    <div style="background: #e9ecef; border-radius: 10px; height: 4px; width: 120px; overflow: hidden; margin-top: 4px;">
                        <div style="background: ${assignedCount >= requiredQty ? '#28a745' : '#ffc107'}; height: 100%; width: ${Math.min(progressPercent, 100)}%; transition: width 0.3s ease;"></div>
                    </div>
                </div>
            </div>
    `;
    
    // Show assigned assets first
    if (assignedAssets.length > 0) {
        section += `
            <div style="margin-bottom: 15px;">
                <h6 style="color: #495057; margin-bottom: 10px;">Assigned Assets:</h6>
                <div style="background: #d4edda; border-radius: 4px; padding: 10px;">
        `;
        
        assignedAssets.forEach((assetId, index) => {
            const asset = availableAssets.find(a => a.id === assetId);
            const isExtra = index >= requiredQty;
            const bgColor = isExtra ? '#fff3cd' : '#d4edda';
            const textColor = isExtra ? '#856404' : '#155724';
            
            if (asset) {
                section += `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; padding: 4px 8px; background: ${bgColor}; border-radius: 3px;">
                        <span style="color: ${textColor};">
                            ${isExtra ? '➕' : '✅'} ${escapeHtml(assetId)} (SN: ${escapeHtml(asset.serial || 'N/A')})
                            ${isExtra ? ' <span style="font-size: 10px;">(EXTRA)</span>' : ''}
                        </span>
                        <button class="btn btn-warning unassign-btn" style="padding: 2px 6px; font-size: 10px;" 
                                data-event-id="${eventId}" 
                                data-asset-id="${escapeHtml(assetId)}" 
                                data-brand="${escapeHtml(brand)}" 
                                data-model="${escapeHtml(model)}">Unprepare</button>
                    </div>
                `;
            } else {
                section += `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; padding: 4px 8px; background: ${bgColor}; border-radius: 3px;">
                        <span style="color: ${textColor};">
                            ${isExtra ? '➕' : '✅'} ${escapeHtml(assetId)}
                            ${isExtra ? ' <span style="font-size: 10px;">(EXTRA)</span>' : ''}
                        </span>
                        <button class="btn btn-warning unassign-btn" style="padding: 2px 6px; font-size: 10px;" 
                                data-event-id="${eventId}" 
                                data-asset-id="${escapeHtml(assetId)}" 
                                data-brand="${escapeHtml(brand)}" 
                                data-model="${escapeHtml(model)}">Unprepare</button>
                    </div>
                `;
            }
        });
        
        section += '</div></div>';
    }
    
    // Show available assets for assignment
    section += `
        <div style="margin-bottom: 15px;">
            <h6 style="color: #495057; margin-bottom: 10px;">Available ${escapeHtml(brand)} ${escapeHtml(model)} (${availableAssets.length} total):</h6>
            <div style="max-height: 200px; overflow-y: auto; border: 1px solid #e9ecef; border-radius: 4px;">
    `;
    
    if (availableAssets.length === 0) {
        section += '<p style="text-align: center; color: #666; padding: 20px;">No available assets of this model</p>';
    } else {
        availableAssets.forEach(asset => {
            const isAssigned = assignedAssets.includes(asset.id);
            if (!isAssigned) {
                section += `
                    <div style="padding: 8px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <span style="font-weight: 500;">${escapeHtml(asset.id)}</span>
                            <span style="color: #666; font-size: 12px; margin-left: 10px;">SN: ${escapeHtml(asset.serial || 'N/A')}</span>
                            <span style="color: #999; font-size: 11px; margin-left: 10px;">📍 ${escapeHtml(asset.location || 'Store')}</span>
                        </div>
                        <div>
                            <button class="btn btn-success assign-btn" style="padding: 4px 8px; font-size: 11px;" 
                                    data-event-id="${eventId}" 
                                    data-asset-id="${escapeHtml(asset.id)}" 
                                    data-brand="${escapeHtml(brand)}" 
                                    data-model="${escapeHtml(model)}">Assign</button>
                        </div>
                    </div>
                `;
            }
        });
    }
    
    section += '</div></div>';
    section += '</div>';
    return section;
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
    // Set current user
    document.getElementById("current-user").textContent = "Admin"; // This would come from session

    // Set today's date as default for event forms
    const today = new Date().toISOString().split("T")[0];
    const startDateEl = document.getElementById("eventStartDate");
    const endDateEl = document.getElementById("eventEndDate");

    if (startDateEl) startDateEl.value = today;
    if (endDateEl) endDateEl.value = today;

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