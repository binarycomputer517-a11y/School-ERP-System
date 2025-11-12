// public/add-student.js

document.addEventListener('DOMContentLoaded', initializeAddForm);

// --- Global Constants ---
const AUTH_TOKEN = localStorage.getItem('erp-token'); // (Note: Not used directly by new handleApi)
const ACADEMICS_API = '/api/academicswithfees';


// --- CORE API HANDLER (Updated) ---
/**
 * Helper function for authenticated API calls. 
 * Handles token, branch, and session headers.
 */
async function handleApi(url, options = {}) {
    // 1. Get all required items from localStorage
    const AUTH_TOKEN = localStorage.getItem('erp-token');
    const ACTIVE_BRANCH_ID = localStorage.getItem('active_branch_id');
    const ACTIVE_SESSION_ID = localStorage.getItem('active_session_id');

    // 2. Set default options
    options.method = options.method || 'GET';
    
    if (options.body && typeof options.body === 'object' && !options.headers?.['Content-Type']) {
        options.body = JSON.stringify(options.body);
    }

    // 3. Add Authentication and Custom Headers
    
    options.headers = { 
        ...options.headers,
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        
        // --- These two lines are the solution ---
        'active-branch-id': ACTIVE_BRANCH_ID,
        'active-session-id': ACTIVE_SESSION_ID
    };
    
    // Delete 'Content-Type' for GET requests
    if (options.method === 'GET' || options.method === 'HEAD') {
        delete options.headers['Content-Type'];
    }

    // 4. Make the API call
    const response = await fetch(url, options);

    // 5. Handle Errors
    if (response.status === 401 || response.status === 403) {
        console.error('API Unauthorized or Forbidden:', url);
        throw new Error('Unauthorized or Forbidden access. Please check server logs or re-login.');
    }
    
    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown server error');
        console.error(`API Error ${response.status}:`, errorText);
        throw new Error(`Server error: ${response.status}. ${errorText.substring(0, 100)}...`);
    }
    
    return response; // Return the successful response
}


// --- VALIDATION LOGIC ---

/**
 * Validates required fields in the current active fieldset. Used for forward navigation.
 * @returns {boolean} True if all required fields are filled, false otherwise.
 */
function validateCurrentStep() {
    const activeFieldset = document.querySelector('.tab-content fieldset.active');
    if (!activeFieldset) return true; 

    const requiredInputs = activeFieldset.querySelectorAll('[required]:not([type="hidden"])');
    let isValid = true;
    
    requiredInputs.forEach(input => {
        if (!input.value || (input.tagName === 'SELECT' && input.value === '')) {
            input.style.border = '2px solid var(--accent-color)'; 
            isValid = false;
        } else {
            input.style.border = ''; 
        }
    });

    if (!isValid) {
        alert('🛑 Please complete all required fields in the current step before proceeding.');
    }

    return isValid;
}

/**
 * NEW HELPER FUNCTION: Iterates over the ENTIRE form's required fields to find the first error.
 * Used upon submission.
 * @param {HTMLFormElement} form 
 * @returns {HTMLElement | null} The first element with a validation error, or null.
 */
function validateFullFormAndFindFirstError(form) {
    let firstInvalidInput = null;
    let isValid = true;

    // Select ALL required inputs across all visible fieldsets (excluding the hidden system IDs)
    const requiredInputs = form.querySelectorAll('fieldset:not([style*="none"]) [required]:not([type="hidden"])');

    requiredInputs.forEach(input => {
        // Reset border first
        input.style.border = '';

        if (!input.value || (input.tagName === 'SELECT' && input.value === '')) {
            input.style.border = '2px solid var(--accent-color)';
            if (isValid) {
                isValid = false;
                firstInvalidInput = input;
            }
        }
    });

    return firstInvalidInput;
}


// --- TAB & PROGRESS BAR LOGIC ---

/**
 * Updates the visual progress bar.
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
 * Handles the logic for switching between form tabs, including validation check.
 */
function openTab(evt, tabId) {
    const clickedButton = evt.currentTarget;
    const newStep = parseInt(clickedButton.getAttribute('data-step'), 10);
    const currentActiveStep = parseInt(document.querySelector('.tab-button.active')?.getAttribute('data-step') || '1', 10);
    
    // Check validation ONLY if moving FORWARD
    if (newStep > currentActiveStep) {
        if (!validateCurrentStep()) {
            return; 
        }
    }
    
    // UI Update: Remove active states
    document.querySelectorAll('.tab-content fieldset').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-button').forEach(el => el.classList.remove('active'));

    // UI Update: Set new active state
    const targetFieldset = document.getElementById(tabId);
    if (targetFieldset) {
        targetFieldset.classList.add('active');
    }
    clickedButton.classList.add('active');
    
    updateProgressBar(newStep);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}


// --- INITIALIZATION ---

function initializeAddForm() {
    const form = document.getElementById('addStudentForm'); 
    const token = localStorage.getItem('erp-token'); // Check token at initialization
    
    if (!form || !token) {
        if (!token) alert('Authentication token missing. Please log in.');
        return;
    }
    
    form.addEventListener('submit', handleAddStudentSubmit);
    
    const courseSelect = document.getElementById('course_id');
    if (courseSelect) courseSelect.addEventListener('change', handleCourseChange);

    updateProgressBar(1);
    loadInitialDropdowns();
}

// --- Dynamic Data Loading Functions ---

async function loadInitialDropdowns() {
    const courseSelect = document.getElementById('course_id');
    const batchSelect = document.getElementById('batch_id');
    const sessionSelect = document.getElementById('academic_session_id'); // Get the session select element
    
    if (!courseSelect || !batchSelect || !sessionSelect) return;

    courseSelect.innerHTML = '<option value="">Loading Courses...</option>';
    sessionSelect.innerHTML = '<option value="">Loading Sessions...</option>';
    batchSelect.innerHTML = '<option value="">-- Waiting for Course --</option>';
    batchSelect.disabled = true;

    try {
        // --- Load Academic Sessions ---
        const sessionResponse = await handleApi(`${ACADEMICS_API}/sessions`); 
        const sessions = await sessionResponse.json();
        
        sessionSelect.innerHTML = '<option value="">-- Select Session --</option>';
        if (Array.isArray(sessions)) {
            sessions.forEach(s => {
                sessionSelect.innerHTML += `<option value="${s.id || s.academic_session_id}">${s.name || s.session_name}</option>`;
            });
        }
        
        // --- Load Courses ---
        const courseResponse = await handleApi(`${ACADEMICS_API}/courses`); 
        const courses = await courseResponse.json();
        
        if (!Array.isArray(courses)) {
             courseSelect.innerHTML = '<option value="">No courses found</option>';
             return;
        }

        courseSelect.innerHTML = '<option value="">-- Select Course --</option>';
        courses.forEach(c => {
            courseSelect.innerHTML += `<option value="${c.id || c.course_id}">${c.course_name} (${c.course_code})</option>`;
        });
    } catch (err) {
        console.error('Failed to load initial data:', err);
        sessionSelect.innerHTML = '<option value="">Error loading sessions</option>';
        courseSelect.innerHTML = '<option value="">Error loading courses</option>';
    }
}

async function handleCourseChange(event) {
    const courseId = event.target.value;
    const feeDisplayEl = document.getElementById('fee-structure-display'); 
    const subjectsDisplayEl = document.getElementById('subjects-display');
    
    clearFeeAndSubjectDisplay(feeDisplayEl, subjectsDisplayEl);
    await populateBatchDropdown(courseId);
    if (courseId) loadSubjects(courseId, subjectsDisplayEl); 
}

async function populateBatchDropdown(courseId) {
    const batchSelect = document.getElementById('batch_id');
    if (!batchSelect) return;

    batchSelect.removeEventListener('change', handleBatchChange); 
    batchSelect.innerHTML = '<option value="">Loading batches...</option>';
    batchSelect.disabled = true;
    
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
    if (!subjectsDisplayEl || !courseId) return;

    subjectsDisplayEl.innerHTML = 'Fetching assigned subjects...';
    
    try {
        const response = await handleApi(`${ACADEMICS_API}/courses/${courseId}/subjects`);
        const subjects = await response.json();

        if (Array.isArray(subjects) && subjects.length > 0) {
            const listHtml = subjects.map(s => `<li>${s.subject_name} (${s.subject_code})</li>`).join('');
            subjectsDisplayEl.innerHTML = `<h4>📚 Assigned Subjects (${subjects.length})</h4><ul style="margin-top: 5px; padding-left: 20px;">${listHtml}</ul>`;
        } else {
            subjectsDisplayEl.innerHTML = '<p>⚠️ No subjects are currently assigned to this course.</p>';
        }

    } catch (err) {
        console.error('Subject Fetch Error:', err);
        subjectsDisplayEl.innerHTML = '<p style="color:red;">A network error occurred while retrieving subjects.</p>';
    }
}

async function loadFeeStructure(courseId, batchId, feeDisplayEl) {
    if (!feeDisplayEl || !courseId || !batchId) return; 

    feeDisplayEl.innerHTML = 'Fetching fee structure...';
    try {
        // **REQUIRED BACKEND ENDPOINT**
        const response = await handleApi(`${ACADEMICS_API}/fees/structures/find?course_id=${courseId}&batch_id=${batchId}`);
        const structure = await response.json();
        const totalFee = calculateTotalFee(structure);

        const admissionFee = parseFloat(structure.admission_fee) || 0;
        const registrationFee = parseFloat(structure.registration_fee) || 0;
        const examinationFee = parseFloat(structure.examination_fee) || 0;
        const duration = parseInt(structure.course_duration_months) || 0;
        const transportFeeMonthly = parseFloat(structure.transport_fee) || 0;
        const hostelFeeMonthly = parseFloat(structure.hostel_fee) || 0;
        const transportTotal = structure.has_transport ? (transportFeeMonthly * duration) : 0;
        const hostelTotal = structure.has_hostel ? (hostelFeeMonthly * duration) : 0;
        
        feeDisplayEl.innerHTML = `
            <h4>💰 Fee Structure Details</h4>
            <p><strong>Admission Fee:</strong> ₹${admissionFee.toFixed(2)}</p>
            <p><strong>Registration Fee:</strong> ₹${registrationFee.toFixed(2)}</p>
            <p><strong>Examination Fee:</strong> ₹${examinationFee.toFixed(2)}</p>
            ${structure.has_transport ? `<p><strong>Transport Fee (x${duration} mos):</strong> ₹${transportTotal.toFixed(2)}</p>` : ''}
            ${structure.has_hostel ? `<p><strong>Hostel Fee (x${duration} mos):</strong> ₹${hostelTotal.toFixed(2)}</p>` : ''}
            <hr>
            <p style="font-weight: bold;">TOTAL ESTIMATED FEE: ₹${totalFee}</p>
        `;
        
    } catch (err) {
        // Check if the error message is from a 404 response
        if (err.message.includes('Server error: 404')) {
            feeDisplayEl.innerHTML = '<p style="color:red;">⚠️ No Fee Structure found for this Course/Batch combination.</p>';
        } else {
            console.error('Fee Fetch Error:', err);
            feeDisplayEl.innerHTML = '<p style="color:red;">A server error occurred while retrieving fees.</p>';
        }
    }
}

function calculateTotalFee(structure) {
    const admission = parseFloat(structure.admission_fee) || 0;
    const registration = parseFloat(structure.registration_fee) || 0;
    const examination = parseFloat(structure.examination_fee) || 0;
    const duration = parseInt(structure.course_duration_months) || 0;
    
    const transport = structure.has_transport ? (parseFloat(structure.transport_fee) || 0) * duration : 0;
    const hostel = structure.has_hostel ? (parseFloat(structure.hostel_fee) || 0) * duration : 0;
    
    return (admission + registration + examination + transport + hostel).toFixed(2);
}

function clearFeeAndSubjectDisplay(feeDisplayEl, subjectsDisplayEl) { 
    if (feeDisplayEl) feeDisplayEl.innerHTML = 'Fee structure details will appear here upon Course and Batch selection.';
    if (subjectsDisplayEl) subjectsDisplayEl.innerHTML = '<p>Subjects assigned to this Course will appear here.</p>';
}

function clearFeeDisplay(feeDisplayEl) { 
    if (feeDisplayEl) feeDisplayEl.innerHTML = 'Fee structure details will appear here upon Course and Batch selection.';
}


// --- Form Submission ---

async function handleAddStudentSubmit(event) {
    event.preventDefault(); 
    const form = event.target;
    const submitButton = form.querySelector('button[type="submit"]');

    // 1. FULL FORM VALIDATION & REDIRECTION
    const firstInvalidInput = validateFullFormAndFindFirstError(form);

    if (firstInvalidInput) {
        const fieldsetWithError = firstInvalidInput.closest('fieldset');
        const stepMap = { personal: 1, academics: 2, parents: 3, login: 4 }; 
        const stepNumber = stepMap[fieldsetWithError.id];
        
        const tabButton = document.querySelector(`.tab-button[data-step="${stepNumber}"]`);
        
        if (tabButton) {
            openTab({currentTarget: tabButton}, fieldsetWithError.id);
        }
        
        firstInvalidInput.focus();
        return; 
    }
    
    // 2. Password Match Check
    const passwordInput = form.querySelector('#password');
    const confirmPasswordInput = form.querySelector('#confirm_password');
    
    if (passwordInput.value !== confirmPasswordInput.value) {
        alert("Error: Passwords do not match!");
        passwordInput.style.border = '2px solid var(--accent-color)';
        confirmPasswordInput.style.border = '2px solid var(--accent-color)';
        openTab({currentTarget: document.querySelector('.tab-bar button[data-step="4"]')}, 'login');
        return; 
    } else {
        passwordInput.style.border = '';
        confirmPasswordInput.style.border = '';
    }

    // 3. Prepare Data & Disable Button
    const formData = new FormData(form);
    const studentData = Object.fromEntries(formData.entries());
    delete studentData.confirm_password; 

    // Handle empty optional IDs
    for (const key of ['academic_session_id', 'branch_id']) {
        if (studentData[key] === '') {
            studentData[key] = null;
        }
    }

    const API_ENDPOINT = '/api/students'; 
    submitButton.textContent = 'Submitting...';
    submitButton.disabled = true;

    try {
        // 4. API Submission
        const response = await handleApi(API_ENDPOINT, { method: 'POST', body: studentData }); 
        const result = await response.json();
        
        alert(`✅ Student successfully enrolled! Enrollment No: ${result.enrollment_no || 'N/A'}`);
        form.reset(); 
        
        // 5. UI Reset on Success
        clearFeeAndSubjectDisplay(document.getElementById('fee-structure-display'), document.getElementById('subjects-display'));
        
        const firstTabButton = document.querySelector('.tab-bar button[data-step="1"]');
        if (firstTabButton) {
            openTab({currentTarget: firstTabButton}, 'personal');
        }
        
    } catch (error) {
         // This now catches 400, 403, 409, 500 errors from handleApi
         console.error('Submission Error:', error);
         alert(`❌ Enrollment Failed: ${error.message || 'Unknown error'}`);
    } finally {
        submitButton.textContent = 'Add Student';
        submitButton.disabled = false;
    }
}