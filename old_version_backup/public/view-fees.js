// public/view-fees.js

document.addEventListener('DOMContentLoaded', initializeFeesPage);

let studentID = null;
const AUTH_TOKEN = localStorage.getItem('erp-token');
const API_BASE_URL = '/api/academicswithfees'; 
const FEES_API_ENDPOINT = '/api/fees'; // Assuming a dedicated API for fees

// DOM Elements for student info
const studentFullName = document.getElementById('studentFullName');
const admissionIdSpan = document.getElementById('admissionId');
const courseBatchSpan = document.getElementById('courseBatch');
const feeStructureDetails = document.getElementById('feeStructureDetails');
const feeTableBody = document.getElementById('feeTableBody');
const errorMessageDiv = document.getElementById('errorMessage'); // Get the error div

/**
 * Extracts the student ID from the URL query parameters.
 */
function getStudentIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('student_id');
}

/**
 * Helper function for authenticated API calls with detailed status checks.
 */
async function handleApi(url, options = {}) {
    options.headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` };
    const response = await fetch(url, options);

    if (response.status === 401 || response.status === 403) {
        alert('Session expired or unauthorized. Please log in again.');
        window.location.href = '/login.html';
        throw new Error('Unauthorized');
    }
    
    // --- START ENHANCED ERROR CHECKING ---
    if (!response.ok) {
        const errorBody = await response.text();
        let specificError = `HTTP Error ${response.status} at ${url}.`;
        
        if (response.status === 404) {
            specificError = `Resource Not Found (404). Check the server API route: ${url}`;
        } else if (response.status === 500) {
            specificError = `Server Error (500). Please check the server logs.`;
        }
        // If the server provides a JSON message, try to use it
        try {
             const errorData = JSON.parse(errorBody);
             specificError = errorData.message || specificError;
        } catch (e) {
            // Ignore parsing error if errorBody is not JSON
        }
        
        throw new Error(specificError);
    }
    // --- END ENHANCED ERROR CHECKING ---

    return response;
}

/**
 * 1. Reads the student ID from the URL.
 * 2. Fetches basic student data.
 * 3. Fetches the fee structure.
 */
function initializeFeesPage() {
    studentID = getStudentIdFromUrl();

    if (!AUTH_TOKEN) {
        alert('Authentication token missing. Please log in.');
        return;
    }
    
    if (studentID) {
        // Fetch student profile and fees concurrently
        Promise.all([
            loadStudentData(studentID), 
            loadFeeStructure(studentID) 
        ]).catch(err => {
            console.error('Initialization failed:', err);
            // Display the detailed error message caught by handleApi
            errorMessageDiv.textContent = `Failed to load data. ${err.message}`;
            errorMessageDiv.style.display = 'block';
        }).finally(() => {
             document.getElementById('loadingMessage').style.display = 'none';
        });
    } else {
        alert("Error: Student ID is missing from the URL.");
    }
}


/** Fetches student data to populate the header. */
async function loadStudentData(id) {
    try {
        const response = await handleApi(`/api/students/${id}`);
        const data = await response.json();
        
        studentFullName.textContent = `${data.first_name || ''} ${data.last_name || ''}`;
        admissionIdSpan.textContent = data.admission_id || 'N/A';
        
        const courseName = data.course_name || 'N/A';
        const batchName = data.batch_name || 'N/A';
        courseBatchSpan.textContent = `${courseName} / ${batchName}`;

    } catch (error) {
        console.error('Student Data Loading Error:', error);
        // Do not throw; let the fee structure call proceed/fail independently.
        studentFullName.textContent = 'Error Loading Student Header'; 
    }
}


/** Fetches the fee structure and populates the table. */
async function loadFeeStructure(studentId) {
    try {
        // FIX: Using the standard direct path /api/fees/ID
        const response = await handleApi(`${FEES_API_ENDPOINT}/${studentId}`); 
        const feeData = await response.json();
        
        if (feeData && feeData.breakdown && feeData.breakdown.length > 0) {
            populateFeeTable(feeData.breakdown);
            populateFeeSummary(feeData.summary);
            feeStructureDetails.style.display = 'block';
        } else {
             feeTableBody.innerHTML = '<tr><td colspan="4">No active fee structure defined for this student.</td></tr>';
        }

    } catch (error) {
        // This error will be handled by the catch block in initializeFeesPage
        throw error;
    }
}

/** Populates the detailed fee table. (Placeholder logic) */
function populateFeeTable(breakdown) {
    feeTableBody.innerHTML = '';
    breakdown.forEach(item => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${item.fee_head || 'N/A'}</td>
            <td>${item.amount ? item.amount.toFixed(2) : 'N/A'}</td>
            <td>${item.status || 'Pending'}</td>
            <td>${item.due_date ? new Date(item.due_date).toLocaleDateString() : 'N/A'}</td>
        `;
        feeTableBody.appendChild(row);
    });
}

/** Populates the fee summary. (Placeholder logic) */
function populateFeeSummary(summary) {
    document.getElementById('totalFees').textContent = summary.total_fees ? summary.total_fees.toFixed(2) : '0.00';
    document.getElementById('feesPaid').textContent = summary.fees_paid ? summary.fees_paid.toFixed(2) : '0.00';
    document.getElementById('balanceDue').textContent = summary.balance_due ? summary.balance_due.toFixed(2) : '0.00';
}