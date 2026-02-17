// public/view-student.js

document.addEventListener('DOMContentLoaded', initializeStudentView);

// Retrieve the token from localStorage set during login
const AUTH_TOKEN = localStorage.getItem('erp-token');

// --- Global DOM Elements ---
const feeSummaryDiv = document.getElementById('feeSummaryDiv');
const librarySummaryDiv = document.getElementById('librarySummaryDiv');
const teacherListDiv = document.getElementById('teacherListDiv');

/**
 * Reads the student ID from the URL, fetches all data, and renders the profile.
 */
function initializeStudentView() {
    // 1. Authentication Check
    if (!AUTH_TOKEN) {
        // NOTE: Redirect to /login.html is highly recommended here for production
        displayError('Error: You are not authenticated. Please log in.');
        return;
    }
    
    // 2. Get Student ID from URL
    const studentId = getStudentIdFromUrl();

    if (studentId) {
        // Fetch core profile data first
        fetchStudentData(studentId); 
        
        // Fetch related dashboard data simultaneously
        fetchFeeData(studentId);
        fetchLibraryData(studentId);
        fetchTeacherData(studentId); 
        
        // Update the Edit Profile link URL
        const editLink = document.getElementById('editStudentLink');
        if (editLink) {
             editLink.href = `/edit-student.html?id=${studentId}`; 
        }
    } else {
        displayError('Error: Student ID not found in the URL. Please navigate from the students list.');
    }
}

// --- Utility Functions (getStudentIdFromUrl, displayError remain the same) ---

function getStudentIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('id'); 
}

function displayError(message) {
    const container = document.getElementById('studentProfileContainer');
    const errorBox = document.getElementById('errorMessage');
    
    // Clear main content and show error message
    container.style.display = 'none';
    errorBox.textContent = message;
    errorBox.style.display = 'block';
}

// --- CORE PROFILE FETCH (Remains the same) ---
async function fetchStudentData(studentId) {
    const API_ENDPOINT = `/api/students/${studentId}`;
    const container = document.getElementById('studentProfileContainer');
    container.innerHTML = '<p>Loading student data...</p>';

    try {
        const response = await fetch(API_ENDPOINT, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
        });

        if (response.ok) {
            const studentData = await response.json();
            renderStudentProfile(studentData);
        } else {
            // Error handling logic (404, 403, 500)
             const errorText = await response.text();
             // ... (existing error handling logic) ...
             displayError(`Failed to fetch student data: Server returned status ${response.status}. ${errorText.substring(0, 100)}...`);
        }
    } catch (error) {
        console.error('Network or Fetch Error:', error);
        displayError('A network error occurred while connecting to the server.');
    }
}

// --- AUXILIARY DATA FETCHES (NEW) ---

/**
 * Fetches and renders Fee Summary and History.
 */
async function fetchFeeData(studentId) {
    // NOTE: This API returns the combined summary object + history array
    const API_ENDPOINT = `/api/students/${studentId}/fees`;
    feeSummaryDiv.innerHTML = '<p class="text-muted small">Loading fees...</p>';

    try {
        const response = await fetch(API_ENDPOINT, { headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` } });
        const data = await response.json();

        if (response.ok) {
            // Uses the formatCurrency helper (assumed to be in global-config.js or utils)
            const formatCurrency = window.formatCurrency || ((amount) => `₹${parseFloat(amount || 0).toFixed(2)}`);
            
            feeSummaryDiv.innerHTML = `
                <div class="d-flex justify-content-between">
                    <span class="fw-bold">Balance Due:</span>
                    <span class="fw-bold text-danger">${formatCurrency(data.balance_due)}</span>
                </div>
                <div class="text-muted small mt-2">
                    Total Billed: ${formatCurrency(data.total_billed)} | Paid: ${formatCurrency(data.total_paid)}
                </div>
                <ul class="list-unstyled mt-3 small">
                    ${data.payment_history && data.payment_history.length > 0 ? 
                        data.payment_history.map(p => `
                            <li>
                                <strong>${formatCurrency(p.amount)}</strong> on 
                                ${new Date(p.payment_date).toLocaleDateString()} (${p.mode})
                            </li>`).join('')
                        : '<li>No recent payments recorded.</li>'
                    }
                </ul>
            `;
        } else {
            feeSummaryDiv.innerHTML = '<p class="text-danger small">Error loading fee summary.</p>';
        }
    } catch (error) {
        console.error('Fee Fetch Error:', error);
        feeSummaryDiv.innerHTML = '<p class="text-danger small">Could not connect to fee service.</p>';
    }
}

/**
 * Fetches and renders Library Summary.
 */
async function fetchLibraryData(studentId) {
    // NOTE: This API returns an array of issued books
    const API_ENDPOINT = `/api/students/${studentId}/library`;
    librarySummaryDiv.innerHTML = '<p class="text-muted small">Loading library status...</p>';

    try {
        const response = await fetch(API_ENDPOINT, { headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` } });
        const data = await response.json();
        
        if (response.ok && Array.isArray(data)) {
            const issuedCount = data.length;
            librarySummaryDiv.innerHTML = `
                <p class="mb-0"><strong>${issuedCount}</strong> Books Currently Issued</p>
                <ul class="list-unstyled mt-2 small">
                    ${data.slice(0, 3).map(book => `
                        <li>${book.book_title || 'Unknown Book'} (Due: ${new Date(book.due_date).toLocaleDateString()})</li>
                    `).join('')}
                    ${issuedCount > 3 ? `<li class="text-muted">... and ${issuedCount - 3} more.</li>` : ''}
                </ul>
            `;
        } else {
             librarySummaryDiv.innerHTML = '<p class="text-danger small">Error loading library data.</p>';
        }
    } catch (error) {
        console.error('Library Fetch Error:', error);
        librarySummaryDiv.innerHTML = '<p class="text-danger small">Could not connect to library service.</p>';
    }
}

/**
 * Fetches and renders Teacher List.
 */
async function fetchTeacherData(studentId) {
    // NOTE: This API returns an array of teachers linked to the student's batch
    const API_ENDPOINT = `/api/students/${studentId}/teachers`;
    teacherListDiv.innerHTML = '<p class="text-muted small">Loading teachers...</p>';

    try {
        const response = await fetch(API_ENDPOINT, { headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` } });
        const data = await response.json();
        
        if (response.ok && Array.isArray(data)) {
            if (data.length === 0) {
                 teacherListDiv.innerHTML = '<p class="text-info small">No teachers currently allocated to this batch.</p>';
                 return;
            }
            teacherListDiv.innerHTML = `
                <ul class="list-unstyled small">
                    ${data.map(t => `
                        <li>
                            <strong class="text-primary">${t.full_name}</strong>: ${t.subject_name} 
                            <a href="mailto:${t.email}" class="ms-2">✉️</a>
                        </li>
                    `).join('')}
                </ul>
            `;
        } else {
             teacherListDiv.innerHTML = '<p class="text-danger small">Error loading teacher data.</p>';
        }
    } catch (error) {
        console.error('Teacher Fetch Error:', error);
        teacherListDiv.innerHTML = '<p class="text-danger small">Could not connect to teacher service.</p>';
    }
}


// --- RENDERING FUNCTION (Remains largely the same) ---
function renderStudentProfile(data) {
    const container = document.getElementById('studentProfileContainer');
    const template = document.getElementById('studentDataTemplate');
    
    // Clear loading message
    container.innerHTML = '';
    const profileNode = document.importNode(template.content, true);

    // Update the header name display
    document.getElementById('studentFullName').textContent = `${data.first_name || ''} ${data.last_name || ''}`;

    profileNode.querySelectorAll('[data-field]').forEach(element => {
        const fieldName = element.getAttribute('data-field');
        let value = data[fieldName];

        if (value !== null && value !== undefined) {
            // Format dates
            if (fieldName.includes('date') || fieldName === 'dob') {
                value = new Date(value).toLocaleDateString();
            }
            // Format status
            if (fieldName === 'is_active') {
                // Assuming data.is_active is available from the user join
                element.textContent = value ? 'Active' : 'Inactive';
                element.classList.add(value ? 'status-active' : 'status-inactive');
            } else {
                element.textContent = value;
            }
        } else {
            element.textContent = 'N/A';
        }
    });

    container.appendChild(profileNode);
}