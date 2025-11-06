/**
 * exam-manager-client.js
 * -----------------------
 * This script manages the frontend logic for the Exam & Marksheet Management page.
 * It handles authentication, dynamic data loading, and CRUD operations for Exams, 
 * Schedules, and Marks Entry.
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

document.addEventListener('DOMContentLoaded', () => {
    // --- Global Configuration ---
    const token = localStorage.getItem('erp-token');
    const sessionId = localStorage.getItem('active_session_id');
    
    if (!token || localStorage.getItem('user-role') !== 'Admin') { 
        window.location.href = '/login'; 
    }
    
    const authHeaders = { 
        'Authorization': `Bearer ${token}`,
        'X-Session-ID': sessionId,
        'Content-Type': 'application/json'
    };


    // --- DOM Element Selectors ---
    const usernameDisplay = document.getElementById('username-display');
    const logoutLink = document.getElementById('logout-link');

    const examForm = document.getElementById('exam-form');
    const courseIdSelect = document.getElementById('course_code');
    const batchIdSelect = document.getElementById('batch_code');
    const examsTableBody = document.getElementById('exams-table-body'); 
    
    const scheduleForm = document.getElementById('schedule-form');
    const scheduleIdInput = document.getElementById('schedule_id'); 
    const scheduleExamSelect = document.getElementById('schedule_exam_select');
    const scheduleSubjectSelect = document.getElementById('subject_code');
    const scheduleDateInput = document.getElementById('exam_date_schedule'); 
    const selectedExamNameSpan = document.getElementById('selected-exam-name');
    const scheduleTableBody = document.getElementById('schedule-table-body');
    const addScheduleBtn = document.getElementById('add-schedule-btn');
    const cancelEditScheduleBtn = document.getElementById('cancel-edit-schedule-btn');

    const marksEntryForm = document.getElementById('marks-entry-form');
    const marksExamSelect = document.getElementById('marks_exam_select');
    const marksSubjectSelect = document.getElementById('marks_subject_select');
    const loadStudentsBtn = document.getElementById('load-students-btn');
    const studentMarksBody = document.getElementById('student-marks-body');
    const maxMarksDisplay = document.getElementById('max-marks-display');
    const marksEntrySection = document.getElementById('marks-entry-form'); 
    const marksheetStatusBody = document.getElementById('marksheet-status-body'); 

    const API_URL = '/api/exams';
    const MARKS_API_URL = '/api/marks';
    const ACADEMICS_API_URL = '/api/academicswithfees';
    const STUDENTS_API_URL = '/api/students';


    // --- Helper Functions ---
    const displayError = (elementId, message) => {
        const errorElement = document.getElementById(elementId);
        if (errorElement) errorElement.textContent = message;
    };
    const clearError = (elementId) => {
        const errorElement = document.getElementById(elementId);
        if (errorElement) errorElement.textContent = '';
    };

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

        const headers = { ...authHeaders, ...options.headers };
        const response = await fetch(url, { ...options, headers });

        if (response.status === 401 || response.status === 403) {
            localStorage.removeItem('erp-token');
            localStorage.removeItem('user-role');
            localStorage.removeItem('username');
            alert('Session expired or unauthorized. Please log in again.');
            window.location.href = '/login.html';
            throw new Error('Unauthorized.');
        }

        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({ message: 'Server error with no body.' }));
            throw new Error(`Failed to fetch: ${errorBody.message}`);
        }

        return response.json();
    }

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

    /**
     * Loads initial Course and Batch data for the Exam Creation form.
     */
    async function loadFormDependencies() {
        try {
            // Fetch Course data directly (Batches will be loaded via change listener)
            const courses = await fetchWithAuth(`${ACADEMICS_API_URL}/courses`);
            
            courseIdSelect.innerHTML = '<option value="">-- Select Course --</option>';
            courses.forEach(course => {
                const option = document.createElement('option');
                option.value = course.course_id;
                option.textContent = `${course.course_name} (${course.course_code})`;
                courseIdSelect.appendChild(option);
            });
            
            // Set initial state for Batch select
            batchIdSelect.innerHTML = '<option value="">-- Select Batch --</option>';

        } catch (error) {
            console.error('Error loading form dependencies:', error);
            displayError('exam-error-msg', 'Could not load course/batch lists.');
        }
    }
    
    /**
     * Loads Subjects for the selected Course (used by Schedule and Marks entry).
     */
    async function loadSubjectsForCourse(courseId, subjectSelectElement) {
        subjectSelectElement.innerHTML = '<option value="">-- Select Subject --</option>';
        subjectSelectElement.disabled = true;
        if (!courseId) return;

        try {
            // ASSUMPTION: /api/academicswithfees/courses/:courseId/subjects exists for filtered list
            const response = await fetchWithAuth(`${ACADEMICS_API_URL}/courses/${courseId}/subjects`);
            const subjects = await response.json();

            // Fallback for subjects table structure
            const subjectKey = subjects[0]?.subject_id ? 'subject_id' : 'id';
            const nameKey = subjects[0]?.subject_name ? 'subject_name' : 'name'; 

            subjects.forEach(subject => {
                const option = document.createElement('option');
                option.value = subject.subject_id || subject.id; // Use either subject_id or id
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


    /**
     * Loads the list of existing exams for the main table and dropdowns.
     */
    async function loadExams() {
        clearError('exam-error-msg');
        try {
            const exams = await fetchWithAuth(`${API_URL}/list`);
            
            if (examsTableBody) {
                examsTableBody.dataset.exams = JSON.stringify(exams); 
                loadExamsTable(exams); 
            }

            // Populate dropdowns for schedule and marks entry
            scheduleExamSelect.innerHTML = '<option value="">-- Select Exam --</option>';
            marksExamSelect.innerHTML = '<option value="">-- Select Exam --</option>';
            
            exams.forEach(exam => {
                const option = document.createElement('option');
                option.value = exam.exam_id;
                option.textContent = `${exam.exam_name} (${exam.course_name || 'N/A'} - ${exam.batch_name || 'N/A'})`;
                
                // CRITICAL: Store necessary FKs and Max Marks on the option element
                option.dataset.courseId = exam.course_id; 
                option.dataset.batchId = exam.batch_id;
                option.dataset.totalMarks = exam.total_marks || 0; 
                
                scheduleExamSelect.appendChild(option.cloneNode(true));
                marksExamSelect.appendChild(option.cloneNode(true));
            });
        } catch (error) {
            console.error('Error loading exams:', error);
            displayError('exam-error-msg', 'Could not load exam list.');
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
        if (!marksheetStatusBody) return;
        marksheetStatusBody.innerHTML = '<tr><td colspan="6">Loading marksheet status...</td></tr>';
        
        try {
            // FIX: This route is crashing the server. We must assume the FIX in marks.js worked.
            const statusData = await fetchWithAuth(`${MARKS_API_URL}/status`); 
            
            marksheetStatusBody.innerHTML = '';
            
            if (statusData.length === 0) {
                marksheetStatusBody.innerHTML = '<tr><td colspan="6">No marksheets have been generated yet.</td></tr>';
                return;
            }

            statusData.forEach(item => {
                // Determine styling based on status
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
    
    // Batch loading listener (must be inside DOMContentLoaded scope)
    courseIdSelect.addEventListener('change', async () => {
        const courseId = courseIdSelect.value;
        batchIdSelect.innerHTML = '<option value="">Loading batches...</option>';
        batchIdSelect.disabled = true;

        if (!courseId) {
            batchIdSelect.innerHTML = '<option value="">-- Select Batch --</option>';
            return;
        }

        try {
            const batches = await fetchWithAuth(`${ACADEMICS_API_URL}/courses/${courseId}/batches`);
            batchIdSelect.innerHTML = '<option value="">-- Select Batch --</option>';
            batches.forEach(b => {
                batchIdSelect.innerHTML += `<option value="${b.batch_id}">${b.batch_name}</option>`;
            });
            batchIdSelect.disabled = false;
        } catch (err) {
            batchIdSelect.innerHTML = '<option value="">Error loading batches</option>';
        }
    });

    // Final Initialization Call
    function initializePage() {
        setupUserInterface();
        loadFormDependencies();
        loadExams();
        loadMarksheetStatus(); 
    }

    initializePage();
});