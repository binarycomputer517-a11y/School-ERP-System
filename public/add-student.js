// public/add-student.js

document.addEventListener('DOMContentLoaded', initializeAddForm);

// --- Global Constants ---
const AUTH_TOKEN = localStorage.getItem('erp-token');
const ACADEMICS_API = '/api/academicswithfees';


// --- CORE API HANDLER ---
/**
 * Helper function for authenticated API calls.
 */
async function handleApi(url, options = {}) {
    // Ensure body is stringified for POST/PUT requests if it's an object
    if (options.body && typeof options.body === 'object' && !options.headers?.['Content-Type']) {
        options.body = JSON.stringify(options.body);
    }
    
    // Set authentication and content type headers
    options.headers = { 
        ...options.headers,
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${AUTH_TOKEN}` 
    };

    const response = await fetch(url, options);
    
    if (response.status === 401 || response.status === 403) {
        alert('Session expired or unauthorized. Please log in again.');
        window.location.href = '/login.html';
        throw new Error('Unauthorized');
    }
    return response;
}


// --- VALIDATION LOGIC ---

/**
 * Validates required fields in the current active fieldset.
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

    updateProgressBar(1);
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
    
    clearFeeAndSubjectDisplay(feeDisplayEl, subjectsDisplayEl);
    
    await populateBatchDropdown(courseId);
    
    if (courseId) {
        loadSubjects(courseId, subjectsDisplayEl); 
    }
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
            const error = await response.json().catch(() => ({ message: response.statusText }));
            subjectsDisplayEl.innerHTML = `<p style="color:red;">Error fetching subjects: ${error.message}</p>`;
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

            // Ensure numeric conversions for display
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
        } else if (response.status === 404) {
            feeDisplayEl.innerHTML = '<p style="color:red;">⚠️ No Fee Structure found for this Course/Batch combination.</p>';
        } else {
             const error = await response.json().catch(() => ({ message: response.statusText }));
             feeDisplayEl.innerHTML = `<p style="color:red;">Error fetching fee: ${error.message}</p>`;
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
    const duration = parseInt(structure.course_duration_months) || 0;
    
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
    
    // 1. Final Step Validation
    if (!validateCurrentStep()) {
        openTab({currentTarget: document.querySelector('.tab-bar button[data-step="4"]')}, 'login');
        return; 
    }
    
    // 2. Password Match Check
    const passwordInput = form.querySelector('#password');
    const confirmPasswordInput = form.querySelector('#confirm_password');
    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    passwordInput.style.border = '';
    confirmPasswordInput.style.border = '';
    
    if (password !== confirmPassword) {
        alert("Error: Passwords do not match!");
        passwordInput.style.border = '2px solid var(--accent-color)';
        confirmPasswordInput.style.border = '2px solid var(--accent-color)';
        return; 
    }

    // 3. Prepare Data
    const formData = new FormData(form);
    const studentData = Object.fromEntries(formData.entries());

    delete studentData.confirm_password; 

    const API_ENDPOINT = '/api/students'; 
    const submitButton = form.querySelector('button[type="submit"]');

    submitButton.textContent = 'Submitting...';
    submitButton.disabled = true;

    try {
        // 4. API Submission
        const response = await handleApi(API_ENDPOINT, { method: 'POST', body: studentData }); 
        
        const result = await response.json();
        
        if (response.ok) {
            alert(`✅ Student successfully enrolled! Enrollment No: ${result.enrollment_no || 'N/A'}`);
            form.reset(); 
            
            // 5. UI Reset on Success
            clearFeeAndSubjectDisplay(document.getElementById('fee-structure-display'), document.getElementById('subjects-display'));
            
            const firstTabButton = document.querySelector('.tab-bar button[data-step="1"]');
            if (firstTabButton) {
                openTab({currentTarget: firstTabButton}, 'personal');
            }
            
        } else {
            alert(`❌ Enrollment Failed: ${result.message || response.statusText}`);
        }
    } catch (error) {
        if (error.message !== 'Unauthorized') {
             console.error('Network Error:', error);
             alert('🚨 A network error occurred. Could not connect to the API.');
        }
    } finally {
        submitButton.textContent = 'Add Student';
        submitButton.disabled = false;
    }
}