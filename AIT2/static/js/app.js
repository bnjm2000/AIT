// Global variables
let currentUser = null;
let events = [];
let assets = [];
let containers = [];
let logs = [];
let stats = {};

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
            <div class="event-state state-${event.state.toLowerCase()}">${event.state}</div>
        </div>
        <div class="event-title">${event.name}</div>
        <div class="event-date">${dateRange}</div>
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
      modelSummary += `<div>${statusIcon} ${model.requiredQuantity}x ${model.brand} ${model.model} (${assignedCount}/${model.requiredQuantity})</div>`;
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
            <div class="event-state state-${event.state.toLowerCase()}">${
    event.state
  }</div>
        </div>
        <div class="event-title">${event.name}</div>
        <div class="event-date">${dateRange}</div>
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
            <button class="btn btn-success" onclick="openPrepareEventModal(${
              event.id
            })">Prepare Assets</button>
            <button class="btn btn-primary" onclick="viewEvent(${
              event.id
            })">View Details</button>
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
                
                <!-- Prepare Assigned Assets -->
                <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #e9ecef;">
                    <h4 style="color: #495057; margin-bottom: 15px;">All Assigned Assets</h4>
                    <p style="color: #666; font-size: 14px; margin-bottom: 15px;">Scan or enter any asset ID assigned to this event to mark as prepared</p>
                    <div class="form-group">
                        <input type="text" class="form-input" id="assignedAssetPrepare" 
                               placeholder="Enter Asset ID or Serial Number..." 
                               onkeypress="if(event.key==='Enter') prepareAssignedAsset(${eventId})">
                        <button class="btn btn-success" style="margin-top: 10px;" onclick="prepareAssignedAsset(${eventId})">Mark as Prepared</button>
                    </div>
        `;

        // Show all assigned assets with their preparation status
        if (event.assetsByDepartment && Object.keys(event.assetsByDepartment).length > 0) {
            content += `
                        <div style="border: 1px solid #e9ecef; border-radius: 8px; max-height: 300px; overflow-y: auto; margin-top: 15px;">
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
                
                <!-- Assign Additional Assets -->
                <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #e9ecef;">
                    <h4 style="color: #495057; margin-bottom: 15px;">Assign Additional Assets</h4>
                    <p style="color: #666; font-size: 14px; margin-bottom: 15px;">Search and assign any available asset to this event (will be shown as extra assets)</p>
                    <div class="form-group">
                        <input type="text" class="form-input" id="additionalAssetSearch" 
                               placeholder="Search any available asset..." 
                               onkeyup="searchAdditionalAssets(${eventId})">
                    </div>
                    <div id="additional-assets-results" style="border: 1px solid #e9ecef; border-radius: 8px; max-height: 300px; overflow-y: auto; min-height: 50px;">
                        <p style="text-align: center; color: #666; padding: 20px;">Type to search for any available asset...</p>
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

async function loadReturnEvents() {
  try {
    const response = await apiCall("/api/events");
    const returnableEvents = response.data.filter(
      (event) => event.state === "Ready" || event.state === "Returning"
    );

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

  const returnedCount = event.returnedItems?.length || 0;
  const totalCount = event.assetCount || 0;

  card.innerHTML = `
        <div class="event-header">
            <div class="event-id">ID: ${event.id}</div>
            <div class="event-state state-${event.state.toLowerCase()}">${
    event.state
  }</div>
        </div>
        <div class="event-title">${event.name}</div>
        <div class="event-date">${dateRange}</div>
        <div style="margin: 15px 0;">
            <small style="color: #666;">${returnedCount}/${totalCount} assets returned</small>
        </div>
        <div class="event-actions">
            <button class="btn btn-warning" onclick="openReturnAssetModal(${
              event.id
            })">Return Asset</button>
            <button class="btn btn-primary" onclick="viewEvent(${
              event.id
            })">View Details</button>
        </div>
    `;

  return card;
}

async function loadTransferHistory() {
  try {
    const response = await apiCall("/api/events");
    const activeEvents = response.data.filter(
      (event) => event.state !== "Closed" && event.assetCount > 0
    );

    const container = document.getElementById("transfer-history");
    container.innerHTML = `
            <h3 style="margin-bottom: 20px; color: #764ba2;">Active Events Available for Transfer</h3>
            <div class="events-grid" id="transfer-events-list"></div>
        `;

    const eventsList = document.getElementById("transfer-events-list");

    if (activeEvents.length === 0) {
      eventsList.innerHTML =
        '<p style="text-align: center; color: #666; padding: 40px;">No active events with assets available for transfer.</p>';
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
            <div class="event-state state-${event.state.toLowerCase()}">${
    event.state
  }</div>
        </div>
        <div class="event-title">${event.name}</div>
        <div class="event-date">${dateRange}</div>
        <div style="margin: 15px 0;">
            <small style="color: #666;">${
              event.assetCount || 0
            } assets assigned</small>
        </div>
        <div class="event-actions">
            <button class="btn btn-primary" onclick="viewEvent(${
              event.id
            })">View Assets</button>
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
            <div class="form-group">
                <strong>Date Range:</strong> ${dateRange}
            </div>
            <div class="form-group">
                <strong>State:</strong> <span class="asset-badge status-${event.state.toLowerCase()}">${
      event.state
    }</span>
            </div>
            <div class="form-group">
                <strong>Total Assets:</strong> ${event.totalAssets}
            </div>
            <div class="form-group">
                <strong>Prepared Assets:</strong> ${event.totalPrepared}
            </div>
            <div class="form-group">
                <strong>Returned Assets:</strong> ${event.totalReturned}
            </div>
        `;

    // Add individual assets section
    if (event.assetsByDepartment && Object.keys(event.assetsByDepartment).length > 0) {
      content += '<div class="form-group"><strong>All Assets:</strong>';

      // Group by department
      Object.keys(event.assetsByDepartment)
        .sort()
        .forEach((dept) => {
          const assets = event.assetsByDepartment[dept];
          
          // Filter out model assignments for this section
          const individualAssets = assets.filter(asset => !asset.id.startsWith('[MODEL]'));
          
          if (individualAssets.length > 0) {
            content += `<h4 style="margin-top: 20px; margin-bottom: 10px; color: #495057;">${escapeHtml(dept)} Department</h4>`;

            individualAssets.forEach((asset) => {
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

              // Add extra badge if it's an extra asset
              const extraBadge = asset.isExtra ? 
                '<span style="background: #fff3cd; color: #856404; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 10px;">EXTRA</span>' : '';

              content += `
                <div style="border: 1px solid #e9ecef; border-radius: 8px; margin-bottom: 10px; padding: 12px; background: white;">
                  <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                      <span style="font-weight: 500;">${statusIcon} ${escapeHtml(asset.id)}</span>
                      ${extraBadge}
                      <div style="color: #666; font-size: 12px; margin-top: 2px;">${escapeHtml(asset.name || '')}</div>
                      ${asset.serial ? `<div style="color: #999; font-size: 11px;">SN: ${escapeHtml(asset.serial)}</div>` : ''}
                      ${asset.location ? `<div style="color: #999; font-size: 11px;">📍 ${escapeHtml(asset.location)}</div>` : ''}
                    </div>
                    <div style="text-align: right;">
                      <div style="color: ${statusColor}; font-size: 12px; font-weight: 500;">${statusText}</div>
                    </div>
                  </div>
                </div>
              `;
            });
          }
        });

      content += '</div>';
    }

    // Add model groups with expandable asset lists
    if (event.modelGroups && Object.keys(event.modelGroups).length > 0) {
      content += '<div class="form-group"><strong>Model Requirements:</strong>';

      // Group by department
      const modelsByDept = {};
      Object.values(event.modelGroups).forEach((model) => {
        if (!modelsByDept[model.department]) {
          modelsByDept[model.department] = [];
        }
        modelsByDept[model.department].push(model);
      });

      Object.keys(modelsByDept)
        .sort()
        .forEach((dept) => {
          const models = modelsByDept[dept];
          content += `<h4 style="margin-top: 20px; margin-bottom: 10px; color: #495057;">${escapeHtml(dept)} Department - Model Requirements</h4>`;

          models.forEach((model, index) => {
            const statusIcon = getModelStatusIcon(model.status);
            const assignedCount = model.assignedAssets.length;
            const modelId = `model-${dept}-${index}`;

            content += `
                        <div style="border: 1px solid #e9ecef; border-radius: 8px; margin-bottom: 10px; overflow: hidden;">
                            <div style="background: #f8f9fa; padding: 12px; cursor: pointer; display: flex; justify-content: space-between; align-items: center;"
                                 class="model-toggle" data-model-id="${modelId}" onclick="toggleModelDetailsInView('${modelId}')">
                                <div>
                                    <span style="font-weight: 500;">${statusIcon} ${model.requiredQuantity}x ${escapeHtml(model.brand)} ${escapeHtml(model.model)}</span>
                                    <div style="font-size: 11px; color: #666; margin-top: 2px;">${escapeHtml(model.description || '')}</div>
                                </div>
                                <div style="display: flex; align-items: center; gap: 10px;">
                                    <span style="font-size: 12px; color: #666;">${assignedCount}/${model.requiredQuantity} assigned</span>
                                    <span class="toggle-icon" data-model-id="${modelId}" style="font-size: 12px; cursor: pointer;">▼</span>
                                </div>
                            </div>
                            <div id="${modelId}" class="model-details" style="display: none; padding: 12px; background: white;">
                    `;

            if (model.assignedAssets.length > 0) {
              content +=
                '<div style="margin-bottom: 8px;"><strong>Assigned Assets:</strong></div>';
              model.assignedAssets.forEach((asset) => {
                const assetStatusIcon =
                  asset.status === "returned" ? "↩️" : "✅";

                content += `
                                <div style="padding: 6px 10px; margin: 4px 0; background: ${
                                  asset.status === "returned"
                                    ? "#fff3cd"
                                    : "#d4edda"
                                }; border-radius: 4px; font-size: 13px;">
                                    ${assetStatusIcon} ${escapeHtml(asset.id)}
                                    ${asset.serial ? `<span style="color: #666; margin-left: 10px;">SN: ${escapeHtml(asset.serial)}</span>` : ""}
                                    ${asset.location ? `<span style="color: #999; margin-left: 10px;">📍 ${escapeHtml(asset.location)}</span>` : ""}
                                </div>
                            `;
              });
            } else {
              content +=
                '<div style="color: #999; font-style: italic; font-size: 13px;">No specific assets assigned yet</div>';
            }

            content += "</div></div>";
          });
        });

      content += "</div>";
    }

    document.getElementById("eventDetailsContent").innerHTML = content;

    // Add event listeners for model toggles using event delegation
    document.getElementById("eventDetailsContent").addEventListener('click', function(e) {
      // Check if clicked element or its parent has model-toggle class
      let toggleElement = null;
      
      if (e.target.classList.contains('model-toggle')) {
        toggleElement = e.target;
      } else if (e.target.closest('.model-toggle')) {
        toggleElement = e.target.closest('.model-toggle');
      } else if (e.target.classList.contains('toggle-icon')) {
        // Handle clicks directly on the toggle icon
        const modelId = e.target.getAttribute('data-model-id');
        if (modelId) {
          e.preventDefault();
          e.stopPropagation();
          toggleModelDetailsInView(modelId);
          return;
        }
      }
      
      if (toggleElement) {
        const modelId = toggleElement.getAttribute('data-model-id');
        if (modelId) {
          e.preventDefault();
          e.stopPropagation();
          toggleModelDetailsInView(modelId);
        }
      }
    });

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
    displayMaintenanceAssets(response.data);
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
                    <button class="btn btn-primary" onclick="openMaintenanceModalForAsset('${
                      asset.id
                    }')">Log Maintenance</button>
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
                // Model assignment
                content += `
                            <div class="model-assignment" style="padding: 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center; background: #f8f9fa;">
                                <div>
                                    <span style="font-weight: 500; color: #495057;">📦 ${asset.quantity}x ${escapeHtml(asset.brand)} ${escapeHtml(asset.model)}</span>
                                    <div style="color: #666; font-size: 11px; margin-top: 2px;">${escapeHtml(asset.description || '')}</div>
                                    <div style="color: #999; font-size: 10px; font-style: italic; margin-top: 2px;">Model requirement - assign specific assets during preparation</div>
                                </div>
                                <div style="display: flex; gap: 5px;">
                                    <button class="btn btn-warning" style="padding: 3px 6px; font-size: 10px;" onclick="editModelQuantity(${event.id}, '${escapeHtml(asset.brand)}', '${escapeHtml(asset.model)}', '${escapeHtml(dept)}')">Edit Qty</button>
                                    <button class="btn btn-danger" style="padding: 3px 6px; font-size: 10px;" onclick="removeModelFromEvent(${event.id}, '${escapeHtml(asset.brand)}', '${escapeHtml(asset.model)}', '${escapeHtml(dept)}')">Remove</button>
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
                                <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="removeAssetFromEvent(${event.id}, '${escapeHtml(asset.id)}')">Remove</button>
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
                                <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="removeAssetFromEvent(${event.id}, '${escapeHtml(asset.id)}')">Remove</button>
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
    // Get the quantity from the input field
    const qtyInputId = `qty-${brand.replace(/\s+/g, "")}-${model.replace(
      /\s+/g,
      ""
    )}`;
    const qtyInput = document.getElementById(qtyInputId);
    const requestedQuantity = parseInt(qtyInput.value) || 1;

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
      qtyInput.value = Math.max(1, maxCanAdd);
      qtyInput.max = maxCanAdd;

      return;
    }

    if (maxCanAdd === 0) {
      showNotification("error", `No ${brand} ${model} available.`);

      // Remove the model from search results
      const modelElement = qtyInput.closest('div[style*="padding: 12px"]');
      if (modelElement) {
        modelElement.remove();
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
      const modelElement = qtyInput.closest('div[style*="padding: 12px"]');
      if (modelElement) {
        modelElement.remove();
      }
    } else {
      // Update the available count
      const countSpan = qtyInput.parentElement.parentElement.querySelector(
        'span[style*="color: #28a745"]'
      );
      if (countSpan) {
        countSpan.textContent = `${newCount} available`;
      }
      qtyInput.max = newCount;
      qtyInput.value = Math.min(1, newCount);
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
                    <div style="font-weight: 500; font-size: 14px;">${
                      modelGroup.brand
                    } ${modelGroup.model}</div>
                    <div style="color: #666; font-size: 12px; margin: 4px 0;">${
                      modelGroup.description || ""
                    }</div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span class="asset-badge dept-${modelGroup.department.toLowerCase()}">${
      modelGroup.department
    }</span>
                        <span style="color: #28a745; font-size: 11px; font-weight: 500;">${
                          modelGroup.count
                        } available</span>
                    </div>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <input type="number" min="1" max="${
                      modelGroup.count
                    }" value="1" 
                           id="${inputId}"
                           style="width: 50px; padding: 4px; border: 1px solid #ddd; border-radius: 4px; text-align: center;"
                           onchange="validateQuantityInput('${inputId}', ${
      modelGroup.count
    })"
                           oninput="validateQuantityInput('${inputId}', ${
      modelGroup.count
    })">
                    <button class="btn btn-success" style="padding: 6px 12px; font-size: 11px;" 
                            onclick="addModelToEvent(${eventId}, '${
      modelGroup.brand
    }', '${modelGroup.model}', '${modelGroup.department}', '${
      modelGroup.description || ""
    }')">
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

  // Maintenance Form
  document
    .getElementById("maintenanceForm")
    .addEventListener("submit", async function (e) {
      e.preventDefault();

      const assetId = document.getElementById("maintenanceAssetId").value;
      const logEntry = document.getElementById("maintenanceLogEntry").value;
      const newLocation = document.getElementById(
        "maintenanceNewLocation"
      ).value;
      const markOOC = document.getElementById("maintenanceMarkOOC").checked;
      const unmarkOOC = document.getElementById("maintenanceUnmarkOOC").checked;

      try {
        await apiCall(`/api/assets/${assetId}/maintain`, "POST", {
          logEntry,
          newLocation: newLocation || null,
          markOOC,
          unmarkOOC,
        });
        closeModal("maintenanceModal");
        showNotification("success", "Maintenance logged successfully!");

        // Refresh maintenance view
        if (
          document
            .getElementById("maintenance-section")
            .classList.contains("active")
        ) {
          loadMaintenanceAssets();
        }

        // Reset form
        document.getElementById("maintenanceForm").reset();
      } catch (error) {
        showNotification("error", "Failed to log maintenance");
      }
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
                    <h5 style="margin: 0; color: #495057;">${requiredQty}x ${brand} ${model}</h5>
                    <div style="color: #666; font-size: 12px; margin-top: 2px;">${description}</div>
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
            const bgColor = isExtra ? '#fff3cd' : '#d4edda'; // Yellow for extra assets
            const textColor = isExtra ? '#856404' : '#155724';
            
            if (asset) {
                section += `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; padding: 4px 8px; background: ${bgColor}; border-radius: 3px;">
                        <span style="color: ${textColor};">
                            ${isExtra ? '➕' : '✅'} ${asset.id} (SN: ${asset.serial || 'N/A'})
                            ${isExtra ? ' <span style="font-size: 10px;">(EXTRA)</span>' : ''}
                        </span>
                        <button class="btn btn-warning" style="padding: 2px 6px; font-size: 10px;" onclick="unassignSpecificAsset(${eventId}, '${assetId}', '${brand}', '${model}')">Unprepare</button>
                    </div>
                `;
            } else {
                section += `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; padding: 4px 8px; background: ${bgColor}; border-radius: 3px;">
                        <span style="color: ${textColor};">
                            ${isExtra ? '➕' : '✅'} ${assetId}
                            ${isExtra ? ' <span style="font-size: 10px;">(EXTRA)</span>' : ''}
                        </span>
                        <button class="btn btn-warning" style="padding: 2px 6px; font-size: 10px;" onclick="unassignSpecificAsset(${eventId}, '${assetId}', '${brand}', '${model}')">Unprepare</button>
                    </div>
                `;
            }
        });
        
        section += '</div></div>';
    }
    
    // Show available assets for assignment (always show, even if requirement is met)
    section += `
        <div style="margin-bottom: 15px;">
            <h6 style="color: #495057; margin-bottom: 10px;">Available ${brand} ${model} (${availableAssets.length} total):</h6>
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
                            <span style="font-weight: 500;">${asset.id}</span>
                            <span style="color: #666; font-size: 12px; margin-left: 10px;">SN: ${asset.serial || 'N/A'}</span>
                            <span style="color: #999; font-size: 11px; margin-left: 10px;">📍 ${asset.location}</span>
                        </div>
                        <div>
                            <button class="btn btn-success" style="padding: 4px 8px; font-size: 11px;" onclick="assignSpecificAsset(${eventId}, '${asset.id}', '${brand}', '${model}')">Assign</button>
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