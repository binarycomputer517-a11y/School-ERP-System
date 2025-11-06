/**
 * @fileoverview Main JavaScript file for the Leave Management module.
 * @description Handles form submissions, API communication, and dynamic table rendering
 * for leave application, status tracking, and administrative management.
 */

const API_BASE_URL = 'http://localhost:3005/api/leave';

// --- Utility Functions ---

/**
 * Handles all API calls for the Leave Management module.
 * Retrieves the token immediately before sending the request.
 */
async function handleApi(endpoint, method = 'GET', body = null) {
    // CRITICAL FIX: Retrieve token dynamically inside the function scope
    const currentToken = localStorage.getItem('erp-token');

    const options = {
        method,
        headers: {
            'Content-Type': 'application/json'
        }
    };

    if (currentToken) {
         options.headers['Authorization'] = `Bearer ${currentToken}`;
    } else if (endpoint.includes('/requests')) {
         // Prevent submission if no token is available for a protected route
         alert('Authentication failed. Please log in before submitting a request.');
         return null;
    }

    if (body) options.body = JSON.stringify(body);

    try {
        const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
        if (response.status === 401 || response.status === 403) {
            alert('Authentication failed or forbidden access. Please log in.');
            return null;
        }
        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({ message: `Error ${response.status} from server.` }));
            throw new Error(errorBody.message || `API call failed with status: ${response.status}`);
        }
        if (response.status === 204) return null;
        return await response.json();
    } catch (error) {
        console.error(`API Error on ${method} ${endpoint}:`, error);
        alert(`Request failed: ${error.message}`);
        return null;
    }
}
        
// =================================================================
// --- 1. manage-leave-types.html Logic ---
// =================================================================

function renderLeaveTypes(types) {
    const tbody = document.getElementById('leaveTypesTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    if (!types || types.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">No leave types defined.</td></tr>';
        return;
    }

    types.forEach(type => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${type.name}</td>
            <td>${type.days}</td>
            <td>
                <button class="btn btn-warning btn-sm me-2" onclick="editLeaveType(${type.id})">Edit</button>
                <button class="btn btn-danger btn-sm" onclick="deleteLeaveType(${type.id})">Delete</button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

async function loadLeaveTypes() {
    const types = await handleApi('/types', 'GET');
    if (types) {
        renderLeaveTypes(types);
    }
}

async function handleLeaveTypeFormSubmit(event) {
    event.preventDefault();
    const typeName = document.getElementById('typeName').value;
    const daysAllowed = document.getElementById('daysAllowed').value;

    if (!typeName || !daysAllowed) {
        alert('Please provide a name and days allowed.');
        return;
    }

    const newType = { name: typeName, days_allowed: parseInt(daysAllowed) };
    const result = await handleApi('/types', 'POST', newType);

    if (result) {
        alert(result.message || 'Leave type added successfully!');
        document.getElementById('leaveTypeForm').reset();
        await loadLeaveTypes();
    }
}

function editLeaveType(id) {
    alert(`Simulating edit for Leave Type ID: ${id}. API call: PUT /api/leave/types/${id}`);
}

async function deleteLeaveType(id) {
    if (confirm(`Are you sure you want to delete leave type ID ${id}?`)) {
        const result = await handleApi(`/types/${id}`, 'DELETE');
        
        if (result || result === null) {
            alert(`Successfully deleted type ID ${id}.`);
            await loadLeaveTypes();
        }
    }
}


// =================================================================
// --- 2. apply-leave.html Logic ---
// =================================================================

async function loadLeaveTypesForApplication() {
    const select = document.getElementById('leaveType');
    if (!select) return;

    const types = await handleApi('/types/with-balance', 'GET'); 
    
    select.innerHTML = '<option value="">-- Select Leave Type --</option>';

    if (!types || types.length === 0) {
        select.innerHTML = '<option value="">-- No Leave Types Available --</option>';
        return;
    }

    types.forEach(type => {
        const remaining = type.remaining_days !== undefined ? ` (${type.remaining_days} days remaining)` : '';
        select.innerHTML += `<option value="${type.name}">${type.name}${remaining}</option>`;
    });
}

async function handleApplyLeaveFormSubmit(event) {
    event.preventDefault();
    
    const leaveType = document.getElementById('leaveType').value;
    const startDate = document.getElementById('startDate').value;
    const endDate = document.getElementById('endDate').value;
    const reason = document.getElementById('reason').value;

    // --- CRITICAL CLIENT-SIDE VALIDATION REINFORCED ---
    if (!leaveType || leaveType.trim() === "") {
        alert('Please select a valid Leave Type.');
        return;
    }
    if (!startDate || !endDate) {
        alert('Start Date and End Date are required.');
        return;
    }
    if (!reason || reason.trim() === "") {
        alert('Reason for Leave is required.');
        return;
    }
    
    // Simple date validation
    if (new Date(startDate) > new Date(endDate)) {
        alert('Start Date cannot be after End Date.');
        return;
    }

    const leaveRequest = { leave_type: leaveType, start_date: startDate, end_date: endDate, reason };

    const result = await handleApi('/requests', 'POST', leaveRequest);

    if (result) {
        alert(`${result.message || 'Leave request submitted successfully!'} (ID: ${result.id})`);
        document.getElementById('applyLeaveForm').reset();
        await loadLeaveTypesForApplication(); 
    }
}


// =================================================================
// --- 3. leave-status.html Logic ---
// =================================================================

function renderLeaveStatus(requests) {
    const tbody = document.getElementById('leaveStatusTable');
    if (!tbody) return;

    tbody.innerHTML = '';
    
    if (!requests || requests.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">You have no recorded leave requests.</td></tr>';
        return;
    }

    requests.forEach(req => {
        let badgeClass = '';
        let actionButton = '-';
        const statusText = req.status;

        if (statusText === 'Approved') {
            badgeClass = 'bg-success';
        } else if (statusText === 'Rejected' || statusText === 'Withdrawn') {
            badgeClass = 'bg-danger';
        } else {
            badgeClass = 'bg-warning text-dark';
            actionButton = `<button class="btn btn-danger btn-sm" onclick="withdrawRequest('${req.id}')">Withdraw</button>`;
        }
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${req.id}</td>
            <td>${req.type}</td>
            <td>${req.start}</td>
            <td>${req.end}</td>
            <td><span class="badge ${badgeClass}">${statusText}</span></td>
            <td>${actionButton}</td>
        `;
        tbody.appendChild(row);
    });
}

async function loadMyLeaveStatus() {
    const requests = await handleApi('/requests/my', 'GET');
    if (requests) {
        renderLeaveStatus(requests);
    }
}

async function withdrawRequest(requestId) {
    if (confirm(`Are you sure you want to withdraw request ${requestId}?`)) {
        const result = await handleApi(`/requests/${requestId}/withdraw`, 'PUT');
        
        if (result || result === null) {
            alert(`Request ${requestId} withdrawn.`);
            await loadMyLeaveStatus();
        }
    }
}


// =================================================================
// --- 4. manage-leave-requests.html Logic ---
// =================================================================

function renderPendingRequests(requests) {
    const tbody = document.getElementById('manageRequestsTable');
    if (!tbody) return;

    tbody.innerHTML = '';
    
    if (!requests || requests.length === 0) {
         tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No pending leave requests found.</td></tr>';
         return;
    }

    requests.forEach(req => {
        const employeeName = req.employee_name || req.name || 'N/A';
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${employeeName}</td>
            <td>${req.type}</td>
            <td>${req.start} to ${req.end}</td>
            <td>${req.reason}</td>
            <td>
                <button class="btn btn-success btn-sm" onclick="processRequest('${req.id}', 'Approved')">Approve</button>
                <button class="btn btn-danger btn-sm" onclick="processRequest('${req.id}', 'Rejected')">Reject</button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

async function loadPendingRequests() {
    const requests = await handleApi('/requests/pending', 'GET');
    if (requests) {
        renderPendingRequests(requests);
    }
}

async function processRequest(requestId, status) {
    const body = { status: status };

    const result = await handleApi(`/requests/${requestId}/process`, 'PUT', body);

    if (result) {
        alert(`${result.message || `Request ${requestId} processed as ${status}.`}`);
        await loadPendingRequests();
    }
}


// =================================================================
// --- 5. Initialisation & Event Listeners ---
// =================================================================

document.addEventListener('DOMContentLoaded', () => {
    const path = window.location.pathname;

    if (path.includes('manage-leave-types.html')) {
        const form = document.getElementById('leaveTypeForm');
        if (form) form.addEventListener('submit', handleLeaveTypeFormSubmit);
        loadLeaveTypes();

    } else if (path.includes('apply-leave.html')) {
        loadLeaveTypesForApplication();
        const form = document.getElementById('applyLeaveForm');
        if (form) form.addEventListener('submit', handleApplyLeaveFormSubmit);

    } else if (path.includes('leave-status.html')) {
        loadMyLeaveStatus();
        
    } else if (path.includes('manage-leave-requests.html')) {
        loadPendingRequests();

    }
});

// Exposing key functions globally for use in HTML onclick attributes
window.editLeaveType = editLeaveType;
window.deleteLeaveType = deleteLeaveType;
window.withdrawRequest = withdrawRequest;
window.processRequest = processRequest;
window.loadPendingRequests = loadPendingRequests;