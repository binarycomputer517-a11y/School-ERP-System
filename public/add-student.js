// public/add-student.js

document.addEventListener('DOMContentLoaded', initializeAddForm);

// Retrieve the token from localStorage set during login
const AUTH_TOKEN = localStorage.getItem('erp-token');
const ACADEMICS_API = '/api/academicswithfees';


// --- CORE API HANDLER (Must be global/accessible) ---
/**
 * Helper function for authenticated API calls.
 */
async function handleApi(url, options = {}) {
    options.headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` };
    const response = await fetch(url, options);
    if (response.status === 401 || response.status === 403) {
        alert('Session expired or unauthorized. Please log in again.');
        window.location.href = '/login.html';
        throw new Error('Unauthorized');
    }
    return response;
}


// --- TAB & PROGRESS BAR LOGIC ---
/**
 * Updates the visual progress bar based on the currently active tab/step.
 * @param {number} currentStep The index of the current step (1 to 4).
 */
function updateProgressBar(currentStep) {
    const progressBar = document.getElementById('progressBar');
    const totalSteps = 4;
    const progressPercent = (currentStep / totalSteps) * 100;
    
    if (progressBar) {
        progressBar.style.width = `${progressPercent}%`;
        progressBar.textContent = `Step ${currentStep} of ${totalSteps}`;
    }
}

/**
 * Handles the logic for switching between form tabs.
 * This function is called directly from the HTML onclick attribute.
 * @param {Event} evt The click event from the tab button.
 * @param {string} tabId The ID of the fieldset to display.
 */
function openTab(evt, tabId) {
    const currentStep = parseInt(evt.currentTarget.getAttribute('data-step'), 10);

    // Hide all tab content fieldsets
    document.querySelectorAll('.tab-content fieldset').forEach(el => {
        el.classList.remove('active'); 
    });

    // Remove active class from all tab buttons
    document.querySelectorAll('.tab-button').forEach(el => {
        el.classList.remove('active');
    });

    // Show the current tab content, and add an "active" class to the button
    const targetFieldset = document.getElementById(tabId);
    if (targetFieldset) {
        targetFieldset.classList.add('active');
    }
    evt.currentTarget.classList.add('active');
    
    updateProgressBar(currentStep);
}


// --- INITIALIZATION ---
/**
 * Initializes the student addition form: attaches listeners and loads initial data.
 */
function initializeAddForm() {
    const form = document.getElementById('addStudentForm'); 
    
    if (!form || !AUTH_TOKEN) {
        if (!AUTH_TOKEN) alert('Authentication token missing. Please log in.');
        return;
    }
    
    form.addEventListener('submit', handleAddStudentSubmit);
    
    const courseSelect = document.getElementById('course_id');
    if (courseSelect) courseSelect.addEventListener('change', handleCourseChange);

    // Initialization: Ensure the progress bar starts at Step 1.
    updateProgressBar(1);
    
    // Load initial data (This is where the original error occurred)
    loadInitialDropdowns();
}

// --- Dynamic Data Loading ---

async function loadInitialDropdowns() {
    const courseSelect = document.getElementById('course_id');
    const batchSelect = document.getElementById('batch_id');
    
    if (!courseSelect || !batchSelect) return;

    courseSelect.innerHTML = '<option value="">Loading Courses...</option>';
    batchSelect.innerHTML = '<option value="">-- Waiting for Course --</option>';
    batchSelect.disabled = true;

    try {
        // ERROR OCCURRED HERE: handleApi must be in scope!
        const response = await handleApi(`${ACADEMICS_API}/courses`); 
        const courses = await response.json();

        if (!Array.isArray(courses)) {
            courseSelect.innerHTML = '<option value="">Error: Server failed to return course list.</option>';
            console.error("Server error when fetching courses:", courses);
            return;
        }

        courseSelect.innerHTML = '<option value="">-- Select Course --</option>';
        courses.forEach(c => {
            courseSelect.innerHTML += `<option value="${c.id || c.course_id}">${c.course_name} (${c.course_code})</option>`;
        });
    } catch (err) {
        console.error('Failed to load courses:', err);
        courseSelect.innerHTML = '<option value="">Error loading courses</option>';
    }
}

async function handleCourseChange(event) {
    const courseId = event.target.value;
    const feeDisplayEl = document.getElementById('fee-structure-display'); 
    const subjectsDisplayEl = document.getElementById('subjects-display');
    
    await populateBatchDropdown(courseId);
    clearFeeAndSubjectDisplay(feeDisplayEl, subjectsDisplayEl);
    
    loadSubjects(courseId, subjectsDisplayEl); 
}

async function populateBatchDropdown(courseId) {
    const batchSelect = document.getElementById('batch_id');
    if (!batchSelect) return;

    batchSelect.innerHTML = '<option value="">Loading batches...</option>';
    batchSelect.disabled = true;
    
    batchSelect.removeEventListener('change', handleBatchChange); 

    if (!courseId) {
        batchSelect.innerHTML = '<option value="">-- Waiting for Course --</option>';
        return;
    }

    try {
        const response = await handleApi(`${ACADEMICS_API}/courses/${courseId}/batches`);
        const batches = await response.json();
        
        batchSelect.innerHTML = '<option value="">-- Select Batch --</option>';
        if (Array.isArray(batches) && batches.length > 0) {
            batches.forEach(b => {
                batchSelect.innerHTML += `<option value="${b.id || b.batch_id}">${b.batch_name} (${b.batch_code})</option>`;
            });
            batchSelect.disabled = false;
            batchSelect.addEventListener('change', handleBatchChange); 
        } else {
            batchSelect.innerHTML = '<option value="">-- No batches found --</option>';
        }
    } catch (err) {
        console.error('Failed to load batches:', err);
        batchSelect.innerHTML = '<option value="">Error loading batches</option>';
    }
}

async function handleBatchChange() {
    const courseSelect = document.getElementById('course_id');
    const batchSelect = document.getElementById('batch_id');
    const feeDisplayEl = document.getElementById('fee-structure-display');
    
    const courseId = courseSelect.value;
    const batchId = batchSelect.value;
    
    if (courseId && batchId) {
        loadFeeStructure(courseId, batchId, feeDisplayEl);
    } else { 
        clearFeeDisplay(feeDisplayEl);
    }
}

async function loadSubjects(courseId, subjectsDisplayEl) {
    if (!subjectsDisplayEl) return;

    subjectsDisplayEl.innerHTML = 'Fetching assigned subjects...';
    
    if (!courseId) {
        subjectsDisplayEl.innerHTML = '<p>Subjects assigned to this Course will appear here.</p>';
        return;
    }

    try {
        const response = await handleApi(`${ACADEMICS_API}/courses/${courseId}/subjects`);
        
        if (response.ok) {
            const subjects = await response.json();
            
            if (Array.isArray(subjects) && subjects.length > 0) {
                const listHtml = subjects.map(s => `<li>${s.subject_name} (${s.subject_code})</li>`).join('');
                subjectsDisplayEl.innerHTML = `
                    <h4>📚 Assigned Subjects (${subjects.length})</h4>
                    <ul style="margin-top: 5px; padding-left: 20px;">${listHtml}</ul>
                `;
            } else {
                subjectsDisplayEl.innerHTML = '<p>⚠️ No subjects are currently assigned to this course.</p>';
            }
        } else {
            const error = await response.json();
            subjectsDisplayEl.innerHTML = `<p style="color:red;">Error fetching subjects: ${error.message || response.statusText}</p>`;
        }
    } catch (err) {
        console.error('Subject Fetch Error:', err);
        subjectsDisplayEl.innerHTML = '<p style="color:red;">A network error occurred while retrieving subjects.</p>';
    }
}

async function loadFeeStructure(courseId, batchId, feeDisplayEl) {
    if (!feeDisplayEl) return; 

    feeDisplayEl.innerHTML = 'Fetching fee structure...';
    try {
        const response = await handleApi(`${ACADEMICS_API}/fees/structures/find?course_id=${courseId}&batch_id=${batchId}`);
        
        if (response.ok) {
            const structure = await response.json();
            const totalFee = calculateTotalFee(structure);

            feeDisplayEl.innerHTML = `
                <h4>💰 Fee Structure Details</h4>
                <p><strong>Admission Fee:</strong> ₹${(structure.admission_fee || 0).toFixed(2)}</p>
                <p><strong>Registration Fee:</strong> ₹${(structure.registration_fee || 0).toFixed(2)}</p>
                <p><strong>Examination Fee:</strong> ₹${(structure.examination_fee || 0).toFixed(2)}</p>
                ${structure.has_transport ? `<p><strong>Transport Fee (x${structure.course_duration_months} mos):</strong> ₹${(structure.transport_fee * structure.course_duration_months).toFixed(2)}</p>` : ''}
                ${structure.has_hostel ? `<p><strong>Hostel Fee (x${structure.course_duration_months} mos):</strong> ₹${(structure.hostel_fee * structure.course_duration_months).toFixed(2)}</p>` : ''}
                <hr>
                <p style="font-weight: bold;">TOTAL ESTIMATED FEE: ₹${totalFee}</p>
            `;
        } else if (response.status === 404) {
            feeDisplayEl.innerHTML = '<p style="color:red;">⚠️ No Fee Structure found for this Course/Batch combination.</p>';
        } else {
             const error = await response.json();
             feeDisplayEl.innerHTML = `<p style="color:red;">Error fetching fee: ${error.message || response.statusText}</p>`;
        }
    } catch (err) {
        console.error('Fee Fetch Error:', err);
        feeDisplayEl.innerHTML = '<p style="color:red;">A server error occurred while retrieving fees.</p>';
    }
}

// Helper function to calculate total fee
function calculateTotalFee(structure) {
    const admission = parseFloat(structure.admission_fee) || 0;
    const registration = parseFloat(structure.registration_fee) || 0;
    const examination = parseFloat(structure.examination_fee) || 0;
    const duration = parseInt(structure.course_duration_months) || 1;
    
    const transport = structure.has_transport ? (parseFloat(structure.transport_fee) || 0) * duration : 0;
    const hostel = structure.has_hostel ? (parseFloat(structure.hostel_fee) || 0) * duration : 0;
    
    const total = admission + registration + examination + transport + hostel;
    return total.toFixed(2);
}

// Function to clear both the fee and subject display areas
function clearFeeAndSubjectDisplay(feeDisplayEl, subjectsDisplayEl) { 
    if (feeDisplayEl) {
        feeDisplayEl.innerHTML = 'Fee structure details will appear here upon Course and Batch selection.';
    }
    if (subjectsDisplayEl) {
         subjectsDisplayEl.innerHTML = '<p>Subjects assigned to this Course will appear here.</p>';
    }
}

// Function to clear only the fee display
function clearFeeDisplay(feeDisplayEl) { 
    if (feeDisplayEl) {
        feeDisplayEl.innerHTML = 'Fee structure details will appear here upon Course and Batch selection.';
    }
}


// --- Form Submission ---

async function handleAddStudentSubmit(event) {
    event.preventDefault(); 
    const form = event.target;
    
    const password = form.querySelector('#password').value;
    const confirmPassword = form.querySelector('#confirm_password').value;

    if (password !== confirmPassword) {
        alert("Error: Passwords do not match!");
        return; 
    }

    const formData = new FormData(form);
    const studentData = Object.fromEntries(formData.entries());

    delete studentData.confirm_password; 

    const API_ENDPOINT = '/api/students'; 
    const feeDisplayEl = document.getElementById('fee-structure-display'); 
    const subjectsDisplayEl = document.getElementById('subjects-display');

    try {
        const response = await handleApi(API_ENDPOINT, { method: 'POST', body: JSON.stringify(studentData) });
        
        const result = await response.json();
        if (response.ok) {
            alert(`Student successfully enrolled! Enrollment No: ${result.enrollment_no}`);
            form.reset(); 
            clearFeeAndSubjectDisplay(feeDisplayEl, subjectsDisplayEl); // Clear display on success
            
            // Reset to the first tab and progress bar upon successful submission
            const firstTabButton = document.querySelector('.tab-bar button[data-step="1"]');
            const firstFieldset = document.getElementById('personal');

            // Safely remove active class from potentially missing elements
            document.querySelector('.tab-button.active')?.classList.remove('active');
            document.querySelector('.tab-content fieldset.active')?.classList.remove('active');

            if (firstFieldset) firstFieldset.classList.add('active');
            if (firstTabButton) firstTabButton.classList.add('active');
            
            updateProgressBar(1);
            
        } else {
            alert(`Enrollment Failed: ${result.message || response.statusText}`);
        }
    } catch (error) {
        console.error('Network Error:', error);
        alert('A network error occurred. Could not connect to the API.');
    }
}