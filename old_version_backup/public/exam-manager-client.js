/**
 * exam-manager-client.js
 * -----------------------
 * This script manages the frontend logic for the Exam & Marksheet Management page.
 * It handles authentication, dynamic data loading, and CRUD operations for Exams, 
 * Schedules, and Marks Entry.
 * * * CRITICAL FIX: The marksheet API endpoint is updated to '/api/transcript/:studentId' 
 * to resolve persistent routing conflicts and 500 errors.
 */

// --- Grade Calculation Function ---
function calculateGrade(percent) {
    if (percent >= 90) return 'A+';
    if (percent >= 80) return 'A';
    if (percent >= 70) return 'B+';
    if (percent >= 60) return 'B';
    if (percent >= 50) return 'C';
    if (percent >= 40) return 'D';
    return 'F';
}

// --- Global Constants ---
const MARKS_API_URL = '/api/marks';
const API_URL = '/api/exams';
const ACADEMICS_API_URL = '/api/academicswithfees';
const STUDENTS_API_URL = '/api/students';

// --- Helper Functions ---

/**
 * A wrapper for the fetch API that includes the authentication token in headers.
 */
async function fetchWithAuth(url, options = {}) {
    const token = localStorage.getItem('erp-token');
    if (!token) {
        alert('Authentication token not found. Redirecting to login.');
        window.location.href = '/login.html';
        throw new Error('No authentication token found.');
    }
    
    // Retrieve latest necessary data
    const sessionId = localStorage.getItem('active_session_id');
    const authHeaders = { 
        'Authorization': `Bearer ${token}`,
        'X-Session-ID': sessionId,
        'Content-Type': 'application/json'
    };

    const headers = { ...authHeaders, ...options.headers };
    const response = await fetch(url, { ...options, headers });

    // 🚨 DEBUG FIX: The automatic logout is TEMPORARILY DISABLED here to diagnose
    // the source of the persistent logout issue (401/403 errors).
    if (response.status === 401 || response.status === 403) {
        // localStorage.removeItem('erp-token'); 
        // window.location.href = '/login.html'; 
        console.error('API Call Unauthorized (401/403). Token expired or invalid.');
        throw new Error('Unauthorized Access. Please log out and log in again.');
    }

    if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ message: 'Server error with no body.' }));
        throw new Error(`Failed to fetch: ${errorBody.message}`);
    }

    return response.json();
}

/**
 * 🚀 CRITICAL EXPORTED FUNCTION FOR TRANSCRIPT VIEWING
 * Fetches the student's consolidated marksheet data using their student ID (UUID).
 * @param {string} studentId The student's UUID.
 */
window.viewMarksheet = async (studentId) => {
    if (!studentId) {
        console.error('Marksheet generation failed: Student ID is missing.');
        return false;
    }
    
    // 1. Fetch Consolidated Marksheet Data
    // 🚨 FINAL ROUTE FIX: Changed to the isolated /api/transcript route to avoid conflicts
    const apiEndpoint = `/api/transcript/${studentId}`; 

    try {
        const marksheetData = await fetchWithAuth(apiEndpoint);

        if (!marksheetData || !marksheetData.results || marksheetData.results.length === 0) {
            alert("No consolidated marksheet data found for this student.");
            return false;
        }

        // 2. Construct HTML for the Print Window
        const printWindow = window.open('', '_blank');
        printWindow.document.write('<html><head><title>Academic Transcript</title>');
        printWindow.document.write('<style>');
        printWindow.document.write(`
            body { font-family: Arial, sans-serif; margin: 20px; font-size: 10pt; }
            .header { text-align: center; margin-bottom: 20px; }
            .header h1 { color: #000080; margin: 0; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            th, td { border: 1px solid #000; padding: 8px; text-align: left; }
            th { background-color: #f2f2f2; }
            .summary { margin-top: 20px; font-weight: bold; }
            @media print {
                .summary { page-break-before: always; }
            }
        `);
        printWindow.document.write('</style></head><body>');
        
        // --- Render Content ---
        
        const studentInfo = marksheetData.student_info || {};
        printWindow.document.write('<div class="header">');
        printWindow.document.write(`<h1>Official Academic Transcript</h1>`);
        printWindow.document.write(`<h2>Student Name: ${studentInfo.student_name || 'N/A'}</h2>`);
        printWindow.document.write(`<h3>ID/Roll: ${studentInfo.roll_number || studentInfo.student_id} | Course: ${studentInfo.course_name || 'N/A'}</h3>`);
        printWindow.document.write('</div>');

        // Marks Table 
        printWindow.document.write('<table>');
        printWindow.document.write('<tr><th>Exam/Assessment</th><th>Subject</th><th>Max Marks</th><th>Marks Obtained</th><th>Percentage</th><th>Grade</th></tr>');
        
        const results = marksheetData.results || [];
        results.forEach(result => {
             const percentage = (result.total_marks > 0) ? (result.marks_obtained / result.total_marks) * 100 : 0;
             const grade = calculateGrade(percentage);

             printWindow.document.write(`
                 <tr>
                     <td>${result.exam_name}</td>
                     <td>${result.subject_name}</td>
                     <td>${result.total_marks}</td>
                     <td>${result.marks_obtained}</td>
                     <td>${percentage.toFixed(2)}%</td>
                     <td>${grade}</td>
                 </tr>
             `);
        });

        printWindow.document.write('</table>');
        
        printWindow.document.write('<div class="summary">Consolidated Marksheet View (Data presented as received from server)</div>');
        
        // --- Finalize and Print ---
        printWindow.document.write('</body></html>');
        printWindow.document.close();
        
        printWindow.onload = () => {
             printWindow.focus();
             printWindow.print();
        };

        return true;

    } catch (error) {
        console.error('Error generating marksheet:', error);
        alert(`Failed to generate transcript: ${error.message}`);
        return false;
    }
};


document.addEventListener('DOMContentLoaded', () => {
    // --- Global Configuration ---
    const token = localStorage.getItem('erp-token');
    
    // --- DOM Element Selectors ---
    const usernameDisplay = document.getElementById('username-display');
    const logoutLink = document.getElementById('logout-link');

    // --- Main Exam Manager DOM Elements (Only for Admin Page) ---
    const courseIdSelect = document.getElementById('course_code'); 
    const batchIdSelect = document.getElementById('batch_code');
    const examsTableBody = document.getElementById('exams-table-body'); 
    
    const scheduleExamSelect = document.getElementById('schedule_exam_select');
    const marksExamSelect = document.getElementById('marks_exam_select');


    // --- User Info & Logout ---
    function setupUserInterface() {
        const username = localStorage.getItem('username');
        if (username && usernameDisplay) {
            usernameDisplay.textContent = username;
        }

        if (logoutLink) {
            logoutLink.addEventListener('click', (e) => {
                e.preventDefault();
                localStorage.clear();
                window.location.href = '/login.html';
            });
        }
    }
    
    // --- Data Loading Functions ---

    async function loadFormDependencies() {
        if (!courseIdSelect || !batchIdSelect) return; 

        try {
            const courses = await fetchWithAuth(`${ACADEMICS_API_URL}/courses`);
            
            courseIdSelect.innerHTML = '<option value="">-- Select Course --</option>';
            courses.forEach(course => {
                const option = document.createElement('option');
                option.value = course.course_id;
                option.textContent = `${course.course_name} (${course.course_code})`;
                courseIdSelect.appendChild(option);
            });
            
            batchIdSelect.innerHTML = '<option value="">-- Select Batch --</option>';

        } catch (error) {
            console.error('Error loading form dependencies:', error);
        }
    }
    
    async function loadSubjectsForCourse(courseId, subjectSelectElement) {
        subjectSelectElement.innerHTML = '<option value="">-- Select Subject --</option>';
        subjectSelectElement.disabled = true;
        if (!courseId) return;

        try {
            const response = await fetchWithAuth(`${ACADEMICS_API_URL}/courses/${courseId}/subjects`);
            const subjects = response; 

            subjects.forEach(subject => {
                const option = document.createElement('option');
                option.value = subject.subject_id || subject.id;
                option.textContent = `${subject.subject_name || subject.name} (${subject.subject_code || ''})`;
                option.dataset.subjectCode = subject.subject_code; 
                subjectSelectElement.appendChild(option);
            });
            subjectSelectElement.disabled = false;
        } catch (error) {
            console.error('Error loading subjects:', error);
            subjectSelectElement.innerHTML = '<option value="">Error loading subjects</option>';
        }
    }


    async function loadExams() {
        if (!examsTableBody) return; 

        try {
            const exams = await fetchWithAuth(`${API_URL}/list`);
            
            if (examsTableBody) {
                examsTableBody.dataset.exams = JSON.stringify(exams); 
                loadExamsTable(exams); 
            }

            if (scheduleExamSelect) scheduleExamSelect.innerHTML = '<option value="">-- Select Exam --</option>';
            if (marksExamSelect) marksExamSelect.innerHTML = '<option value="">-- Select Exam --</option>';
            
            exams.forEach(exam => {
                const option = document.createElement('option');
                option.value = exam.exam_id;
                option.textContent = `${exam.exam_name} (${exam.course_name || 'N/A'} - ${exam.batch_name || 'N/A'})`;
                
                option.dataset.courseId = exam.course_id; 
                option.dataset.batchId = exam.batch_id;
                option.dataset.totalMarks = exam.total_marks || 0; 
                
                if (scheduleExamSelect) scheduleExamSelect.appendChild(option.cloneNode(true));
                if (marksExamSelect) marksExamSelect.appendChild(option.cloneNode(true));
            });
        } catch (error) {
            console.error('Error loading exams:', error);
        }
    }


    // --- Exam CRUD Functions ---
    
    function loadExamsTable(exams) {
        if (!examsTableBody) return;
        examsTableBody.innerHTML = '';
        if (exams.length === 0) {
             examsTableBody.innerHTML = '<tr><td colspan="6">No exams created yet.</td></tr>';
             return;
        }
        
        exams.forEach(exam => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${exam.exam_name}</td>
                <td>${exam.course_name || 'N/A'}</td>
                <td>${exam.batch_name || 'N/A'}</td>
                <td>${exam.total_marks || 'N/A'}</td> 
                <td>${new Date(exam.exam_date).toLocaleDateString('en-IN')}</td>
                <td class="actions">
                    <button class="edit-exam-btn" data-exam-id="${exam.exam_id}">Edit</button>
                    <button class="cancel delete-exam-btn" data-exam-id="${exam.exam_id}">Delete</button>
                    <button class="view-schedule-btn" data-exam-id="${exam.exam_id}">Schedule</button>
                </td>
            `;
            examsTableBody.appendChild(row);
        });
    }

    // --- Marksheet Status Function ---

    async function loadMarksheetStatus() {
        const marksheetStatusBody = document.getElementById('marksheet-status-body'); 
        if (!marksheetStatusBody) return;
        
        marksheetStatusBody.innerHTML = '<tr><td colspan="6">Loading marksheet status...</td></tr>';
        
        try {
            const statusData = await fetchWithAuth(`${MARKS_API_URL}/status`); 
            
            marksheetStatusBody.innerHTML = '';
            
            if (statusData.length === 0) {
                marksheetStatusBody.innerHTML = '<tr><td colspan="6">No marksheets have been generated yet.</td></tr>';
                return;
            }

            statusData.forEach(item => {
                const msStatus = item.marksheet_status || 'Pending';
                const certStatus = item.certificate_status || 'Pending';
                const msColor = msStatus === 'Generated' ? 'green' : '#C16744';
                const certColor = certStatus === 'Issued' ? 'green' : 'gray';

                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${item.enrollment_no || item.roll_number || 'N/A'}</td>
                    <td>${item.student_name || 'N/A'}</td>
                    <td>${item.course_name || 'N/A'}</td>
                    <td><span style="font-weight: 600; color: ${msColor};">${msStatus}</span></td>
                    <td><span style="color: ${certColor};">${certStatus}</span></td>
                    <td class="actions">
                        <button class="view-marksheet-btn" data-roll-no="${item.enrollment_no || item.roll_number}">View</button>
                    </td>
                `;
                marksheetStatusBody.appendChild(row);
            });

        } catch (error) {
            console.error('Error loading marksheet status:', error);
            marksheetStatusBody.innerHTML = '<tr><td colspan="6">Error loading marksheet status.</td></tr>';
        }
    }


    // --- Event Listeners and Initialization ---
    
    // Batch loading listener 
    if (courseIdSelect) { 
        courseIdSelect.addEventListener('change', async () => {
            const batchIdSelectElement = document.getElementById('batch_code'); 
            const courseId = courseIdSelect.value;
            batchIdSelectElement.innerHTML = '<option value="">Loading batches...</option>';
            batchIdSelectElement.disabled = true;

            if (!courseId) {
                batchIdSelectElement.innerHTML = '<option value="">-- Select Batch --</option>';
                return;
            }

            try {
                const batches = await fetchWithAuth(`${ACADEMICS_API_URL}/courses/${courseId}/batches`);
                batchIdSelectElement.innerHTML = '<option value="">-- Select Batch --</option>';
                batches.forEach(b => {
                    batchIdSelectElement.innerHTML += `<option value="${b.batch_id}">${b.batch_name}</option>`;
                });
                batchIdSelectElement.disabled = false;
            } catch (err) {
                batchIdSelectElement.innerHTML = '<option value="">Error loading batches</option>';
            }
        });
    }

    // Final Initialization Call
    function initializePage() {
        setupUserInterface();
        loadFormDependencies();
        loadExams();
        loadMarksheetStatus(); 
    }
    
    // Check if the page is the main manager page (i.e., has exams-table-body)
    if (document.getElementById('exams-table-body')) {
        initializePage();
    }
});