// ===============================================
// AUTH & HELPERS
// ===============================================
const token = localStorage.getItem('erp-token');
const userRole = localStorage.getItem('user-role');
const activeSessionId = localStorage.getItem('active_session_id'); // ⭐ ADDED: Fetch active session ID

// UPDATED: Check for both 'Admin' and 'Super Admin'
if (!token || (userRole !== 'Admin' && userRole !== 'Super Admin')) {
    window.location.href = '/login';
}
const authHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

async function handleApi(url, options = {}) {
    options.headers = { ...authHeaders, ...options.headers };
    const response = await fetch(url, options);
    if (response.status === 401 || response.status === 403) {
        alert('Session expired or unauthorized. Please log in again.');
        window.location.href = '/login';
        throw new Error('Unauthorized');
    }
    return response;
}

function openModal(modalId) { document.getElementById(modalId).style.display = 'flex'; }
function closeModal(modalId) { document.getElementById(modalId).style.display = 'none'; }

// ===============================================
// ENTITY MANAGEMENT LOGIC (CRUD)
// ===============================================

// --- Generic Delete Function ---
async function handleDelete(entityType, id, loader, extraParam = null) {
    if (!confirm(`Are you sure you want to delete this item?`)) return;
    try {
        const url = entityType === 'batches' ? `/api/academicswithfees/batches/${id}` : `/api/academicswithfees/${entityType}/${id}`;
        const response = await handleApi(url, { method: 'DELETE' });
        if (response.ok) {
            alert('Item deleted successfully!');
            if(loader) loader(extraParam); // Rerender list
            if (entityType === 'courses' || entityType === 'batches') {
                populateCourseDropdown(); // Keep dropdown fresh
                fetchAndRenderFeeStructures(); // Refresh fee list
            }
        } else {
            const error = await response.json();
            alert(`Error: ${error.message}`);
        }
    } catch (err) { console.error('Deletion error:', err); alert('A server error occurred.'); }
}

// --- Generic Edit Modal ---
function openEditModal(entityType, id, name, code = '') {
    document.getElementById('edit-id').value = id;
    document.getElementById('edit-entity-type').value = entityType;
    document.getElementById('edit-name').value = name;
    document.getElementById('edit-code').value = code;
    openModal('edit-modal');
}

document.getElementById('edit-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const id = document.getElementById('edit-id').value;
    const entityType = document.getElementById('edit-entity-type').value;
    const name = document.getElementById('edit-name').value;
    const code = document.getElementById('edit-code').value;

    const body = {
        courses: { course_name: name, course_code: code },
        subjects: { subject_name: name, subject_code: code },
        batches: { batch_name: name, batch_code: code }
    }[entityType];

    try {
        const response = await handleApi(`/api/academicswithfees/${entityType}/${id}`, { method: 'PUT', body: JSON.stringify(body) });
        if (response.ok) {
            alert('Item updated successfully!');
            closeModal('edit-modal');
            // Reload the relevant list
            if (entityType === 'courses') { loadCourses(); populateCourseDropdown(); fetchAndRenderFeeStructures(); }
            if (entityType === 'subjects') loadSubjects();
            
            // Reload batch list after edit
            if (entityType === 'batches') {
                const courseId = document.getElementById('batch-course-id').value;
                if(courseId) loadBatchesForCourse(courseId);
            }
        } else {
            const error = await response.json();
            alert(`Update failed: ${error.message}`);
        }
    } catch (err) { alert('A server error occurred during update.'); }
});

// --- Course Management ---
async function loadCourses() {
    const list = document.getElementById('course-list');
    try {
        const response = await handleApi('/api/academicswithfees/courses');
        const courses = await response.json();
        list.innerHTML = courses.map(c => `
            <li>
                <span><strong>${c.course_name}</strong> (${c.course_code})</span>
                <span class="item-actions">
                    <button onclick="openBatchManager('${c.course_id}', '${c.course_name.replace(/'/g, "\\'")}')">Manage Batches</button>
                    <button onclick="openSubjectManager('${c.course_id}', '${c.course_name.replace(/'/g, "\\'")}')">Assign Subjects</button>
                    <button onclick="openEditModal('courses', '${c.course_id}', '${c.course_name.replace(/'/g, "\\'")}', '${c.course_code.replace(/'/g, "\\'")}')">Edit</button>
                    <button class="delete-btn" onclick="handleDelete('courses', '${c.course_id}', loadCourses)">Delete</button>
                </span>
            </li>
        `).join('');
    } catch (err) { list.innerHTML = '<li>Error loading courses.</li>'; }
}

document.getElementById('course-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const body = { course_name: e.target.elements['course-name'].value, course_code: e.target.elements['course-code'].value };
    try {
        const response = await handleApi('/api/academicswithfees/courses', { method: 'POST', body: JSON.stringify(body) });
        if (response.ok) {
            e.target.reset();
            loadCourses();
            populateCourseDropdown(); // Refresh dropdown in fee form
        } else {
            const error = await response.json();
            alert(`Error: ${error.message}`);
        }
    } catch (err) { alert('A network error occurred.'); }
});


// --- Master Subject List Management ---
async function loadSubjects() {
    const list = document.getElementById('subject-list');
    try {
        const response = await handleApi('/api/academicswithfees/subjects');
        const subjects = await response.json();
        list.innerHTML = subjects.map(s => `
            <li>
                <span><strong>${s.subject_name}</strong> (${s.subject_code})</span>
                <span class="item-actions">
                    <button onclick="openEditModal('subjects', '${s.subject_id}', '${s.subject_name.replace(/'/g, "\\'")}', '${s.subject_code.replace(/'/g, "\\'")}')">Edit</button>
                    <button class="delete-btn" onclick="handleDelete('subjects', '${s.subject_id}', loadSubjects)">Delete</button>
                </span>
            </li>`).join('');
    } catch (err) { list.innerHTML = '<li>Error loading subjects.</li>'; }
}
document.getElementById('subject-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const body = { subject_name: e.target.elements['subject-name'].value, subject_code: e.target.elements['subject-code'].value };
    try {
        const response = await handleApi('/api/academicswithfees/subjects', { method: 'POST', body: JSON.stringify(body) });
        if (response.ok) { e.target.reset(); loadSubjects(); }
        else { const err = await response.json(); alert(`Error: ${err.message}`); }
    } catch (err) { alert('A network error occurred.'); }
});

// --- Batch Management (within Course Modal) ---
async function openBatchManager(courseId, courseName) {
    document.getElementById('batch-modal-title').textContent = `Manage Batches for: ${courseName}`;
    document.getElementById('batch-course-id').value = courseId;
    loadBatchesForCourse(courseId);
    openModal('batch-modal');
}
async function loadBatchesForCourse(courseId) {
    const list = document.getElementById('batch-list');
    try {
        const response = await handleApi(`/api/academicswithfees/courses/${courseId}/batches`);
        const batches = await response.json();
        list.innerHTML = batches.map(b => `
            <li>
                <span><strong>${b.batch_name}</strong> (${b.batch_code})</span>
                <span class="item-actions">
                    <button onclick="openEditModal('batches', '${b.batch_id}', '${b.batch_name.replace(/'/g, "\\'")}', '${b.batch_code.replace(/'/g, "\\'")}')">Edit</button>
                    <button class="delete-btn" onclick="handleDelete('batches', '${b.batch_id}', loadBatchesForCourse, '${courseId}')">Delete</button>
                </span>
            </li>`).join('');
    } catch (err) { list.innerHTML = '<li>Error loading batches.</li>'; }
}
document.getElementById('batch-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const courseId = document.getElementById('batch-course-id').value;
    const body = {
        course_id: courseId,
        batch_name: e.target.elements['batch-name'].value,
        batch_code: e.target.elements['batch-code'].value
    };
    try {
        const response = await handleApi('/api/academicswithfees/batches', { method: 'POST', body: JSON.stringify(body) });
        if (response.ok) { 
            e.target.reset(); 
            loadBatchesForCourse(courseId);
            populateCourseDropdown(); // Refresh course dropdown to reflect new batch
            fetchAndRenderFeeStructures(); // Refresh fee list
        }
        else { const err = await response.json(); alert(`Error: ${err.message}`); }
    } catch (err) { alert('A network error occurred.'); }
});

// --- Subject Assignment (within Course Modal) ---
async function openSubjectManager(courseId, courseName) {
    document.getElementById('subject-modal-title').textContent = `Assign Subjects to: ${courseName}`;
    document.getElementById('subject-course-id').value = courseId;
    
    const assignmentList = document.getElementById('subject-assignment-list');
    assignmentList.innerHTML = 'Loading...';
    openModal('subject-assign-modal');

    try {
        // Fetch all subjects and subjects already assigned to this course concurrently
        const [allSubjectsRes, assignedSubjectsRes] = await Promise.all([
            handleApi('/api/academicswithfees/subjects'),
            handleApi(`/api/academicswithfees/courses/${courseId}/subjects`)
        ]);
        const allSubjects = await allSubjectsRes.json();
        const assignedSubjects = await assignedSubjectsRes.json();
        const assignedIds = new Set(assignedSubjects.map(s => s.subject_id));

        assignmentList.innerHTML = allSubjects.map(s => `
            <div>
                <input type="checkbox" id="subject-${s.subject_id}" name="subjectIds" value="${s.subject_id}" ${assignedIds.has(s.subject_id) ? 'checked' : ''}>
                <label for="subject-${s.subject_id}">${s.subject_name} (${s.subject_code})</label>
            </div>`).join('');

    } catch (err) { assignmentList.innerHTML = 'Failed to load subjects.'; }
}
document.getElementById('subject-assign-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const courseId = document.getElementById('subject-course-id').value;
    const selectedCheckboxes = document.querySelectorAll('#subject-assignment-list input[type="checkbox"]:checked');
    
    // UUIDs are sent as strings
    const subjectIds = Array.from(selectedCheckboxes).map(cb => cb.value);
    
    try {
        const response = await handleApi(`/api/academicswithfees/courses/${courseId}/subjects`, {
            method: 'PUT',
            body: JSON.stringify({ subjectIds })
        });
        if (response.ok) {
            alert('Subject assignments updated successfully!');
            closeModal('subject-assign-modal');
        } else {
            const err = await response.json();
            alert(`Error: ${err.message}`);
        }
    } catch (err) { alert('A network error occurred.'); }
});

// ===============================================
// FEE MANAGEMENT LOGIC
// ===============================================
const feeForm = document.getElementById('fee-form');
const courseSelect = document.getElementById('course_code_select');
const batchSelect = document.getElementById('batch_code_select');


function calculateTotalFee(structure) {
    const admission = parseFloat(structure.admission_fee) || 0;
    const registration = parseFloat(structure.registration_fee) || 0;
    const examination = parseFloat(structure.examination_fee) || 0;
    const duration = parseInt(structure.course_duration_months) || 1;
    
    // Monthly fees are multiplied by duration
    const transport = structure.has_transport ? (parseFloat(structure.transport_fee) || 0) * duration : 0;
    const hostel = structure.has_hostel ? (parseFloat(structure.hostel_fee) || 0) * duration : 0;
    
    const total = admission + registration + examination + transport + hostel;
    return total.toFixed(2);
}

// Function to reset the form after editing is cancelled or saved
function resetFeeForm() {
    feeForm.reset();
    document.getElementById('form-title').textContent = 'Create New Fee Structure';
    document.getElementById('submit-btn').textContent = 'Create Structure';
    document.getElementById('cancel-btn').style.display = 'none';
    document.getElementById('structure_id').value = '';
    document.getElementById('transport-fee-field').style.display = 'none';
    document.getElementById('hostel-fee-field').style.display = 'none';
    document.getElementById('error-msg').textContent = '';
    // Reset batch dropdown
    batchSelect.innerHTML = '<option value="">-- Waiting for Course Selection --</option>';
    batchSelect.disabled = true;
    courseSelect.value = '';
    fetchAndRenderFeeStructures(); // Reload list after save/cancel
}

document.getElementById('cancel-btn').addEventListener('click', resetFeeForm);

async function populateCourseDropdown() {
    try {
        const response = await handleApi('/api/academicswithfees/courses');
        const courses = await response.json();
        courseSelect.innerHTML = '<option value="">-- First Select a Course --</option>';
        courses.forEach(c => {
            courseSelect.innerHTML += `<option value="${c.course_id}" data-code="${c.course_code}">${c.course_name} (${c.course_code})</option>`;
        });
    } catch (err) { console.error('Failed to populate course dropdown', err); }
}

// Refactored batch loading to its own function
async function populateBatchDropdown(courseId) {
    batchSelect.innerHTML = '<option value="">Loading batches...</option>';
    batchSelect.disabled = true;

    if (!courseId) {
        batchSelect.innerHTML = '<option value="">-- Waiting for Course Selection --</option>';
        return;
    }

    try {
        const response = await handleApi(`/api/academicswithfees/courses/${courseId}/batches`);
        const batches = await response.json();
        if (batches.length > 0) {
            batchSelect.innerHTML = '<option value="">-- Select a Batch --</option>';
            batches.forEach(b => {
                batchSelect.innerHTML += `<option value="${b.batch_id}" data-code="${b.batch_code}">${b.batch_name} (${b.batch_code})</option>`;
            });
            batchSelect.disabled = false;
        } else {
            batchSelect.innerHTML = '<option value="">-- No batches found for this course --</option>';
        }
    } catch (err) {
        batchSelect.innerHTML = '<option value="">-- Error loading batches --</option>';
    }
}

// Updated listener to use the new function
courseSelect.addEventListener('change', async function() {
    await populateBatchDropdown(this.value);
});


// Toggle visibility of transport fee field
document.getElementById('has_transport').addEventListener('change', function() {
    document.getElementById('transport-fee-field').style.display = this.checked ? 'block' : 'none';
    document.getElementById('transport_fee').required = this.checked;
});

// Toggle visibility of hostel fee field
document.getElementById('has_hostel').addEventListener('change', function() {
    document.getElementById('hostel-fee-field').style.display = this.checked ? 'block' : 'none';
    document.getElementById('hostel_fee').required = this.checked;
});


feeForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    const formData = new FormData(this);
    const serverPayload = Object.fromEntries(formData.entries());
    
    // ⭐ CRITICAL FIX: Inject the required academic session ID
    // --------------------------------------------------------
    const localActiveSessionId = localStorage.getItem('active_session_id'); 
    
    if (!localActiveSessionId || localActiveSessionId === 'null' || localActiveSessionId === 'undefined') {
         document.getElementById('error-msg').textContent = 'Error: Active academic session must be selected before creating a fee structure.';
         return;
    }
    serverPayload.academic_session_id = localActiveSessionId; 
    // --------------------------------------------------------
    
    // Add checkbox values
    serverPayload.has_transport = document.getElementById('has_transport').checked;
    serverPayload.has_hostel = document.getElementById('has_hostel').checked;
    
    // Convert numeric fields to numbers, ensure optional fields are 0 if unchecked
    ['admission_fee', 'registration_fee', 'examination_fee', 'transport_fee', 'hostel_fee'].forEach(key => {
        const val = serverPayload[key];
        serverPayload[key] = val ? parseFloat(val) : 0;
    });

    // Course/Batch IDs are correctly passed as strings (UUIDs)
    serverPayload.course_duration_months = parseInt(serverPayload.course_duration_months);

    const id = serverPayload.structure_id;
    delete serverPayload.structure_id; // remove from payload
    
    const isUpdate = !!id;
    const url = isUpdate ? `/api/academicswithfees/fees/structures/${id}` : '/api/academicswithfees/fees/structures';
    const method = isUpdate ? 'PUT' : 'POST';

    try {
        const response = await handleApi(url, { method, body: JSON.stringify(serverPayload) });
        const result = await response.json();
        if (response.ok) {
            alert(`Fee structure ${isUpdate ? 'updated' : 'created'} successfully!`);
            resetFeeForm(); // Reset and reload after success
        } else {
            document.getElementById('error-msg').textContent = result.message || 'An unknown error occurred.';
        }
    } catch (err) { 
        document.getElementById('error-msg').textContent = 'A server error occurred.';
    }
});

async function fetchAndRenderFeeStructures() {
    const tbody = document.getElementById('structures-table-body');
    tbody.innerHTML = '<tr><td colspan="5">Loading fee structures...</td></tr>';
    
    try {
        const response = await handleApi('/api/academicswithfees/fees/structures');
        const structures = await response.json();

        if (structures.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5">No fee structures defined yet.</td></tr>';
            return;
        }

        tbody.innerHTML = structures.map(s => {
            // Note: The structure object returned from the API must include 'course_code', 'batch_code', and 'id' (or 'structure_id')
            const totalFee = calculateTotalFee(s); // Use the helper function

            return `
                <tr>
                    <td>${s.structure_name}</td>
                    <td>${s.course_code}</td>
                    <td>${s.batch_code}</td>
                    <td>₹${totalFee}</td>
                    <td class="actions">
                        <button onclick="editFeeStructure('${s.id}')">Edit</button>
                        <button class="delete-btn" onclick="deleteFeeStructure('${s.id}')">Delete</button>
                    </td>
                </tr>
            `;
        }).join('');

    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="5">Error loading fee structures.</td></tr>';
        console.error('Fee Structure Load Error:', err);
    }
}

async function deleteFeeStructure(structureId) {
    if (!confirm('Are you sure you want to delete this Fee Structure? This action cannot be undone.')) return;
    
    try {
        const response = await handleApi(`/api/academicswithfees/fees/structures/${structureId}`, { method: 'DELETE' });
        
        if (response.ok) {
            alert('Fee structure deleted successfully!');
            fetchAndRenderFeeStructures(); // Reload the list
        } else {
            const error = await response.json();
            alert(`Deletion Error: ${error.message}`);
        }
    } catch (err) {
        alert('A network error occurred during deletion.');
    }
}

async function editFeeStructure(structureId) {
    document.getElementById('error-msg').textContent = '';
    
    // Added defensive check for undefined ID
    if (!structureId || structureId === 'undefined') {
        alert('Cannot edit: Invalid fee structure ID.');
        return;
    }

    try {
        const response = await handleApi(`/api/academicswithfees/fees/structures/${structureId}`);
        const structure = await response.json();

        // 1. Set Form Title and Buttons
        document.getElementById('form-title').textContent = `Edit Fee Structure: ${structure.structure_name}`;
        document.getElementById('submit-btn').textContent = 'Save Changes';
        document.getElementById('cancel-btn').style.display = 'inline-block';
        // Note: The API must return 'id' for the structure ID, or 'structure_id'
        document.getElementById('structure_id').value = structureId; 
        
        // 2. Populate Course/Batch (Triggers loading batches)
        document.getElementById('course_code_select').value = structure.course_id;
        
        // Wait for batches to load before setting the batch_id
        await populateBatchDropdown(structure.course_id);
        
        // Now set the batch
        document.getElementById('batch_code_select').value = structure.batch_id;
        
        // 3. Populate Fixed Fees and Duration
        document.getElementById('course_duration').value = structure.course_duration_months || '';
        document.getElementById('admission_fee').value = structure.admission_fee || '';
        document.getElementById('registration_fee').value = structure.registration_fee || '';
        document.getElementById('examination_fee').value = structure.examination_fee || '';
        
        // 4. Populate Optional Fees (Transport)
        const hasTransport = structure.has_transport;
        document.getElementById('has_transport').checked = hasTransport;
        document.getElementById('transport-fee-field').style.display = hasTransport ? 'block' : 'none';
        document.getElementById('transport_fee').value = structure.transport_fee || '';
        document.getElementById('transport_fee').required = hasTransport;

        // 5. Populate Optional Fees (Hostel)
        const hasHostel = structure.has_hostel;
        document.getElementById('has_hostel').checked = hasHostel;
        document.getElementById('hostel-fee-field').style.display = hasHostel ? 'block' : 'none';
        document.getElementById('hostel_fee').value = structure.hostel_fee || '';
        document.getElementById('hostel_fee').required = hasHostel;

        // Scroll to the form for easy editing
        document.getElementById('form-title').scrollIntoView({ behavior: 'smooth' });

    } catch (err) {
        alert('Failed to load fee structure for editing. Ensure the structure exists and the associated course/batch still exist.');
        console.error('Edit Load Error:', err);
    }
}


// ===============================================
// INITIALIZATION
// ===============================================
window.onload = () => {
    loadCourses();
    loadSubjects();
    populateCourseDropdown();
    fetchAndRenderFeeStructures();
};