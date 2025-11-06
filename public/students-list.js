// public/students-list.js

document.addEventListener('DOMContentLoaded', initializeStudentList);

const API_ENDPOINT = '/api/students';
const ACADEMICS_API = '/api/academicswithfees';
const FEES_API = `${ACADEMICS_API}/fees/structures`; // Dedicated API for fee structures
const TABLE_BODY_ID = 'studentsTableBody';
const AUTH_TOKEN = localStorage.getItem('erp-token');

// Global cache for academic data:
let academicDataCache = {
    courses: new Map(), 
    feeStructures: new Map() // NEW CACHE for fee structures
};

// --- CORE API HANDLER (kept intact) ---
async function handleApi(url, options = {}) {
    options.headers = { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${AUTH_TOKEN}` 
    };
    const response = await fetch(url, options);
    if (response.status === 401 || response.status === 403) {
        console.error('API Unauthorized or Forbidden:', url);
        throw new Error('Unauthorized or Forbidden access.');
    }
    return response;
}

// --- DATA CACHING & FETCHING FUNCTIONS (Updated) ---

async function loadAcademicData() {
    try {
        const response = await handleApi(`${ACADEMICS_API}/courses`);
        const courses = await response.json();
        
        courses.forEach(c => {
            const id = c.id || c.course_id;
            if (id) {
                academicDataCache.courses.set(id, {
                    name: `${c.course_name} (${c.course_code})`,
                    subjects: null 
                });
            }
        });
    } catch (err) {
        console.error('Failed to load academic data for lookup:', err);
    }
}

/**
 * Fetches subjects for a specific course and returns a summary HTML string.
 * (Logic kept intact)
 */
async function getSubjectsSummary(courseId) {
    if (!courseId) return 'N/A';
    
    let courseEntry = academicDataCache.courses.get(courseId);
    if (courseEntry && courseEntry.subjects) {
        return formatSubjectsHtml(courseEntry.subjects);
    }

    try {
        const response = await handleApi(`${ACADEMICS_API}/courses/${courseId}/subjects`);
        const subjects = await response.json();

        if (Array.isArray(subjects) && subjects.length > 0) {
            if (courseEntry) {
                courseEntry.subjects = subjects;
            } else {
                 academicDataCache.courses.set(courseId, { name: 'Course Data Missing', subjects: subjects });
            }
            return formatSubjectsHtml(subjects);
        }
        return 'No Subjects';

    } catch (error) {
        console.error(`Failed to fetch subjects for course ${courseId}:`, error);
        return 'Error Loading Subjects';
    }
}

/**
 * Creates formatted HTML for displaying a list of subjects.
 * (Logic kept intact)
 */
function formatSubjectsHtml(subjects) {
    if (!Array.isArray(subjects) || subjects.length === 0) {
        return 'No Subjects';
    }
    const limit = 3;
    let html = '<ul style="list-style: none; padding-left: 0;">';
    
    subjects.slice(0, limit).forEach(s => {
        html += `<li style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px;" title="${s.subject_name}">${s.subject_code || 'N/C'}</li>`;
    });
    
    if (subjects.length > limit) {
        html += `<li>...and ${subjects.length - limit} more</li>`;
    }
    html += '</ul>';
    return html;
}

/**
 * NEW: Fetches fee structure details based on fees_structure_id.
 * @param {string} feesStructureId The ID of the fee structure.
 * @returns {Promise<string>} HTML string summarizing fee details.
 */
async function getFeeStructureSummary(feesStructureId) {
    if (!feesStructureId) return 'Fees N/A';

    // 1. Check Cache
    if (academicDataCache.feeStructures.has(feesStructureId)) {
        return academicDataCache.feeStructures.get(feesStructureId);
    }

    // 2. Fetch from API
    try {
        // Assuming there is an endpoint like /api/academicswithfees/fees/structures/:id
        const response = await handleApi(`${FEES_API}/${feesStructureId}`);
        const structure = await response.json();
        
        // Use the existing helper function to calculate the total fee
        const totalFee = calculateTotalFee(structure);

        const summaryHtml = `
            <ul style="list-style: none; padding-left: 0; font-size: 0.9em;">
                <li>Total Est: <span style="font-weight: bold;">₹${totalFee}</span></li>
                <li>Admission: ₹${(structure.admission_fee || 0).toFixed(2)}</li>
                <li>Registration: ₹${(structure.registration_fee || 0).toFixed(2)}</li>
            </ul>
        `;

        // Cache the result (HTML string)
        academicDataCache.feeStructures.set(feesStructureId, summaryHtml);
        return summaryHtml;

    } catch (error) {
        console.error(`Failed to fetch fee structure ${feesStructureId}:`, error);
        return 'Error Loading Fees';
    }
}

/**
 * Calculates the total fee based on the structure object.
 * (Copied from add-student.js logic)
 */
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


// --- INITIALIZATION AND FETCHING (kept intact) ---

async function initializeStudentList() {
    if (!AUTH_TOKEN) {
        document.getElementById('loadingMessage').style.display = 'none';
        document.getElementById('errorMessage').textContent = 'Error: You are not authenticated. Please log in.';
        document.getElementById('errorMessage').style.display = 'block';
        return;
    }
    
    await loadAcademicData();
    fetchStudentList();
}

async function fetchStudentList() {
    const loadingMessage = document.getElementById('loadingMessage');
    const errorMessage = document.getElementById('errorMessage');
    const tableBody = document.getElementById(TABLE_BODY_ID);

    loadingMessage.style.display = 'block';
    errorMessage.style.display = 'none';
    tableBody.innerHTML = ''; 

    try {
        // ASSUMPTION: This endpoint returns student_id, course_id, batch_id, AND fees_structure_id
        const response = await fetch(API_ENDPOINT, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
        });

        if (response.ok) {
            const studentList = await response.json();
            
            loadingMessage.style.display = 'none';

            if (studentList.length === 0) {
                document.getElementById('noStudentsMessage').style.display = 'block';
            } else {
                renderStudentTable(studentList);
            }
        } else {
            throw new Error(`Server returned status ${response.status}: ${await response.text().substring(0, 100)}...`);
        }

    } catch (error) {
        console.error('Fetch Student List Error:', error);
        loadingMessage.style.display = 'none';
        errorMessage.textContent = `Failed to load student list. Reason: ${error.message}`;
        errorMessage.style.display = 'block';
    }
}

/**
 * Renders the fetched student data into the HTML table, including asynchronous lookups.
 * @param {Array<object>} students The list of student objects.
 */
function renderStudentTable(students) {
    const tableBody = document.getElementById(TABLE_BODY_ID);
    const template = document.getElementById('studentRowTemplate');
    tableBody.innerHTML = ''; 

    students.forEach(student => {
        const row = document.importNode(template.content, true).querySelector('tr');
        
        row.dataset.studentId = student.student_id; 

        // Populate common fields
        row.querySelector('[data-field="enrollment_no"]').textContent = student.enrollment_no || 'N/A';
        
        const fullName = `${student.first_name || ''} ${student.last_name || ''}`;
        const viewLink = row.querySelector('.view-link');
        viewLink.textContent = fullName;
        viewLink.href = `/view-student.html?id=${student.student_id}`; 

        row.querySelector('[data-field="admission_id"]').textContent = student.admission_id || 'N/A';
        
        // --- Course/Batch lookup ---
        const courseId = student.course_id;
        let courseEntry = academicDataCache.courses.get(courseId);
        let courseName = courseEntry ? courseEntry.name : (student.course_name || 'N/A');
        let batchName = student.batch_name || (student.batch_id ? `ID: ${student.batch_id}` : 'N/A');

        row.querySelector('[data-field="course_batch"]').textContent = `${courseName} / ${batchName}`;
        
        
        // --- Subject: ASYNCHRONOUSLY FETCH AND UPDATE ---
        const subjectCell = row.querySelector('[data-field="subject"]');
        if (subjectCell) {
            subjectCell.textContent = 'Loading...'; 
            getSubjectsSummary(courseId).then(html => {
                subjectCell.innerHTML = html;
            });
        }

        // --- Fees Structure: ASYNCHRONOUSLY FETCH AND UPDATE (NEW) ---
        const feesStructureId = student.fees_structure_id; // ASSUMED FIELD from API
        const feesCell = row.querySelector('[data-field="fees_structure"]');
        
        if (feesCell) {
            feesCell.textContent = feesStructureId ? 'Loading...' : 'N/A';

            if (feesStructureId) {
                getFeeStructureSummary(feesStructureId).then(html => {
                    feesCell.innerHTML = html;
                });
            }
        }
        
        row.querySelector('[data-field="email"]').textContent = student.email || 'N/A';
        row.querySelector('[data-field="phone_number"]').textContent = student.phone_number || 'N/A';
        
        // Set Edit Link
        row.querySelector('.edit-link').href = `/edit-student.html?id=${student.student_id}`;

        // Attach event listener for the Delete button
        row.querySelector('.delete-btn').addEventListener('click', () => {
            handleDeleteStudent(student.student_id, fullName);
        });

        tableBody.appendChild(row);
    });
}


/**
 * Handles the soft-delete process for a student record. (kept intact)
 */
async function handleDeleteStudent(studentId, fullName) {
    if (!confirm(`Are you sure you want to delete (deactivate) student: ${fullName}? This action is usually irreversible.`)) {
        return;
    }

    const deleteEndpoint = `${API_ENDPOINT}/${studentId}`;

    try {
        const response = await fetch(deleteEndpoint, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${AUTH_TOKEN}` 
            }
        });

        if (response.ok) {
            alert(`${fullName} has been successfully deactivated.`);
            fetchStudentList(); // Refresh the table
        } else {
            const errorText = await response.text();
            alert(`Deletion failed: Server Status ${response.status}.`);
        }
    } catch (error) {
        console.error('Delete Network Error:', error);
        alert('A network error occurred during deletion.');
    }
}