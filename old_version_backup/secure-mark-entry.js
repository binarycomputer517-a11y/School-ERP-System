const API_BASE = '/api';
const TOKEN = localStorage.getItem('erp-token');

// Elements
const scheduleSelect = document.getElementById('schedule_id');
const examDetails = document.getElementById('exam-details');
const markEntryForm = document.getElementById('mark-entry-form');
const markEntryBody = document.getElementById('mark-entry-body');
const examTitleDisplay = document.getElementById('exam-title-display');
const formMessage = document.getElementById('form-message');

let allAssignedExams = [];
let maxMarks = 0;

// --- Data Fetching ---

async function fetchData(endpoint) {
    if (!TOKEN) throw new Error('Authentication token missing.');
    const response = await fetch(`${API_BASE}/${endpoint}`, {
        headers: { 'Authorization': `Bearer ${TOKEN}` }
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch ${endpoint}: HTTP Status ${response.status}`);
    }
    return response.json();
}

function populateSelect(selectElement, data, idKey, nameKey, placeholder) {
    selectElement.innerHTML = `<option value="">${placeholder}</option>`;
    data.forEach(item => {
        const option = document.createElement('option');
        option.value = item[idKey];
        option.textContent = item[nameKey];
        selectElement.appendChild(option);
    });
}

async function initializeData() {
    try {
        // Assume API returns exams assigned to the current logged-in teacher/admin
        allAssignedExams = await fetchData('mark-entry/my-assigned-schedules');
        populateSelect(scheduleSelect, allAssignedExams, 'schedule_id', 'exam_name', 'Select Exam Schedule');
    } catch (error) {
        formMessage.textContent = 'Error loading assigned exams: ' + error.message;
        formMessage.style.color = 'red';
    }
}

// --- Dynamic Mark Table Generation ---

scheduleSelect.addEventListener('change', async function() {
    const scheduleId = this.value;
    markEntryForm.style.display = 'none';
    markEntryBody.innerHTML = '';
    formMessage.textContent = '';
    examDetails.textContent = '';

    if (!scheduleId) return;

    const selectedExam = allAssignedExams.find(e => String(e.schedule_id) === scheduleId);
    if (!selectedExam) return;

    maxMarks = selectedExam.total_marks;
    examTitleDisplay.textContent = selectedExam.exam_name;
    examDetails.textContent = `Date: ${selectedExam.exam_date} | Subject: ${selectedExam.subject_name} | Max Marks: ${maxMarks}`;

    try {
        // API returns enrolled students ready for mark entry (Feature 4, linking exam_enrollment)
        const studentEnrollments = await fetchData(`mark-entry/enrollments/${scheduleId}`);
        
        if (studentEnrollments.length === 0) {
            statusMessage.textContent = 'No eligible students found for this exam or marks already entered.';
            return;
        }

        markEntryBody.innerHTML = studentEnrollments.map(enrollment => {
            // enrollment.marks_obtained may be null or a previous entry
            const existingMarks = enrollment.marks_obtained !== null ? enrollment.marks_obtained : '';
            return `
                <tr>
                    <td>${enrollment.student_id}</td>
                    <td>${enrollment.student_name}</td>
                    <td>${enrollment.hall_ticket_number}</td>
                    <td>${maxMarks}</td>
                    <td>
                        <input type="number" 
                               min="0" 
                               max="${maxMarks}" 
                               data-enrollment-id="${enrollment.enrollment_id}"
                               value="${existingMarks}"
                               required>
                    </td>
                </tr>
            `;
        }).join('');

        markEntryForm.style.display = 'block';

    } catch (error) {
        formMessage.textContent = `Error loading student list: ${error.message}`;
        formMessage.style.color = 'red';
    }
});

// --- Submission Handler ---

markEntryForm.addEventListener('submit', async function(event) {
    event.preventDefault();
    formMessage.textContent = 'Validating and saving marks...';
    formMessage.style.color = '#007bff';

    const markInputs = markEntryBody.querySelectorAll('input[type="number"]');
    const marksPayload = [];
    let isValid = true;

    markInputs.forEach(input => {
        const marks = parseFloat(input.value);
        const enrollmentId = parseInt(input.getAttribute('data-enrollment-id'));

        if (isNaN(marks) || marks < 0 || marks > maxMarks) {
            input.style.border = '2px solid red';
            isValid = false;
        } else {
            input.style.border = '1px solid #ccc';
            marksPayload.push({
                enrollment_id: enrollmentId,
                marks_obtained: marks
            });
        }
    });

    if (!isValid) {
        formMessage.textContent = 'Error: Please correct invalid marks (must be between 0 and Max Marks).';
        formMessage.style.color = 'red';
        return;
    }

    try {
        // API Endpoint for Mark Entry (Feature 11, bulk update on exam_results)
        const response = await fetch(`${API_BASE}/mark-entry/bulk-save/${scheduleSelect.value}`, {
            method: 'POST', // Use POST for bulk saving/updating
            headers: { 
                'Authorization': `Bearer ${TOKEN}`,
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify(marksPayload)
        });

        if (response.ok) {
            formMessage.textContent = `SUCCESS: All ${marksPayload.length} marks saved/updated securely!`;
            formMessage.style.color = 'green';
            // Trigger auto-calculation and moderation readiness check on the backend here
        } else {
            const errorText = await response.text();
            formMessage.textContent = `Error during save: ${errorText || 'Server error.'}`;
            formMessage.style.color = 'red';
        }
    } catch (error) {
        formMessage.textContent = `Network Error: ${error.message}`;
        formMessage.style.color = 'red';
    }
});

// Initialization
document.addEventListener('DOMContentLoaded', initializeData);