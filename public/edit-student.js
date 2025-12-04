document.addEventListener('DOMContentLoaded', initializeEditForm);

// --- Constants & Global State ---
const AUTH_TOKEN = localStorage.getItem('erp-token');
const ACADEMICS_API = '/api/academicswithfees';
const STUDENTS_API = '/api/students';

// Get the student ID from the URL
const STUDENT_ID = new URLSearchParams(window.location.search).get('id');

// CRITICAL State Variable: Stores the associated User ID needed for the PUT request
let STUDENT_USER_ID = null; 


/**
 * Helper function for authenticated API calls.
 */
async function handleApi(url, options = {}) {
    options.headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` };
    
    // Set method defaults
    if (!options.method) {
        options.method = 'GET';
    } 
    // If body is an object, stringify it
    if (options.body && typeof options.body !== 'string' && options.method !== 'GET') {
        options.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, options);

    // Handle authentication failure globally
    if (response.status === 401 || response.status === 403) {
        alert('Session expired or unauthorized. Please log in again.');
        window.location.href = '/login.html';
        throw new Error('Unauthorized');
    }
    return response;
}

/**
 * Initializes the form, loads necessary data, and attaches event listeners.
 */
async function initializeEditForm() {
    const form = document.getElementById('editStudentForm'); 
    
    if (!form || !AUTH_TOKEN || !STUDENT_ID) {
        if (!STUDENT_ID) document.getElementById('profileContainer').innerHTML = '<h2>Error: Student ID is missing.</h2>';
        return;
    }

    form.addEventListener('submit', handleEditStudentSubmit);
    
    const courseSelect = document.getElementById('course_id');
    if (courseSelect) courseSelect.addEventListener('change', handleCourseChange);

    await loadInitialDropdowns();
    await loadStudentData(STUDENT_ID, form);
}

// ----------------------------------------------------------------------
//                        DATA FETCHING AND PRE-FILLING
// ----------------------------------------------------------------------

async function loadInitialDropdowns() {
    const courseSelect = document.getElementById('course_id');
    const batchSelect = document.getElementById('batch_id');
    if (!courseSelect || !batchSelect) return;

    courseSelect.innerHTML = '<option value="">Loading Courses...</option>';
    batchSelect.innerHTML = '<option value="">-- Waiting for Course --</option>';

    try {
        const response = await handleApi(`${ACADEMICS_API}/courses`);
        const courses = await response.json();
        courseSelect.innerHTML = '<option value="">-- Select Course --</option>';
        if (Array.isArray(courses)) {
            courses.forEach(c => {
                courseSelect.innerHTML += `<option value="${c.id || c.course_id}">${c.course_name} (${c.course_code})</option>`;
            });
        }
    } catch (err) {
        console.error('Failed to load courses:', err);
        courseSelect.innerHTML = '<option value="">Error loading courses</option>';
    }
}

async function loadStudentData(studentId, form) {
    const loadingMessage = document.getElementById('loadingMessage');
    loadingMessage.textContent = 'Loading Student Profile...';
    
    try {
        const response = await handleApi(`${STUDENTS_API}/${studentId}`);
        if (!response.ok) { throw new Error(`Failed to fetch student profile: ${response.statusText}`); }
        const student = await response.json();
        
        // CRITICAL: Store the retrieved user_id 
        STUDENT_USER_ID = student.user_id; 
        
        // 1. Pre-fill basic form data
        for (const key in student) {
            const input = form.querySelector(`[name="${key}"]`);
            if (input) {
                if (input.type === 'date' && student[key]) {
                    input.value = student[key].substring(0, 10);
                } else if (input.type !== 'password' && key !== 'username') {
                    input.value = student[key];
                }
            }
        }

        // 2. Handle Course and Batch dependent loading
        if (student.course_id) {
            const courseSelect = document.getElementById('course_id');
            if (courseSelect) courseSelect.value = student.course_id;

            // Wait for batches to populate before setting the batch value
            await populateBatchDropdown(student.course_id); 

            const batchSelect = document.getElementById('batch_id');
            if (batchSelect) batchSelect.value = student.batch_id;
            
            // Trigger associated lookups
            loadSubjects(student.course_id, document.getElementById('subjects-display'));
            loadFeeStructure(student.course_id, student.batch_id, document.getElementById('fee-structure-display'));
        }

        loadingMessage.textContent = `Editing Student Profile: ${student.first_name} ${student.last_name}`;

    } catch (error) {
        console.error('Error loading student data:', error);
        loadingMessage.textContent = `Error loading student data: ${error.message}`;
        form.querySelector('button[type="submit"]').disabled = true;
    }
}

// ----------------------------------------------------------------------
//                        DYNAMIC DROPDOWN & INFO LOGIC
// ----------------------------------------------------------------------

async function handleCourseChange(event) {
    const courseId = event.target.value;
    const feeDisplayEl = document.getElementById('fee-structure-display'); 
    const subjectsDisplayEl = document.getElementById('subjects-display');
    
    // Clear displays 
    clearFeeDisplay(feeDisplayEl);
    if (subjectsDisplayEl) subjectsDisplayEl.innerHTML = '<p>Subjects assigned to this Course will appear here.</p>';

    await populateBatchDropdown(courseId);
    
    loadSubjects(courseId, subjectsDisplayEl); 
}

async function populateBatchDropdown(courseId) {
    const batchSelect = document.getElementById('batch_id');
    if (!batchSelect) return;

    batchSelect.innerHTML = '<option value="">Loading batches...</option>';
    
    // Cleanup previous listener before potentially adding a new one
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
            // Re-attach batch change handler
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
    if (!subjectsDisplayEl || !courseId) {
        if(subjectsDisplayEl) subjectsDisplayEl.innerHTML = '<p>Subjects assigned to this Course will appear here.</p>';
        return;
    }
    subjectsDisplayEl.innerHTML = 'Fetching assigned subjects...';

    try {
        const response = await handleApi(`${ACADEMICS_API}/courses/${courseId}/subjects`);
        if (response.ok) {
            const subjects = await response.json();
            const listHtml = (Array.isArray(subjects) && subjects.length > 0) 
                ? subjects.map(s => `<li>${s.subject_name} (${s.subject_code})</li>`).join('')
                : '<p>⚠️ No subjects are currently assigned to this course.</p>';
            subjectsDisplayEl.innerHTML = `<h4>📚 Assigned Subjects</h4><ul style="margin-top: 5px; padding-left: 20px;">${listHtml}</ul>`;
        } else {
            const error = await response.json();
            subjectsDisplayEl.innerHTML = `<p style="color:red;">Error fetching subjects: ${error.message || response.statusText}</p>`;
        }
    } catch (err) {
        console.error('Subject Fetch Error:', err);
        subjectsDisplayEl.innerHTML = '<p style="color:red;">Error retrieving subjects.</p>';
    }
}

async function loadFeeStructure(courseId, batchId, feeDisplayEl) {
    if (!feeDisplayEl || !courseId || !batchId) return; 
    feeDisplayEl.innerHTML = 'Fetching fee structure...';
    try {
        const response = await handleApi(`${ACADEMICS_API}/fees/structures/find?course_id=${courseId}&batch_id=${batchId}`);
        if (response.ok) {
            const structure = await response.json();
            const totalFee = calculateTotalFee(structure);
            
            // CRITICAL FIX: Use parseFloat() to handle database strings and prevent TypeError
            feeDisplayEl.innerHTML = `
                <h4>💰 Fee Structure Details</h4>
                <p><strong>Admission Fee:</strong> ₹${parseFloat(structure.admission_fee || 0).toFixed(2)}</p>
                <p><strong>Registration Fee:</strong> ₹${parseFloat(structure.registration_fee || 0).toFixed(2)}</p>
                <p><strong>Tuition Fee:</strong> ₹${parseFloat(structure.tuition_fee || 0).toFixed(2)}</p>
                <p><strong>Examination Fee:</strong> ₹${parseFloat(structure.examination_fee || 0).toFixed(2)}</p>
                <p><strong>Duration:</strong> ${structure.course_duration_months} months</p>
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
    // CRITICAL FIX: Ensure all structure properties are parsed as floats before calculation.
    const admission = parseFloat(structure.admission_fee) || 0;
    const registration = parseFloat(structure.registration_fee) || 0;
    const tuition = parseFloat(structure.tuition_fee) || 0;
    const examination = parseFloat(structure.examination_fee) || 0;
    const duration = parseInt(structure.course_duration_months) || 1;
    
    // Monthly fees are calculated over the course duration
    const transport = structure.has_transport ? (parseFloat(structure.transport_fee) || 0) * duration : 0;
    const hostel = structure.has_hostel ? (parseFloat(structure.hostel_fee) || 0) * duration : 0;
    
    const total = admission + registration + tuition + examination + transport + hostel;
    return total.toFixed(2);
}

function clearFeeDisplay(feeDisplayEl) { 
    if (feeDisplayEl) {
        feeDisplayEl.innerHTML = 'Fee structure details will appear here upon Course and Batch selection.';
    }
}


// ----------------------------------------------------------------------
//                          FORM SUBMISSION
// ----------------------------------------------------------------------

async function handleEditStudentSubmit(event) {
    event.preventDefault(); 
    const form = event.target;
    
    const password = form.querySelector('#password').value;
    const confirmPassword = form.querySelector('#confirm_password').value;

    // Basic client-side validation for password change intention
    if (password || confirmPassword) {
        if (password !== confirmPassword) {
            alert("Error: New Password and Confirm Password do not match!");
            return; 
        }
    }

    const formData = new FormData(form);
    const studentData = Object.fromEntries(formData.entries());

    // Clean up request body
    delete studentData.confirm_password; 
    if (studentData.password === "") { delete studentData.password; }
    
    // Attach the stored user_id for the backend transaction
    if (STUDENT_USER_ID !== null) {
        studentData.user_id = STUDENT_USER_ID; 
    } else {
        alert("CRITICAL Error: Student's User ID is missing. Cannot update.");
        return;
    }

    const API_ENDPOINT = `${STUDENTS_API}/${STUDENT_ID}`; 
    
    try {
        const response = await handleApi(API_ENDPOINT, { method: 'PUT', body: studentData });
        
        const result = await response.json();
        
        if (response.ok) {
            // FIX: Display the reliable, server-constructed message 
            alert(result.message); 
            // Reload data to reflect any changes
            await loadStudentData(STUDENT_ID, form); 
        } else {
            alert(`Update Failed: ${result.message || response.statusText}`);
        }
    } catch (error) {
        console.error('Network Error:', error);
        alert('A network error occurred. Please check your connection.');
    }
}