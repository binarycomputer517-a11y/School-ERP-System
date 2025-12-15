/**
 * Client-side script for the Leave Application Form (/apply-leave.html)
 * Handles fetching leave types, balance display, and form submission.
 */

const API_APPLY_LEAVE = '/api/leave/apply';
const API_LEAVE_TYPES = '/api/leave/types/with-balance'; // This route fetches types and balances together
const STUDENT_ID_KEY = 'profile-id'; 
const TOKEN_KEY = 'erp-token';

document.addEventListener('DOMContentLoaded', () => {
    // Check if the required elements exist
    const form = document.getElementById('applyLeaveForm');
    const leaveTypeSelect = document.getElementById('leaveType');

    if (!form || !leaveTypeSelect) {
        console.error("Critical elements not found in the DOM.");
        return;
    }

    // 1. Initial Load: Fetch Leave Types and Balance
    fetchLeaveTypes(leaveTypeSelect);

    // 2. Form Submission Handler
    form.addEventListener('submit', handleFormSubmit);
    
    // 3. Date Validation Listener (Ensure End Date >= Start Date)
    const startDateInput = document.getElementById('startDate');
    const endDateInput = document.getElementById('endDate');

    startDateInput.addEventListener('change', () => {
        // Set minimum end date to start date
        endDateInput.min = startDateInput.value; 
    });
    
    // Ensure the form is pre-filled with the current date as min start date
    const today = new Date().toISOString().split('T')[0];
    startDateInput.min = today;
    startDateInput.value = today;
    endDateInput.min = today;
    endDateInput.value = today;
});


/**
 * Helper to fetch data using Authorization Header.
 * @param {string} url - The API endpoint URL.
 * @returns {Promise<Object>} - The JSON response data.
 */
async function fetchWithAuth(url) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
        alert("Authentication required. Please log in.");
        window.location.href = '/login.html';
        throw new Error('No token found.');
    }

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });

    if (response.status === 401 || response.status === 403) {
        alert("Session expired or unauthorized. Please log in again.");
        window.location.href = '/login.html';
        throw new Error('Unauthorized');
    }

    if (!response.ok) {
        const error = await response.json().catch(() => ({ message: `Server error (${response.status})` }));
        throw new Error(error.message || `API call failed: ${response.status}`);
    }

    return response.json();
}


/**
 * Fetches leave types and current balance for the user, then populates the dropdown.
 * @param {HTMLElement} selectElement - The <select> element for leave types.
 */
async function fetchLeaveTypes(selectElement) {
    try {
        const data = await fetchWithAuth(API_LEAVE_TYPES);

        selectElement.innerHTML = ''; // Clear 'Loading...'
        selectElement.appendChild(new Option('-- Select Leave Type --', ''));

        if (data.length === 0) {
            selectElement.appendChild(new Option('No applicable leave types found', '', true, true));
            return;
        }

        data.forEach(type => {
            // Display type name and current available balance
            const optionText = `${type.leave_type_name} (${type.current_balance} days available)`;
            const option = new Option(optionText, type.leave_type_id);
            // Optionally store balance as a data attribute (for future client-side validation)
            option.setAttribute('data-balance', type.current_balance);
            selectElement.appendChild(option);
        });

    } catch (error) {
        console.error("Error fetching leave types:", error);
        selectElement.innerHTML = '';
        selectElement.appendChild(new Option(`Error loading types: ${error.message}`, '', true, true));
    }
}


/**
 * Handles the submission of the leave request form.
 * @param {Event} e - The form submission event.
 */
async function handleFormSubmit(e) {
    e.preventDefault();

    const leave_type_id = document.getElementById('leaveType').value;
    const start_date = document.getElementById('startDate').value;
    const end_date = document.getElementById('endDate').value;
    const reason = document.getElementById('reason').value.trim();
    
    // Basic client-side validation
    if (!leave_type_id || !start_date || !end_date || !reason) {
        alert("Please fill in all required fields.");
        return;
    }
    
    if (new Date(start_date) > new Date(end_date)) {
        alert("Start Date cannot be after End Date.");
        return;
    }

    // Prepare data for the API
    const requestData = {
        leave_type_id: leave_type_id,
        start_date: start_date,
        end_date: end_date,
        reason: reason
    };

    const submitButton = e.submitter;
    submitButton.disabled = true;
    submitButton.textContent = 'Submitting...';

    try {
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token) throw new Error('Authentication token missing.');

        const response = await fetch(API_APPLY_LEAVE, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestData)
        });

        const responseBody = await response.json().catch(() => ({ message: 'Server responded without content.' }));

        if (response.ok) {
            alert(`✅ Success: ${responseBody.message || 'Leave application submitted successfully.'}`);
            document.getElementById('applyLeaveForm').reset(); // Clear form
            fetchLeaveTypes(document.getElementById('leaveType')); // Reload balance
            // Redirect or refresh history view
            window.location.href = '/manage-leave.html'; // Go back to the leave hub
        } else {
            // Handle specific backend errors (e.g., Insufficient balance - 409)
            if (response.status === 409) {
                 alert(`🛑 Insufficient Balance Error: ${responseBody.message}`);
            } else {
                 alert(`❌ Submission Failed: ${responseBody.message || 'An unknown error occurred.'}`);
            }
        }

    } catch (error) {
        console.error("Leave Submission Error:", error);
        alert(`A network error occurred: ${error.message}`);
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Submit Leave Request';
    }
}