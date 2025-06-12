async function loadPrepareEvents() {
    try {
        const response = await apiCall('/api/events');
        const preparableEvents = response.data.filter(event => 
            event.state === 'Added' || event.state === 'Preparing'
        );
        
        const container = document.getElementById('prepare-events');
        container.innerHTML = '';
        
        if (preparableEvents.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No events available for preparation.</p>';
            return;
        }
        
        preparableEvents.forEach(event => {
            const card = createPrepareEventCard(event);
            container.appendChild(card);
        });
    } catch (error) {
        document.getElementById('prepare-events').innerHTML = '<p style="color: red; text-align: center;">Error loading events</p>';
    }
}

function createPrepareEventCard(event) {
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
    
    card.innerHTML = `
        <div class="event-header">
            <div class="event-id">ID: ${event.id}</div>
            <div class="event-state state-${event.state.toLowerCase()}">${event.state}</div>
        </div>
        <div class="event-title">${event.name}</div>
        <div class="event-date">${dateRange}</div>
        <div style="margin: 15px 0;">
            <small style="color: #666;">${event.assetCount || 0} assets assigned</small>
        </div>
        <div class="event-actions">
            <button class="btn btn-success" onclick="openPrepareAssetModal(${event.id})">Prepare Asset</button>
            <button class="btn btn-primary" onclick="viewEvent(${event.id})">View Details</button>
        </div>
    `;
    
    return card;
}

async function loadReturnEvents() {
    try {
        const response = await apiCall('/api/events');
        const returnableEvents = response.data.filter(event => 
            event.state === 'Ready' || event.state === 'Returning'
        );
        
        const container = document.getElementById('return-events');
        container.innerHTML = '';
        
        if (returnableEvents.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No events with assets to return.</p>';
            return;
        }
        
        returnableEvents.forEach(event => {
            const card = createReturnEventCard(event);
            container.appendChild(card);
        });
    } catch (error) {
        document.getElementById('return-events').innerHTML = '<p style="color: red; text-align: center;">Error loading events</p>';
    }
}

function createReturnEventCard(event) {
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
    
    const returnedCount = event.returnedItems?.length || 0;
    const totalCount = event.assetCount || 0;
    
    card.innerHTML = `
        <div class="event-header">
            <div class="event-id">ID: ${event.id}</div>
            <div class="event-state state-${event.state.toLowerCase()}">${event.state}</div>
        </div>
        <div class="event-title">${event.name}</div>
        <div class="event-date">${dateRange}</div>
        <div style="margin: 15px 0;">
            <small style="color: #666;">${returnedCount}/${totalCount} assets returned</small>
        </div>
        <div class="event-actions">
            <button class="btn btn-warning" onclick="openReturnAssetModal(${event.id})">Return Asset</button>
            <button class="btn btn-primary" onclick="viewEvent(${event.id})">View Details</button>
        </div>
    `;
    
    return card;
}

async function loadTransferHistory() {
    try {
        const response = await apiCall('/api/events');
        const activeEvents = response.data.filter(event => 
            event.state !== 'Closed' && event.assetCount > 0
        );
        
        const container = document.getElementById('transfer-history');
        container.innerHTML = `
            <h3 style="margin-bottom: 20px; color: #764ba2;">Active Events Available for Transfer</h3>
            <div class="events-grid" id="transfer-events-list"></div>
        `;
        
        const eventsList = document.getElementById('transfer-events-list');
        
        if (activeEvents.length === 0) {
            eventsList.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No active events with assets available for transfer.</p>';
            return;
        }
        
        activeEvents.forEach(event => {
            const card = createTransferEventCard(event);
            eventsList.appendChild(card);
        });
        
        // Populate transfer modal dropdowns
        populateTransferDropdowns(activeEvents);
    } catch (error) {
        document.getElementById('transfer-history').innerHTML = '<p style="color: red; text-align: center;">Error loading events</p>';
    }
}

function createTransferEventCard(event) {
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
    
    card.innerHTML = `
        <div class="event-header">
            <div class="event-id">ID: ${event.id}</div>
            <div class="event-state state-${event.state.toLowerCase()}">${event.state}</div>
        </div>
        <div class="event-title">${event.name}</div>
        <div class="event-date">${dateRange}</div>
        <div style="margin: 15px 0;">
            <small style="color: #666;">${event.assetCount || 0} assets assigned</small>
        </div>
        <div class="event-actions">
            <button class="btn btn-primary" onclick="viewEvent(${event.id})">View Assets</button>
        </div>
    `;
    
    return card;
}

async function loadMaintenanceAssets() {
    try {
        const response = await apiCall('/api/assets');
        displayMaintenanceAssets(response.data);
    } catch (error) {
        document.getElementById('maintenance-assets').innerHTML = '<p style="color: red; text-align: center;">Error loading assets</p>';
    }
}

function displayMaintenanceAssets(assetsToShow) {
    const container = document.getElementById('maintenance-assets');
    
    if (assetsToShow.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No assets found.</p>';
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
    
    assetsToShow.forEach(asset => {
        const lastMaintenance = asset.maintenanceLogs && asset.maintenanceLogs.length > 0 
            ? asset.maintenanceLogs[asset.maintenanceLogs.length - 1].split('\t')[0] 
            : 'Never';
        
        tableHTML += `
            <tr>
                <td>${asset.id}</td>
                <td>${asset.brand}</td>
                <td>${asset.model}</td>
                <td><span class="asset-badge status-${asset.status}">${asset.status}</span></td>
                <td>${asset.location || 'Store'}</td>
                <td>${lastMaintenance}</td>
                <td>
                    <button class="btn btn-primary" onclick="openMaintenanceModalForAsset('${asset.id}')">Log Maintenance</button>
                </td>
            </tr>
        `;
    });
    
    tableHTML += '</tbody></table>';
    container.innerHTML = tableHTML;
}

function loadAssetCheck() {
    const container = document.getElementById('asset-check-content');
    container.innerHTML = `
        <div style="text-align: center; padding: 20px;">
            <h3>Asset Check Process</h3>
            <p>Verify physical inventory by scanning or entering asset IDs.</p>
            <button class="btn btn-success" onclick="startAssetCheck()" style="margin: 20px;">Start Asset Check</button>
        </div>
    `;
}

function loadSearchSection() {
    // Initialize search functionality
    const searchInput = document.getElementById('global-search');
    if (searchInput) {
        searchInput.addEventListener('input', performGlobalSearch);
    }
}

function loadFindEventsSection() {
    // Initialize find events functionality
    const searchInput = document.getElementById('find-events-search');
    if (searchInput) {
        searchInput.addEventListener('input', performEventSearch);
    }
}

// Event handler functions
function openPrepareAssetModal(eventId) {
    document.getElementById('prepareEventId').value = eventId;
    document.getElementById('prepareAssetTitle').textContent = `Prepare Asset for Event ${eventId}`;
    openModal('prepareAssetModal');
}

function openReturnAssetModal(eventId) {
    document.getElementById('returnEventId').value = eventId;
    document.getElementById('returnAssetTitle').textContent = `Return Asset from Event ${eventId}`;
    openModal('returnAssetModal');
}

function openMaintenanceModalForAsset(assetId) {
    document.getElementById('maintenanceAssetId').value = assetId;
    openModal('maintenanceModal');
}

function populateTransferDropdowns(events) {
    const fromSelect = document.getElementById('transferFromEvent');
    const toSelect = document.getElementById('transferToEvent');
    
    // Clear existing options
    fromSelect.innerHTML = '<option value="">Select source event...</option>';
    toSelect.innerHTML = '<option value="">Select destination event...</option>';
    
    events.forEach(event => {
        const option1 = document.createElement('option');
        option1.value = event.id;
        option1.textContent = `${event.id}: ${event.name}`;
        fromSelect.appendChild(option1);
        
        const option2 = document.createElement('option');
        option2.value = event.id;
        option2.textContent = `${event.id}: ${event.name}`;
        toSelect.appendChild(option2);
    });
}

async function performGlobalSearch() {
    const query = document.getElementById('global-search').value;
    const container = document.getElementById('search-results');
    
    if (!query.trim()) {
        container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">Enter keywords above to search across all assets.</p>';
        return;
    }
    
    try {
        const response = await apiCall(`/api/search?q=${encodeURIComponent(query)}`);
        const results = response.data;
        
        if (results.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No assets found matching your search.</p>';
            return;
        }
        
        displayInventoryTableInContainer(results, container);
    } catch (error) {
        container.innerHTML = '<p style="color: red; text-align: center;">Error searching assets</p>';
    }
}

async function performEventSearch() {
    const query = document.getElementById('find-events-search').value.toLowerCase();
    const container = document.getElementById('find-events-results');
    
    if (!query.trim()) {
        container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">Enter keywords above to search events.</p>';
        return;
    }
    
    try {
        const response = await apiCall('/api/events');
        const filteredEvents = response.data.filter(event => 
            event.name.toLowerCase().includes(query)
        );
        
        if (filteredEvents.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No events found matching your search.</p>';
            return;
        }
        
        container.innerHTML = '<div class="events-grid" id="found-events"></div>';
        const eventsGrid = document.getElementById('found-events');
        
        filteredEvents.forEach(event => {
            eventsGrid.appendChild(createEventCard(event));
        });
    } catch (error) {
        container.innerHTML = '<p style="color: red; text-align: center;">Error searching events</p>';
    }
}

function displayInventoryTableInContainer(assetsToShow, container) {
    if (assetsToShow.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No assets found.</p>';
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
    
    assetsToShow.forEach(asset => {
        tableHTML += `
            <tr>
                <td>${asset.id}</td>
                <td>${asset.brand}</td>
                <td>${asset.model}</td>
                <td>${asset.serial || 'N/A'}</td>
                <td><span class="asset-badge dept-${asset.department.toLowerCase()}">${asset.department}</span></td>
                <td><span class="asset-badge status-${asset.status}">${asset.status}</span></td>
                <td>${asset.location || 'Store'}</td>
                <td>
                    <button class="btn btn-primary" onclick="viewAsset('${asset.id}')">View</button>
                </td>
            </tr>
        `;
    });
    
    tableHTML += '</tbody></table>';
    container.innerHTML = tableHTML;
}

function startAssetCheck() {
    const container = document.getElementById('asset-check-content');
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
    document.getElementById('assetCheckInput').focus();
    
    // Add enter key listener
    document.getElementById('assetCheckInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            checkAsset();
        }
    });
}

function checkAsset() {
    const input = document.getElementById('assetCheckInput');
    const assetId = input.value.trim();
    
    if (!assetId) return;
    
    // Find asset in our loaded assets
    const asset = assets.find(a => a.id === assetId || a.serial === assetId);
    
    const checkedList = document.getElementById('checkedAssetsList');
    const listItem = document.createElement('li');
    listItem.style.padding = '10px';
    listItem.style.marginBottom = '5px';
    listItem.style.borderRadius = '5px';
    
    if (asset) {
        listItem.style.backgroundColor = '#d4edda';
        listItem.style.color = '#155724';
        listItem.innerHTML = `✅ ${asset.id} - ${asset.brand} ${asset.model} (Found)`;
    } else {
        listItem.style.backgroundColor = '#f8d7da';
        listItem.style.color = '#721c24';
        listItem.innerHTML = `❌ ${assetId} (Not found in inventory)`;
    }
    
    checkedList.appendChild(listItem);
    input.value = '';
    input.focus();
}

function finishAssetCheck() {
    showNotification('success', 'Asset check completed');
    loadAssetCheck();
}// Global variables
let currentUser = null;
let events = [];
let assets = [];
let containers = [];
let logs = [];
let stats = {};

// Navigation functions
function showSection(sectionName) {
    // Hide all sections
    document.querySelectorAll('.content-section').forEach(section => {
        section.classList.remove('active');
    });
    
    // Remove active class from all nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Show selected section
    document.getElementById(sectionName + '-section').classList.add('active');
    
    // Add active class to clicked nav item
    event.target.classList.add('active');
    
    // Load section data
    switch(sectionName) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'events':
            loadAllEvents();
            break;
        case 'inventory':
            loadInventory();
            break;
        case 'containers':
            loadContainers();
            break;
        case 'logs':
            loadLogs();
            break;
        case 'prepare':
            loadPrepareEvents();
            break;
        case 'return':
            loadReturnEvents();
            break;
        case 'transfer':
            loadTransferHistory();
            break;
        case 'maintenance':
            loadMaintenanceAssets();
            break;
        case 'asset-check':
            loadAssetCheck();
            break;
    }
}

// Modal functions
function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

// API functions
async function apiCall(endpoint, method = 'GET', data = null) {
    try {
        const options = {
            method: method,
            headers: {
                'Content-Type': 'application/json',
            }
        };
        
        if (data) {
            options.body = JSON.stringify(data);
        }
        
        const response = await fetch(endpoint, options);
        const result = await response.json();
        
        if (!response.ok) {
            throw new Error(result.error || 'API call failed');
        }
        
        return result;
    } catch (error) {
        console.error('API Error:', error);
        showNotification('error', error.message);
        throw error;
    }
}

// Data loading functions
async function loadDashboard() {
    try {
        // Load stats
        const statsResponse = await apiCall('/api/stats');
        stats = statsResponse.data;
        
        // Update statistics
        document.getElementById('total-events').textContent = stats.totalEvents || 0;
        document.getElementById('active-events').textContent = stats.activeEvents || 0;
        document.getElementById('total-assets').textContent = stats.totalAssets || 0;
        document.getElementById('deployed-assets').textContent = stats.deployedAssets || 0;
        
        // Load recent events
        await loadRecentEvents();
    } catch (error) {
        console.error('Error loading dashboard:', error);
    }
}

async function loadRecentEvents() {
    try {
        const response = await apiCall('/api/events');
        events = response.data;
        
        const container = document.getElementById('recent-events');
        container.innerHTML = '';
        
        if (events.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No events found. Create your first event!</p>';
            return;
        }
        
        events.slice(0, 6).forEach(event => {
            container.appendChild(createEventCard(event));
        });
    } catch (error) {
        document.getElementById('recent-events').innerHTML = '<p style="color: red; text-align: center;">Error loading events</p>';
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
    
    card.innerHTML = `
        <div class="event-header">
            <div class="event-id">ID: ${event.id}</div>
            <div class="event-state state-${event.state.toLowerCase()}">${event.state}</div>
        </div>
        <div class="event-title">${event.name}</div>
        <div class="event-date">${dateRange}</div>
        <div style="margin: 15px 0;">
            <small style="color: #666;">${event.assetCount || 0} assets assigned</small>
        </div>
        <div class="event-actions">
            <button class="btn btn-primary" onclick="viewEvent(${event.id})">View</button>
            <button class="btn btn-warning" onclick="editEventAssets(${event.id})">Edit Assets</button>
            <button class="btn btn-danger" onclick="deleteEvent(${event.id})">Delete</button>
        </div>
    `;
    
    return card;
}

async function loadInventory() {
    try {
        const response = await apiCall('/api/assets');
        assets = response.data;
        
        // Set up event listeners for filters and sorting
        setupInventoryFilters();
        
        // Display all assets initially
        displayFilteredInventory();
    } catch (error) {
        document.getElementById('inventory-table-container').innerHTML = '<p style="color: red; text-align: center;">Error loading inventory</p>';
    }
}

function setupInventoryFilters() {
    // Remove existing listeners to prevent duplicates
    const searchInput = document.getElementById('asset-search');
    const deptFilter = document.getElementById('department-filter');
    const statusFilter = document.getElementById('status-filter');
    const sortSelect = document.getElementById('sort-select');
    const sortDesc = document.getElementById('sort-descending');
    
    if (searchInput) {
        searchInput.removeEventListener('input', displayFilteredInventory);
        searchInput.addEventListener('input', displayFilteredInventory);
    }
    
    if (deptFilter) {
        deptFilter.removeEventListener('change', displayFilteredInventory);
        deptFilter.addEventListener('change', displayFilteredInventory);
    }
    
    if (statusFilter) {
        statusFilter.removeEventListener('change', displayFilteredInventory);
        statusFilter.addEventListener('change', displayFilteredInventory);
    }
    
    if (sortSelect) {
        sortSelect.removeEventListener('change', displayFilteredInventory);
        sortSelect.addEventListener('change', displayFilteredInventory);
    }
    
    if (sortDesc) {
        sortDesc.removeEventListener('change', displayFilteredInventory);
        sortDesc.addEventListener('change', displayFilteredInventory);
    }
}

function displayFilteredInventory() {
    const searchTerm = document.getElementById('asset-search')?.value.toLowerCase() || '';
    const deptFilter = document.getElementById('department-filter')?.value || '';
    const statusFilter = document.getElementById('status-filter')?.value || '';
    const sortBy = document.getElementById('sort-select')?.value || 'id';
    const sortDesc = document.getElementById('sort-descending')?.checked || false;
    
    // Filter assets
    let filteredAssets = assets.filter(asset => {
        // Search filter
        const searchableText = `${asset.id} ${asset.brand} ${asset.model} ${asset.description || ''}`.toLowerCase();
        const matchesSearch = !searchTerm || searchableText.includes(searchTerm);
        
        // Department filter
        const matchesDept = !deptFilter || asset.department === deptFilter;
        
        // Status filter
        const matchesStatus = !statusFilter || asset.status === statusFilter;
        
        return matchesSearch && matchesDept && matchesStatus;
    });
    
    // Sort assets
    filteredAssets.sort((a, b) => {
        let aVal = a[sortBy] || '';
        let bVal = b[sortBy] || '';
        
        // Convert to strings for comparison
        aVal = aVal.toString().toLowerCase();
        bVal = bVal.toString().toLowerCase();
        
        let comparison = aVal.localeCompare(bVal);
        return sortDesc ? -comparison : comparison;
    });
    
    // Update count
    const countElement = document.getElementById('asset-count');
    if (countElement) {
        countElement.textContent = `${filteredAssets.length} of ${assets.length} assets`;
    }
    
    // Display filtered assets
    displayInventoryTable(filteredAssets);
}

function clearFilters() {
    document.getElementById('asset-search').value = '';
    document.getElementById('department-filter').value = '';
    document.getElementById('status-filter').value = '';
    document.getElementById('sort-select').value = 'id';
    document.getElementById('sort-descending').checked = false;
    displayFilteredInventory();
}

function displayInventoryTable(assetsToShow) {
    const container = document.getElementById('inventory-table-container');
    
    if (assetsToShow.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No assets found.</p>';
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
    
    assetsToShow.forEach(asset => {
        tableHTML += `
            <tr>
                <td>${asset.id}</td>
                <td>${asset.brand}</td>
                <td>${asset.model}</td>
                <td>${asset.serial || 'N/A'}</td>
                <td><span class="asset-badge dept-${asset.department.toLowerCase()}">${asset.department}</span></td>
                <td><span class="asset-badge status-${asset.status}">${asset.status}</span></td>
                <td>${asset.location || 'Store'}</td>
                <td>
                    <button class="btn btn-primary" onclick="viewAsset('${asset.id}')">View</button>
                    <button class="btn btn-warning" onclick="editAsset('${asset.id}')">Edit</button>
                </td>
            </tr>
        `;
    });
    
    tableHTML += '</tbody></table>';
    container.innerHTML = tableHTML;
}

async function loadContainers() {
    try {
        const response = await apiCall('/api/containers');
        containers = response.data;
        
        const container = document.getElementById('containers-list');
        container.innerHTML = '';
        
        if (containers.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No containers found.</p>';
            return;
        }
        
        containers.forEach(cont => {
            const containerCard = document.createElement('div');
            containerCard.className = 'event-card';
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
        document.getElementById('containers-list').innerHTML = '<p style="color: red; text-align: center;">Error loading containers</p>';
    }
}

async function loadLogs() {
    try {
        const response = await apiCall('/api/logs');
        logs = response.data;
        
        const container = document.getElementById('logs-container');
        
        if (logs.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No logs found.</p>';
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
        
        logs.forEach(log => {
            tableHTML += `
                <tr>
                    <td>${log.timestamp}</td>
                    <td>${log.user}</td>
                    <td>${log.action}</td>
                </tr>
            `;
        });
        
        tableHTML += '</tbody></table>';
        container.innerHTML = tableHTML;
    } catch (error) {
        document.getElementById('logs-container').innerHTML = '<p style="color: red; text-align: center;">Error loading logs</p>';
    }
}

// Event handlers
async function viewEvent(eventId) {
    try {
        const response = await apiCall(`/api/events/${eventId}`);
        const event = response.data;
        
        document.getElementById('eventDetailsTitle').textContent = `Event ${event.id}: ${event.name}`;
        
        // Build the detailed content with assets by department
        let assetsByDeptHTML = '';
        
        if (Object.keys(event.assetsByDepartment).length > 0) {
            assetsByDeptHTML = '<div class="assets-by-department" style="margin-top: 20px;">';
            assetsByDeptHTML += '<h4 style="color: #764ba2; margin-bottom: 15px;">Assets by Department</h4>';
            
            // Define department colors and names
            const deptInfo = {
                'AX': { name: 'Audio', color: '#007bff', bgColor: '#cce5ff' },
                'LX': { name: 'Lighting', color: '#28a745', bgColor: '#d4edda' },
                'VX': { name: 'Video', color: '#6f42c1', bgColor: '#e2d9f3' },
                'LOAN': { name: 'Loaned Items', color: '#dc3545', bgColor: '#f8d7da' },
                'MISC': { name: 'Miscellaneous', color: '#ffc107', bgColor: '#fff3cd' },
                'UN': { name: 'Unknown', color: '#6c757d', bgColor: '#e2e3e5' }
            };
            
            Object.keys(event.assetsByDepartment).forEach(dept => {
                const deptAssets = event.assetsByDepartment[dept];
                const info = deptInfo[dept] || { name: dept, color: '#6c757d', bgColor: '#e2e3e5' };
                
                assetsByDeptHTML += `
                    <div class="department-section" style="margin-bottom: 25px; border: 1px solid ${info.color}; border-radius: 8px; overflow: hidden;">
                        <div class="department-header" style="background: ${info.bgColor}; color: ${info.color}; padding: 12px 15px; font-weight: bold; border-bottom: 1px solid ${info.color};">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span>${dept} - ${info.name}</span>
                                <span class="asset-count" style="background: ${info.color}; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px;">
                                    ${deptAssets.length} item${deptAssets.length !== 1 ? 's' : ''}
                                </span>
                            </div>
                        </div>
                        <div class="department-assets" style="padding: 0;">
                `;
                
                deptAssets.forEach((asset, index) => {
                    let statusIcon, statusColor, statusText;
                    
                    if (asset.status === 'returned') {
                        statusIcon = '↩️';
                        statusColor = '#6c757d';
                        statusText = 'Returned';
                    } else if (asset.status === 'prepared') {
                        statusIcon = '✅';
                        statusColor = '#28a745';
                        statusText = 'Prepared';
                    } else {
                        statusIcon = '📋';
                        statusColor = '#fd7e14';
                        statusText = 'Assigned';
                    }
                    
                    // Special handling for OOC and Missing assets
                    let statusBadge = `<span style="color: ${statusColor}; font-size: 12px;">${statusIcon} ${statusText}</span>`;
                    if (asset.isMissing) {
                        statusBadge += ` <span style="color: #dc3545; font-size: 11px;">❌ MISSING</span>`;
                    }
                    if (asset.isOOC) {
                        statusBadge += ` <span style="color: #dc3545; font-size: 11px;">🔧 OOC</span>`;
                    }
                    
                    // Add action buttons for non-loan/misc items
                    let actionButtons = '';
                    if (!asset.isLoanOrMisc && asset.status !== 'returned') {
                        if (asset.status === 'assigned') {
                            actionButtons = `<button class="btn btn-success" style="padding: 4px 8px; font-size: 11px; margin-left: 10px;" onclick="prepareAsset(${eventId}, '${asset.id}')">Prepare</button>`;
                        } else if (asset.status === 'prepared') {
                            actionButtons = `<button class="btn btn-warning" style="padding: 4px 8px; font-size: 11px; margin-left: 10px;" onclick="unprepareAsset(${eventId}, '${asset.id}')">Unprepare</button>`;
                        }
                    }
                    
                    const borderBottom = index < deptAssets.length - 1 ? 'border-bottom: 1px solid #e9ecef;' : '';
                    
                    assetsByDeptHTML += `
                        <div class="asset-row" style="padding: 12px 15px; display: flex; justify-content: space-between; align-items: center; ${borderBottom}">
                            <div class="asset-info">
                                <div style="font-weight: 500; margin-bottom: 2px;">
                                    <span style="color: #495057;">${asset.id}</span>
                                </div>
                                <div style="color: #666; font-size: 14px;">
                                    ${asset.name}
                                </div>
                                ${asset.serial ? `<div style="color: #999; font-size: 12px;">S/N: ${asset.serial}</div>` : ''}
                            </div>
                            <div class="asset-status" style="text-align: right; display: flex; align-items: center;">
                                <div>
                                    ${statusBadge}
                                    ${asset.location ? `<div style="color: #999; font-size: 11px; margin-top: 2px;">📍 ${asset.location}</div>` : ''}
                                </div>
                                ${actionButtons}
                            </div>
                        </div>
                    `;
                });
                
                assetsByDeptHTML += '</div></div>';
            });
            
            assetsByDeptHTML += '</div>';
        } else {
            assetsByDeptHTML = '<p style="color: #666; font-style: italic; margin-top: 20px;">No assets assigned to this event.</p>';
        }
        
        // Build summary statistics
        const assignedCount = event.assignedAssets?.length || 0;
        const preparedCount = event.preparedAssets?.length || 0;
        const returnedCount = event.returnedAssets?.length || 0;
        const totalCount = event.totalAssets || 0;
        const progressPercent = totalCount > 0 ? Math.round((returnedCount / totalCount) * 100) : 0;
        
        const content = `
            <div class="event-details">
                <div class="form-group">
                    <strong>📅 Start Date:</strong> ${event.startDate}
                </div>
                <div class="form-group">
                    <strong>📅 End Date:</strong> ${event.endDate}
                </div>
                <div class="form-group">
                    <strong>📊 State:</strong> <span class="event-state state-${event.state.toLowerCase()}">${event.state}</span>
                </div>
                
                <div class="asset-summary" style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <h4 style="margin-bottom: 15px; color: #495057;">Asset Summary</h4>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 15px;">
                        <div style="text-align: center;">
                            <div style="font-size: 24px; font-weight: bold; color: #007bff;">${totalCount}</div>
                            <div style="color: #666; font-size: 14px;">Total Assets</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 24px; font-weight: bold; color: #fd7e14;">${assignedCount}</div>
                            <div style="color: #666; font-size: 14px;">Assigned</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 24px; font-weight: bold; color: #28a745;">${preparedCount}</div>
                            <div style="color: #666; font-size: 14px;">Prepared</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 24px; font-weight: bold; color: #6c757d;">${returnedCount}</div>
                            <div style="color: #666; font-size: 14px;">Returned</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 24px; font-weight: bold; color: #17a2b8;">${progressPercent}%</div>
                            <div style="color: #666; font-size: 14px;">Return Progress</div>
                        </div>
                    </div>
                    ${totalCount > 0 ? `
                        <div style="margin-top: 15px;">
                            <div style="background: #e9ecef; height: 8px; border-radius: 4px; overflow: hidden;">
                                <div style="background: #28a745; height: 100%; width: ${progressPercent}%; transition: width 0.3s ease;"></div>
                            </div>
                        </div>
                    ` : ''}
                </div>
                
                ${assetsByDeptHTML}
            </div>
        `;
        
        document.getElementById('eventDetailsContent').innerHTML = content;
        openModal('eventDetailsModal');
    } catch (error) {
        showNotification('error', 'Failed to load event details');
    }
}

async function prepareAsset(eventId, assetId) {
    try {
        await apiCall(`/api/events/${eventId}/prepare`, 'POST', { assetId });
        showNotification('success', `Asset ${assetId} prepared for event`);
        
        // Refresh the event details
        viewEvent(eventId);
        
        // Refresh other views if they're active
        if (document.getElementById('prepare-section').classList.contains('active')) {
            loadPrepareEvents();
        }
    } catch (error) {
        showNotification('error', `Failed to prepare asset: ${error.message}`);
    }
}

async function unprepareAsset(eventId, assetId) {
    try {
        await apiCall(`/api/events/${eventId}/unprepare`, 'POST', { assetId });
        showNotification('success', `Asset ${assetId} unprepared`);
        
        // Refresh the event details
        viewEvent(eventId);
        
        // Refresh other views if they're active
        if (document.getElementById('prepare-section').classList.contains('active')) {
            loadPrepareEvents();
        }
    } catch (error) {
        showNotification('error', `Failed to unprepare asset: ${error.message}`);
    }
}

async function editEventAssets(eventId) {
    try {
        // Get event details and available assets
        const [eventResponse, eventAssetsResponse, availableAssetsResponse] = await Promise.all([
            apiCall(`/api/events/${eventId}`),
            apiCall(`/api/events/${eventId}/assets`),
            apiCall('/api/assets/available')
        ]);
        
        const event = eventResponse.data;
        const eventAssets = eventAssetsResponse.data;
        const availableAssets = availableAssetsResponse.data;
        
        document.getElementById('editEventAssetsTitle').textContent = `Edit Assets - Event ${event.id}: ${event.name}`;
        
        // Build the edit interface
        let content = `
            <div class="edit-assets-interface">
                <!-- Event Summary -->
                <div class="event-summary" style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
                    <h4 style="margin-bottom: 10px; color: #495057;">Event Summary</h4>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; text-align: center;">
                        <div>
                            <div style="font-size: 20px; font-weight: bold; color: #007bff;">${eventAssets.length}</div>
                            <div style="color: #666; font-size: 12px;">Assets Assigned</div>
                        </div>
                        <div>
                            <div style="font-size: 20px; font-weight: bold; color: #28a745;">${availableAssets.length}</div>
                            <div style="color: #666; font-size: 12px;">Available Assets</div>
                        </div>
                        <div>
                            <div style="font-size: 20px; font-weight: bold; color: #17a2b8;">${event.startDate}</div>
                            <div style="color: #666; font-size: 12px;">Start Date</div>
                        </div>
                    </div>
                </div>

                <!-- Two Column Layout -->
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                    
                    <!-- Currently Assigned Assets -->
                    <div class="assigned-assets">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                            <h4 style="color: #495057; margin: 0;">Currently Assigned Assets</h4>
                            <span style="background: #007bff; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px;">
                                ${eventAssets.length} assets
                            </span>
                        </div>
                        <div id="assigned-assets-list" style="max-height: 400px; overflow-y: auto; border: 1px solid #e9ecef; border-radius: 8px;">
        `;
        
        if (eventAssets.length === 0) {
            content += '<p style="text-align: center; color: #666; padding: 20px;">No assets assigned to this event.</p>';
        } else {
            // Group assigned assets by department
            const assetsByDept = {};
            eventAssets.forEach(asset => {
                if (!assetsByDept[asset.department]) {
                    assetsByDept[asset.department] = [];
                }
                assetsByDept[asset.department].push(asset);
            });
            
            Object.keys(assetsByDept).sort().forEach(dept => {
                const deptAssets = assetsByDept[dept];
                const deptInfo = getDepartmentInfo(dept);
                
                content += `
                    <div class="dept-section" style="border-bottom: 1px solid #e9ecef;">
                        <div style="background: ${deptInfo.bgColor}; color: ${deptInfo.color}; padding: 8px 12px; font-weight: bold; font-size: 14px;">
                            ${dept} - ${deptInfo.name} (${deptAssets.length})
                        </div>
                `;
                
                deptAssets.forEach(asset => {
                    const statusBadge = asset.status === 'returned' ? 
                        '<span style="color: #6c757d; font-size: 11px;">↩️ Returned</span>' : 
                        '<span style="color: #28a745; font-size: 11px;">✅ Prepared</span>';
                    
                    content += `
                        <div class="asset-item" style="padding: 10px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <div style="font-weight: 500; font-size: 14px;">${asset.id}</div>
                                <div style="color: #666; font-size: 12px;">${asset.brand} ${asset.model}</div>
                                <div style="color: #999; font-size: 11px;">${asset.description}</div>
                                ${statusBadge}
                            </div>
                            <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="removeAssetFromEvent(${eventId}, '${asset.id}')">Remove</button>
                        </div>
                    `;
                });
                
                content += '</div>';
            });
        }
        
        content += `
                        </div>
                    </div>
                    
                    <!-- Available Assets -->
                    <div class="available-assets">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                            <h4 style="color: #495057; margin: 0;">Available Assets</h4>
                            <span style="background: #28a745; color: white; padding: 2px 8px; border-radius: 12px; font-size: 12px;">
                                ${availableAssets.length} available
                            </span>
                        </div>
                        
                        <!-- Search Available Assets -->
                        <div class="form-group">
                            <input type="text" class="form-input" id="availableAssetsSearch" 
                                   placeholder="Search available assets..." 
                                   style="margin-bottom: 10px;"
                                   onkeyup="filterAvailableAssets()">
                        </div>
                        
                        <div id="available-assets-list" style="max-height: 400px; overflow-y: auto; border: 1px solid #e9ecef; border-radius: 8px;">
        `;
        
        if (availableAssets.length === 0) {
            content += '<p style="text-align: center; color: #666; padding: 20px;">No assets available for assignment.</p>';
        } else {
            // Group available assets by department
            const availableByDept = {};
            availableAssets.forEach(asset => {
                if (!availableByDept[asset.department]) {
                    availableByDept[asset.department] = [];
                }
                availableByDept[asset.department].push(asset);
            });
            
            Object.keys(availableByDept).sort().forEach(dept => {
                const deptAssets = availableByDept[dept];
                const deptInfo = getDepartmentInfo(dept);
                
                content += `
                    <div class="dept-section available-dept-${dept}" style="border-bottom: 1px solid #e9ecef;">
                        <div style="background: ${deptInfo.bgColor}; color: ${deptInfo.color}; padding: 8px 12px; font-weight: bold; font-size: 14px;">
                            ${dept} - ${deptInfo.name} (${deptAssets.length})
                        </div>
                `;
                
                deptAssets.forEach(asset => {
                    content += `
                        <div class="asset-item available-asset-${asset.id}" style="padding: 10px 12px; border-bottom: 1px solid #f1f1f1; display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <div style="font-weight: 500; font-size: 14px;">${asset.id}</div>
                                <div style="color: #666; font-size: 12px;">${asset.brand} ${asset.model}</div>
                                <div style="color: #999; font-size: 11px;">${asset.description}</div>
                                <div style="color: #999; font-size: 11px;">📍 ${asset.location}</div>
                            </div>
                            <button class="btn btn-success" style="padding: 4px 8px; font-size: 11px;" onclick="addAssetToEvent(${eventId}, '${asset.id}')">Add</button>
                        </div>
                    `;
                });
                
                content += '</div>';
            });
        }
        
        content += `
                        </div>
                    </div>
                </div>
                
                <!-- Actions -->
                <div style="margin-top: 20px; text-align: right;">
                    <button class="btn btn-secondary" onclick="closeModal('editEventAssetsModal')">Close</button>
                </div>
            </div>
        `;
        
        document.getElementById('editEventAssetsContent').innerHTML = content;
        
        // Store the data for filtering
        window.currentAvailableAssets = availableAssets;
        window.currentEventId = eventId;
        
        openModal('editEventAssetsModal');
    } catch (error) {
        showNotification('error', 'Failed to load event assets for editing');
    }
}

function getDepartmentInfo(dept) {
    const deptInfo = {
        'AX': { name: 'Audio', color: '#007bff', bgColor: '#cce5ff' },
        'LX': { name: 'Lighting', color: '#28a745', bgColor: '#d4edda' },
        'VX': { name: 'Video', color: '#6f42c1', bgColor: '#e2d9f3' },
        'UN': { name: 'Unknown', color: '#6c757d', bgColor: '#e2e3e5' }
    };
    return deptInfo[dept] || { name: dept, color: '#6c757d', bgColor: '#e2e3e5' };
}

async function addAssetToEvent(eventId, assetId) {
    try {
        await apiCall(`/api/events/${eventId}/assets`, 'POST', { assetId });
        showNotification('success', `Asset ${assetId} added to event`);
        
        // Refresh the edit modal
        editEventAssets(eventId);
    } catch (error) {
        showNotification('error', `Failed to add asset: ${error.message}`);
    }
}

async function removeAssetFromEvent(eventId, assetId) {
    if (!confirm(`Are you sure you want to remove asset ${assetId} from this event?`)) {
        return;
    }
    
    try {
        await apiCall(`/api/events/${eventId}/assets/${assetId}`, 'DELETE');
        showNotification('success', `Asset ${assetId} removed from event`);
        
        // Refresh the edit modal
        editEventAssets(eventId);
    } catch (error) {
        showNotification('error', `Failed to remove asset: ${error.message}`);
    }
}

function filterAvailableAssets() {
    const searchTerm = document.getElementById('availableAssetsSearch').value.toLowerCase();
    const availableAssets = window.currentAvailableAssets || [];
    
    if (!searchTerm) {
        // Show all assets
        document.querySelectorAll('.available-asset-').forEach(el => {
            el.style.display = 'flex';
        });
        return;
    }
    
    // Hide all assets first
    document.querySelectorAll('[class*="available-asset-"]').forEach(el => {
        el.style.display = 'none';
    });
    
    // Show matching assets
    availableAssets.forEach(asset => {
        const searchableText = `${asset.id} ${asset.brand} ${asset.model} ${asset.description}`.toLowerCase();
        if (searchableText.includes(searchTerm)) {
            const element = document.querySelector(`.available-asset-${asset.id}`);
            if (element) {
                element.style.display = 'flex';
            }
        }
    });
}

async function deleteEvent(eventId) {
    if (!confirm('Are you sure you want to delete this event? This action cannot be undone.')) {
        return;
    }
    
    try {
        await apiCall(`/api/events/${eventId}`, 'DELETE');
        showNotification('success', 'Event deleted successfully');
        
        // Refresh the current view
        if (document.getElementById('dashboard-section').classList.contains('active')) {
            loadDashboard();
        } else if (document.getElementById('events-section').classList.contains('active')) {
            loadAllEvents();
        }
    } catch (error) {
        showNotification('error', 'Failed to delete event');
    }
}

async function viewAsset(assetId) {
    const asset = assets.find(a => a.id === assetId);
    if (!asset) {
        showNotification('error', 'Asset not found');
        return;
    }
    
    document.getElementById('assetDetailsTitle').textContent = `Asset ${asset.id}`;
    
    const content = `
        <div class="form-group">
            <strong>Brand:</strong> ${asset.brand}
        </div>
        <div class="form-group">
            <strong>Model:</strong> ${asset.model}
        </div>
        <div class="form-group">
            <strong>Serial Number:</strong> ${asset.serial || 'N/A'}
        </div>
        <div class="form-group">
            <strong>Description:</strong> ${asset.description || 'N/A'}
        </div>
        <div class="form-group">
            <strong>Department:</strong> <span class="asset-badge dept-${asset.department.toLowerCase()}">${asset.department}</span>
        </div>
        <div class="form-group">
            <strong>Status:</strong> <span class="asset-badge status-${asset.status}">${asset.status}</span>
        </div>
        <div class="form-group">
            <strong>Current Location:</strong> ${asset.location || 'Store'}
        </div>
        <div class="form-group">
            <strong>Missing:</strong> ${asset.isMissing ? 'Yes' : 'No'}
        </div>
        <div class="form-group">
            <strong>Out of Commission:</strong> ${asset.isOOC ? 'Yes' : 'No'}
        </div>
    `;
    
    document.getElementById('assetDetailsContent').innerHTML = content;
    openModal('assetDetailsModal');
}

async function editAsset(assetId) {
    showNotification('info', `Edit asset ${assetId} - Feature coming soon`);
}

function viewContainer(containerId) {
    showNotification('info', `View container ${containerId} - Feature coming soon`);
}

function editContainer(containerId) {
    showNotification('info', `Edit container ${containerId} - Feature coming soon`);
}

// Form handlers
document.addEventListener('DOMContentLoaded', function() {
    // Add Event Form
    document.getElementById('addEventForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const eventData = {
            name: document.getElementById('eventName').value,
            startDate: document.getElementById('eventStartDate').value,
            endDate: document.getElementById('eventEndDate').value
        };
        
        try {
            await apiCall('/api/events', 'POST', eventData);
            closeModal('addEventModal');
            showNotification('success', 'Event added successfully!');
            
            // Refresh the current view
            if (document.getElementById('dashboard-section').classList.contains('active')) {
                loadDashboard();
            } else if (document.getElementById('events-section').classList.contains('active')) {
                loadAllEvents();
            }
            
            // Reset form
            document.getElementById('addEventForm').reset();
        } catch (error) {
            showNotification('error', 'Failed to add event');
        }
    });

    // Add Asset Form
    document.getElementById('addAssetForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const assetData = {
            brand: document.getElementById('assetBrand').value,
            model: document.getElementById('assetModel').value,
            serial: document.getElementById('assetSerial').value,
            description: document.getElementById('assetDescription').value,
            department: document.getElementById('assetDepartment').value
        };
        
        try {
            await apiCall('/api/assets', 'POST', assetData);
            closeModal('addAssetModal');
            showNotification('success', 'Asset added successfully!');
            
            // Refresh inventory if we're on that page
            if (document.getElementById('inventory-section').classList.contains('active')) {
                loadInventory();
            }
            
            // Refresh dashboard stats
            loadDashboard();
            
            // Reset form
            document.getElementById('addAssetForm').reset();
        } catch (error) {
            showNotification('error', 'Failed to add asset');
        }
    });

    // Prepare Asset Form
    document.getElementById('prepareAssetForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const eventId = document.getElementById('prepareEventId').value;
        const assetId = document.getElementById('prepareAssetId').value;
        
        try {
            await apiCall(`/api/events/${eventId}/prepare`, 'POST', { assetId });
            closeModal('prepareAssetModal');
            showNotification('success', 'Asset prepared successfully!');
            
            // Refresh prepare events view
            if (document.getElementById('prepare-section').classList.contains('active')) {
                loadPrepareEvents();
            }
            
            // Reset form
            document.getElementById('prepareAssetForm').reset();
        } catch (error) {
            showNotification('error', 'Failed to prepare asset');
        }
    });

    // Return Asset Form
    document.getElementById('returnAssetForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const eventId = document.getElementById('returnEventId').value;
        const assetId = document.getElementById('returnAssetId').value;
        
        try {
            await apiCall(`/api/events/${eventId}/return`, 'POST', { assetId });
            closeModal('returnAssetModal');
            showNotification('success', 'Asset returned successfully!');
            
            // Refresh return events view
            if (document.getElementById('return-section').classList.contains('active')) {
                loadReturnEvents();
            }
            
            // Reset form
            document.getElementById('returnAssetForm').reset();
        } catch (error) {
            showNotification('error', 'Failed to return asset');
        }
    });

    // Transfer Asset Form
    document.getElementById('transferForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const assetId = document.getElementById('transferAssetId').value;
        const fromEventId = document.getElementById('transferFromEvent').value;
        const toEventId = document.getElementById('transferToEvent').value;
        
        if (fromEventId === toEventId) {
            showNotification('error', 'Source and destination events cannot be the same');
            return;
        }
        
        try {
            await apiCall(`/api/events/${toEventId}/transfer`, 'POST', { 
                assetId, 
                fromEventId: parseInt(fromEventId) 
            });
            closeModal('transferModal');
            showNotification('success', 'Asset transferred successfully!');
            
            // Refresh transfer view
            if (document.getElementById('transfer-section').classList.contains('active')) {
                loadTransferHistory();
            }
            
            // Reset form
            document.getElementById('transferForm').reset();
        } catch (error) {
            showNotification('error', 'Failed to transfer asset');
        }
    });

    // Maintenance Form
    document.getElementById('maintenanceForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const assetId = document.getElementById('maintenanceAssetId').value;
        const logEntry = document.getElementById('maintenanceLogEntry').value;
        const newLocation = document.getElementById('maintenanceNewLocation').value;
        const markOOC = document.getElementById('maintenanceMarkOOC').checked;
        const unmarkOOC = document.getElementById('maintenanceUnmarkOOC').checked;
        
        try {
            await apiCall(`/api/assets/${assetId}/maintain`, 'POST', {
                logEntry,
                newLocation: newLocation || null,
                markOOC,
                unmarkOOC
            });
            closeModal('maintenanceModal');
            showNotification('success', 'Maintenance logged successfully!');
            
            // Refresh maintenance view
            if (document.getElementById('maintenance-section').classList.contains('active')) {
                loadMaintenanceAssets();
            }
            
            // Reset form
            document.getElementById('maintenanceForm').reset();
        } catch (error) {
            showNotification('error', 'Failed to log maintenance');
        }
    });

    // Maintenance search functionality
    const maintenanceSearch = document.getElementById('maintenance-search');
    if (maintenanceSearch) {
        maintenanceSearch.addEventListener('input', function(e) {
            const searchTerm = e.target.value.toLowerCase();
            const filteredAssets = assets.filter(asset => 
                asset.id.toLowerCase().includes(searchTerm) ||
                asset.brand.toLowerCase().includes(searchTerm) ||
                asset.model.toLowerCase().includes(searchTerm) ||
                (asset.description && asset.description.toLowerCase().includes(searchTerm))
            );
            
            displayMaintenanceAssets(filteredAssets);
        });
    }

    // Search functionality
    const eventSearch = document.getElementById('event-search');
    if (eventSearch) {
        eventSearch.addEventListener('input', function(e) {
            const searchTerm = e.target.value.toLowerCase();
            const filteredEvents = events.filter(event => 
                event.name.toLowerCase().includes(searchTerm) ||
                event.state.toLowerCase().includes(searchTerm)
            );
            
            const container = document.getElementById('all-events');
            container.innerHTML = '';
            filteredEvents.forEach(event => {
                container.appendChild(createEventCard(event));
            });
        });
    }

    const assetSearch = document.getElementById('asset-search');
    if (assetSearch) {
        assetSearch.addEventListener('input', function(e) {
            const searchTerm = e.target.value.toLowerCase();
            const filteredAssets = assets.filter(asset => 
                asset.id.toLowerCase().includes(searchTerm) ||
                asset.brand.toLowerCase().includes(searchTerm) ||
                asset.model.toLowerCase().includes(searchTerm) ||
                (asset.description && asset.description.toLowerCase().includes(searchTerm))
            );
            
            displayInventoryTable(filteredAssets);
        });
    }

    // Initialize application
    initializeApp();
});

// Utility functions
function showNotification(type, message) {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    // Trigger animation
    setTimeout(() => notification.classList.add('show'), 100);
    
    // Remove notification after 3 seconds
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            if (document.body.contains(notification)) {
                document.body.removeChild(notification);
            }
        }, 300);
    }, 3000);
}

function exportLogs() {
    if (logs.length === 0) {
        showNotification('warning', 'No logs to export');
        return;
    }
    
    const csvContent = "data:text/csv;charset=utf-8," 
        + "Timestamp,User,Action\n"
        + logs.map(log => `"${log.timestamp}","${log.user}","${log.action}"`).join("\n");
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "activity_logs.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showNotification('success', 'Logs exported successfully!');
}

function logout() {
    if (confirm('Are you sure you want to logout?')) {
        window.location.href = '/logout';
    }
}

// Close modals when clicking outside
window.addEventListener('click', function(e) {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('active');
    }
});

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
    // Escape key closes modals
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal.active').forEach(modal => {
            modal.classList.remove('active');
        });
    }
    
    // Ctrl+N for new event
    if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        openModal('addEventModal');
    }
    
    // Ctrl+Shift+N for new asset
    if (e.ctrlKey && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        openModal('addAssetModal');
    }
});

// Initialize application
async function initializeApp() {
    try {
        // Set current user
        document.getElementById('current-user').textContent = 'Admin'; // This would come from session
        
        // Set today's date as default for event forms
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('eventStartDate').value = today;
        document.getElementById('eventEndDate').value = today;
        
        // Load initial data
        await loadDashboard();
        
    } catch (error) {
        console.error('Error initializing application:', error);
        showNotification('error', 'Failed to initialize application');
    }
}

// Auto-refresh data every 60 seconds
setInterval(async () => {
    try {
        const currentSection = document.querySelector('.content-section.active');
        if (currentSection) {
            const sectionId = currentSection.id.replace('-section', '');
            switch(sectionId) {
                case 'dashboard':
                    await loadDashboard();
                    break;
                case 'events':
                    await loadAllEvents();
                    break;
                case 'inventory':
                    await loadInventory();
                    break;
                case 'logs':
                    await loadLogs();
                    break;
            }
        }
    } catch (error) {
        console.error('Auto-refresh error:', error);
    }
}, 60000);