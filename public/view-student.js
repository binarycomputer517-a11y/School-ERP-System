// public/view-student.js

document.addEventListener('DOMContentLoaded', initializeStudentView);

// Retrieve the token from localStorage set during login
const AUTH_TOKEN = localStorage.getItem('erp-token');

/**
 * Reads the student ID from the URL, fetches the data, and renders the profile.
 */
function initializeStudentView() {
    // 1. Authentication Check
    if (!AUTH_TOKEN) {
        displayError('Error: You are not authenticated. Please log in.');
        // NOTE: In a production app, redirect to /login.html here.
        return;
    }
    
    // 2. Get Student ID from URL
    const studentId = getStudentIdFromUrl(); // This is the Student Profile UUID (students.student_id)

    if (studentId) {
        fetchStudentData(studentId);
        // Update the Edit Profile link URL
        const editLink = document.getElementById('editStudentLink');
        if (editLink) {
             editLink.href = `/edit-student.html?id=${studentId}`; // Ensure the full path is set
        }
    } else {
        // This is the correct error message when navigating directly without an ID
        displayError('Error: Student ID not found in the URL. Please navigate from the students list.');
    }
}

/**
 * Utility function to extract the student ID from the URL query parameters.
 * @returns {string | null} The student UUID or null.
 */
function getStudentIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('id'); // Assumes URL looks like: /view-student.html?id=... (UUID)
}

/**
 * Fetches student data from the server API.
 * @param {string} studentId The UUID of the student profile to fetch.
 */
async function fetchStudentData(studentId) {
    // API_ENDPOINT uses the student profile ID (UUID)
    const API_ENDPOINT = `/api/students/${studentId}`;
    const container = document.getElementById('studentProfileContainer');
    container.innerHTML = '<p>Loading student data...</p>';

    try {
        const response = await fetch(API_ENDPOINT, {
            method: 'GET',
            headers: {
                // Send the Authorization header using the retrieved token
                'Authorization': `Bearer ${AUTH_TOKEN}` 
            }
        });

        if (response.ok) {
            const studentData = await response.json();
            renderStudentProfile(studentData);
        } else {
             // Robust error handling to catch non-JSON responses (403, 404, etc.)
            const errorText = await response.text();
            
            if (response.status === 404) {
                 displayError('Student profile not found.');
            } else if (response.status === 403) {
                 // Error handled by backend logic (Admin/Teacher/Self check)
                 displayError('Forbidden: You do not have permission to view this profile.');
            } else {
                 displayError(`Failed to fetch student data: Server returned status ${response.status}. ${errorText.substring(0, 100)}...`);
            }
        }

    } catch (error) {
        console.error('Network or Fetch Error:', error);
        displayError('A network error occurred while connecting to the server.');
    }
}

/**
 * Renders the fetched data onto the view-student.html page using the template.
 * @param {object} data The student profile data object.
 */
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

/**
 * Displays a non-critical error message to the user.
 * @param {string} message The error message to show.
 */
function displayError(message) {
    const container = document.getElementById('studentProfileContainer');
    const errorBox = document.getElementById('errorMessage');
    
    // Clear main content and show error message
    container.style.display = 'none';
    errorBox.textContent = message;
    errorBox.style.display = 'block';
}