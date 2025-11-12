// public/edit-student.js

document.addEventListener('DOMContentLoaded', initializeEditForm);

// Retrieve the token from localStorage set during login
const AUTH_TOKEN = localStorage.getItem('erp-token');
const ACADEMICS_API = '/api/academicswithfees';
const STUDENTS_API = '/api/students';

// Get the student ID from the URL (e.g., /edit-student.html?id=...)
const STUDENT_ID = new URLSearchParams(window.location.search).get('id');

// Variable to store the student's integer User ID retrieved from the database
let STUDENT_USER_ID = null; // <--- ADDED GLOBAL VARIABLE


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

/**
 * Initializes the student edit form: fetches student data, pre-fills form, and attaches listeners.
 */
async function initializeEditForm() {
    const form = document.getElementById('editStudentForm'); 
    
    if (!form || !AUTH_TOKEN) {
        if (!AUTH_TOKEN) alert('Authentication token missing. Please log in.');
        return;
    }
    
    if (!STUDENT_ID) {
        document.getElementById('profileContainer').innerHTML = '<h2>Error: Student ID is missing. Please select a student to edit.</h2>';
        return;
    }

    // Attach event listeners
    form.addEventListener('submit', handleEditStudentSubmit);
    
    const courseSelect = document.getElementById('course_id');
    if (courseSelect) courseSelect.addEventListener('change', handleCourseChange);

    // Load initial data and pre-fill form
    await loadInitialDropdowns();
    await loadStudentData(STUDENT_ID, form);
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

// --- Logic: Load and Pre-fill Student Data ---

async function loadStudentData(studentId, form) {
    const loadingMessage = document.getElementById('loadingMessage');
    loadingMessage.textContent = 'Loading Student Profile...';
    
    try {
        const response = await handleApi(`${STUDENTS_API}/${studentId}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch student profile: ${response.statusText}`);
        }
        const student = await response.json();
        
        // --- CRITICAL FIX: Store the retrieved user_id globally ---
        STUDENT_USER_ID = student.user_id; 
        
        // 1. Pre-fill basic form data
        for (const key in student) {
            const input = form.querySelector(`[name="${key}"]`);
            if (input) {
                if (input.type === 'date' && student[key]) {
                    input.value = student[key].substring(0, 10);
                } else if (input.type === 'password' || key === 'username') {
                    // Skip password pre-fill for security
                } else {
                    input.value = student[key];
                }
            }
        }

        // 2. Handle Course and Batch dependent loading
        if (student.course_id) {
            // Set the course selection
            const courseSelect = document.getElementById('course_id');
            if (courseSelect) courseSelect.value = student.course_id;

            // Trigger batch population
            await populateBatchDropdown(student.course_id); 

            // After batches are populated, set the batch selection
            const batchSelect = document.getElementById('batch_id');
            if (batchSelect) batchSelect.value = student.batch_id;
            
            // Manually trigger fee and subject loading based on loaded data
            const feeDisplayEl = document.getElementById('fee-structure-display');
            const subjectsDisplayEl = document.getElementById('subjects-display');
            
            loadSubjects(student.course_id, subjectsDisplayEl);
            loadFeeStructure(student.course_id, student.batch_id, feeDisplayEl);
        }

        loadingMessage.textContent = `Editing Student Profile: ${student.first_name} ${student.last_name}`;
        document.title = `Edit: ${student.first_name}`;

    } catch (error) {
        console.error('Error loading student data:', error);
        loadingMessage.textContent = `Error loading student data: ${error.message}`;
        form.querySelector('button[type="submit"]').disabled = true;
    }
}


// --- Dependency Handlers (Course, Batch, Fee, Subject) ---

async function handleCourseChange(event) {
    const courseId = event.target.value;
    const feeDisplayEl = document.getElementById('fee-structure-display'); 
    const subjectsDisplayEl = document.getElementById('subjects-display');
    
    clearFeeAndSubjectDisplay(feeDisplayEl, subjectsDisplayEl); 
    
    await populateBatchDropdown(courseId);
    
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

function clearFeeAndSubjectDisplay(feeDisplayEl, subjectsDisplayEl) { 
    if (feeDisplayEl) {
        feeDisplayEl.innerHTML = 'Fee structure details will appear here upon Course and Batch selection.';
    }
    if (subjectsDisplayEl) {
         subjectsDisplayEl.innerHTML = '<p>Subjects assigned to this Course will appear here.</p>';
    }
}

function clearFeeDisplay(feeDisplayEl) { 
    if (feeDisplayEl) {
        feeDisplayEl.innerHTML = 'Fee structure details will appear here upon Course and Batch selection.';
    }
}


// --- Form Submission (PUT Method) ---

async function handleEditStudentSubmit(event) {
    event.preventDefault(); 
    const form = event.target;
    
    const password = form.querySelector('#password').value;
    const confirmPassword = form.querySelector('#confirm_password').value;

    // Only check password if the user entered values (meaning they intend to change it)
    if (password || confirmPassword) {
        if (password !== confirmPassword) {
            alert("Error: New Password and Confirm Password do not match!");
            return; 
        }
    }

    const formData = new FormData(form);
    const studentData = Object.fromEntries(formData.entries());

    // Remove confirmation field
    delete studentData.confirm_password; 

    // If password fields are empty, remove them entirely so the API doesn't hash an empty string
    if (studentData.password === "") {
        delete studentData.password;
    }
    
    // *** CRITICAL FIX: Explicitly include the stored user_id for server validation ***
    if (STUDENT_USER_ID !== null) {
        studentData.user_id = STUDENT_USER_ID; 
    } else {
        alert("CRITICAL Error: Student's User ID is missing. Cannot update.");
        return;
    }

    const API_ENDPOINT = `${STUDENTS_API}/${STUDENT_ID}`; 
    
    try {
        // Use PUT method for updating an existing resource
        const response = await handleApi(API_ENDPOINT, { method: 'PUT', body: JSON.stringify(studentData) });
        
        const result = await response.json();
        if (response.ok) {
            alert(`Student Profile for ${result.first_name} updated successfully!`);
            // Optional: Reload the data to reflect any changes from the server
            // await loadStudentData(STUDENT_ID, form); 
        } else {
            alert(`Update Failed: ${result.message || response.statusText}`);
        }
    } catch (error) {
        console.error('Network Error:', error);
        alert('A network error occurred. Could not connect to the API.');
    }
}