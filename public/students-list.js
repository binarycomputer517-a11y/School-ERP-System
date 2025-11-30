document.addEventListener('DOMContentLoaded', initializeStudentList);

const API_ENDPOINT = '/api/students';
const TABLE_BODY_ID = 'studentsTableBody';

// --- CORE API HANDLER ---
async function handleApi(url, options = {}) {
    const AUTH_TOKEN = localStorage.getItem('erp-token');
    const ACTIVE_BRANCH_ID = localStorage.getItem('active_branch_id');
    const ACTIVE_SESSION_ID = localStorage.getItem('active_session_id');

    options.method = options.method || 'GET';
    
    if (options.body && typeof options.body === 'object' && !options.headers?.['Content-Type']) {
        options.body = JSON.stringify(options.body);
    }

    options.headers = { 
        ...options.headers,
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'active-branch-id': ACTIVE_BRANCH_ID,
        'active-session-id': ACTIVE_SESSION_ID
    };
    
    if (options.method === 'GET') {
        delete options.headers['Content-Type'];
    }

    const response = await fetch(url, options);

    if (response.status === 401 || response.status === 403) {
        console.error('API Unauthorized:', url);
        throw new Error('Unauthorized. Please re-login.');
    }
    
    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Server error: ${response.status}. ${errorText}`);
    }
    
    return response;
}

// --- INITIALIZATION ---

async function initializeStudentList() {
    const token = localStorage.getItem('erp-token');
    if (!token) {
        document.getElementById('loadingMessage').style.display = 'none';
        document.getElementById('errorMessage').textContent = 'Please log in to view students.';
        document.getElementById('errorMessage').style.display = 'block';
        return;
    }
    
    fetchStudentList();
}

// --- MAIN FETCH FUNCTION ---

async function fetchStudentList() {
    const loadingMessage = document.getElementById('loadingMessage');
    const errorMessage = document.getElementById('errorMessage');
    const tableBody = document.getElementById(TABLE_BODY_ID);
    const noStudentsMessage = document.getElementById('noStudentsMessage');

    // UI Reset
    loadingMessage.style.display = 'block';
    errorMessage.style.display = 'none';
    noStudentsMessage.style.display = 'none';
    tableBody.innerHTML = ''; 

    try {
        const response = await handleApi(API_ENDPOINT); 
        const studentList = await response.json();
        
        loadingMessage.style.display = 'none';

        if (studentList.length === 0) {
            noStudentsMessage.style.display = 'block';
        } else {
            renderStudentTable(studentList);
        }

    } catch (error) {
        console.error('Fetch Error:', error);
        loadingMessage.style.display = 'none';
        errorMessage.textContent = `Failed to load list: ${error.message}`;
        errorMessage.style.display = 'block';
    }
}

// --- RENDER FUNCTION ---

function renderStudentTable(students) {
    const tableBody = document.getElementById(TABLE_BODY_ID);
    const template = document.getElementById('studentRowTemplate');
    tableBody.innerHTML = ''; 

    students.forEach(student => {
        const row = document.importNode(template.content, true).querySelector('tr');
        
        row.dataset.studentId = student.student_id; 

        // 1. Enrollment No
        row.querySelector('[data-field="enrollment_no"]').textContent = student.enrollment_no || 'N/A';
        
        // 2. Name & Link
        const fullName = `${student.first_name || ''} ${student.last_name || ''}`.trim();
        const viewLink = row.querySelector('.view-link');
        viewLink.textContent = fullName || 'Unnamed';
        viewLink.href = `/view-student.html?id=${student.student_id}`; 

        // 3. Admission ID
        row.querySelector('[data-field="admission_id"]').textContent = student.admission_id || 'N/A';
        
        // 4. Course / Batch
        const course = student.course_name || 'N/A';
        const batch = student.batch_name || 'N/A';
        row.querySelector('[data-field="course_batch"]').textContent = `${course} / ${batch}`;
        
        // 5. Subject (Directly from Server)
        // No more async loading! The server sent this data already.
        row.querySelector('[data-field="subject"]').textContent = student.subject || 'N/A';

        // 6. Fees Structure (Directly from Server)
        const feeAmount = student.fees_structure 
            ? `₹${parseFloat(student.fees_structure).toFixed(2)}` 
            : 'N/A';
        row.querySelector('[data-field="fees_structure"]').textContent = feeAmount;
        
        // 7. Contact Info
        row.querySelector('[data-field="email"]').textContent = student.email || 'N/A';
        row.querySelector('[data-field="phone_number"]').textContent = student.phone_number || 'N/A';
        
        // 8. Actions
        row.querySelector('.edit-link').href = `/edit-student.html?id=${student.student_id}`;
        row.querySelector('.delete-btn').addEventListener('click', () => {
            handleDeleteStudent(student.student_id, fullName);
        });

        tableBody.appendChild(row);
    });
}

// --- DELETE HANDLER ---

async function handleDeleteStudent(studentId, fullName) {
    if (!confirm(`Are you sure you want to delete ${fullName}?`)) {
        return;
    }

    try {
        await handleApi(`${API_ENDPOINT}/${studentId}`, { method: 'DELETE' });
        alert(`${fullName} has been deactivated.`);
        fetchStudentList(); // Refresh list

    } catch (error) {
        alert(`Deletion failed: ${error.message}`);
    }
}