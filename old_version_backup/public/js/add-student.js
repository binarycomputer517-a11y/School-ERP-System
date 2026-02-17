// File: public/js/add-student.js (This replaces the <script> block in add-student.html)
/**
 * File: public/js/add-student.js
 * Description: Client-side logic for the add-student.html form.
 * Handles dynamic course/batch loading, fee/subject display, and form submission.
 */

document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('erp-token');
    
    if (!token) {
        window.location.href = '/login';
        return;
    }
    
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
    };

    // --- DOM ELEMENTS ---
    const courseSelect = document.getElementById('course_id');
    const batchSelect = document.getElementById('batch_id');
    const feeDisplaySection = document.getElementById('fee-display-section');
    const feeDetailsContent = document.getElementById('fee-details-content');
    const subjectDisplaySection = document.getElementById('subject-display-section');
    const subjectDetailsContent = document.getElementById('subject-details-content');
    
    const sessionInput = document.getElementById('academic_session_id');
    const branchInput = document.getElementById('branch_id');
    const submitButton = document.getElementById('submit-button');


    // --- FEE CALCULATION HELPER ---
    function calculateTotalFee(structure) {
        const admission = parseFloat(structure.admission_fee) || 0;
        const registration = parseFloat(structure.registration_fee) || 0;
        const examination = parseFloat(structure.examination_fee) || 0;
        const duration = parseInt(structure.course_duration_months) || 1; 
        
        // Check if student requested transport/hostel before applying fee
        const transportRequested = document.getElementById('transport_required').value === 'true';
        const hostelRequested = document.getElementById('hostel_required').value === 'true';
        
        const transport = (structure.has_transport && transportRequested) ? (parseFloat(structure.transport_fee) || 0) * duration : 0;
        const hostel = (structure.has_hostel && hostelRequested) ? (parseFloat(structure.hostel_fee) || 0) * duration : 0;
        
        const total = admission + registration + examination + transport + hostel;
        
        return {
            total: total.toFixed(2),
            admission, registration, examination, transport, hostel, duration,
            transportApplied: (structure.has_transport && transportRequested),
            hostelApplied: (structure.has_hostel && hostelRequested)
        };
    }


    // --- 1. SUBJECTS LOGIC ---
    async function displaySubjects(courseId) {
        subjectDisplaySection.style.display = 'block';
        subjectDetailsContent.innerHTML = '<p id="subject-status">Loading subjects for course...</p>';

        if (!courseId) {
            subjectDetailsContent.innerHTML = '<p id="subject-status">Select a Course to view subjects.</p>';
            return;
        }

        try {
            const response = await fetch(`/api/academicswithfees/courses/${courseId}/subjects`, { headers });
            if (!response.ok) throw new Error('Failed to load assigned subjects');

            const subjects = await response.json();

            if (subjects.length === 0) {
                subjectDetailsContent.innerHTML = '<p id="subject-status" style="color:orange;">No subjects assigned to this course yet.</p>';
                return;
            }

            // Render the table
            let tableHtml = `
                <table class="table table-striped table-sm" id="subject-table">
                    <thead>
                        <tr><th>Code</th><th>Subject Name</th><th>Status</th></tr>
                    </thead>
                    <tbody>
            `;
            subjects.forEach(s => {
                tableHtml += `
                    <tr>
                        <td>${s.subject_code || 'N/A'}</td>
                        <td>${s.subject_name || 'N/A'}</td>
                        <td style="color:green;">Assigned</td>
                    </tr>
                `;
            });
            tableHtml += `</tbody></table>`;
            subjectDetailsContent.innerHTML = tableHtml;

        } catch (err) {
            console.error('Subject Display Error:', err);
            subjectDetailsContent.innerHTML = `<p id="subject-status" style="color:red;">Error loading subjects: ${err.message}</p>`;
        }
    }


    // --- 2. FEE STRUCTURE LOGIC ---
    async function displayFeeStructure(courseId, batchId) {
        feeDisplaySection.style.display = 'block';
        feeDetailsContent.innerHTML = '<p id="fee-status">Searching for fee structure...</p>';
        
        if (!courseId || !batchId) {
            feeDetailsContent.innerHTML = '<p id="fee-status">Please select both a Course and a Batch.</p>';
            return;
        }

        try {
            // Assumes /api/academicswithfees/fees/structures endpoint exists
            const response = await fetch('/api/academicswithfees/fees/structures', { headers });
            if (!response.ok) throw new Error('Failed to load fee structures');

            const structures = await response.json();
            
            // Find the specific structure matching the selected course and batch
            const matchedStructure = structures.find(s => 
                s.course_id === courseId && s.batch_id === batchId
            );

            if (!matchedStructure) {
                feeDetailsContent.innerHTML = `
                    <p id="fee-status" style="color:red;">
                        ❌ No Fee Structure found for this Course and Batch. 
                    </p>
                `;
                return;
            }

            const fees = calculateTotalFee(matchedStructure);
            
            // Render the details
            feeDetailsContent.innerHTML = `
                <ul id="fee-details-list">
                    <li><span>Duration:</span> <span>${fees.duration} Months</span></li>
                    <hr class="my-1">
                    <li><span>Admission Fee:</span> <span>₹${fees.admission.toFixed(2)}</span></li>
                    <li><span>Registration Fee:</span> <span>₹${fees.registration.toFixed(2)}</span></li>
                    <li><span>Examination Fee:</span> <span>₹${fees.examination.toFixed(2)}</span></li>
                    ${fees.transportApplied ? `
                        <li><span>Transport Fee (Total):</span> <span>₹${fees.transport.toFixed(2)}</span></li>
                    ` : (matchedStructure.has_transport ? `<li class="text-muted small">Transport available, but not requested.</li>` : '')}
                    ${fees.hostelApplied ? `
                        <li><span>Hostel Fee (Total):</span> <span>₹${fees.hostel.toFixed(2)}</span></li>
                    ` : (matchedStructure.has_hostel ? `<li class="text-muted small">Hostel available, but not requested.</li>` : '')}
                    <li class="fee-total"><span>TOTAL FEE:</span> <span>₹${fees.total}</span></li>
                </ul>
                <p class="text-muted small mt-2 mb-0">Total fee includes requested transport/hostel costs for the full ${fees.duration} months.</p>
            `;

        } catch (err) {
            console.error('Fee Structure Display Error:', err);
            feeDetailsContent.innerHTML = `<p id="fee-status" style="color:red;">Error loading fees: ${err.message}</p>`;
        }
    }
    
    // --- COURSE & BATCH LOAD LOGIC ---

    // ১. পেজ লোড হলে কোর্সগুলি আনুন
    async function loadCourses() {
        try {
            const response = await fetch('/api/academicswithfees/courses', { headers });
            if (!response.ok) throw new Error('Failed to load courses');
            
            const courses = await response.json();
            
            courses.forEach(course => {
                const option = new Option(course.course_name, course.course_id);
                courseSelect.add(option);
            });
        } catch (err) {
            console.error(err);
            alert(err.message);
        }
    }

    // ২. Function to load active IDs
    async function loadActiveIds() {
        try {
            const activeSession = localStorage.getItem('active_session_id');
            const activeBranch = localStorage.getItem('active_branch_id');

            if (!activeSession || !activeBranch) {
                 throw new Error('Active session/branch not found in local storage.');
            }
            
            sessionInput.value = activeSession;
            branchInput.value = activeBranch;

        } catch (err) {
            console.error(err);
            alert(`CRITICAL ERROR: ${err.message}. Cannot add students. Please contact admin.`);
            submitButton.disabled = true;
            submitButton.textContent = 'Error: Configuration Missing';
        }
    }


    // ৩. কোর্স পরিবর্তন হলে ব্যাচগুলি আনুন, সাবজেক্ট ও ফি স্ট্রাকচার আপডেট করুন
    courseSelect.addEventListener('change', async () => {
        const courseId = courseSelect.value;
        // প্রথমে ব্যাচ ড্রপডাউন রিসেট করুন
        batchSelect.innerHTML = '<option value="">-- Loading... --</option>';
        batchSelect.disabled = true;

        // Immediately update subject display
        await displaySubjects(courseId);

        // Immediately clear fee details
        feeDetailsContent.innerHTML = '<p id="fee-status">Searching for batch...</p>';
        
        if (!courseId) {
            batchSelect.innerHTML = '<option value="">-- Select Course First --</option>';
            feeDisplaySection.style.display = 'none';
            return;
        }

        try {
            const response = await fetch(`/api/academicswithfees/courses/${courseId}/batches`, { headers });
            if (!response.ok) throw new Error('Failed to load batches');

            const batches = await response.json();
            
            batchSelect.innerHTML = '<option value="">-- Select Batch --</option>';
            batches.forEach(batch => {
                const option = new Option(batch.batch_name, batch.batch_id);
                batchSelect.add(option);
            });
            batchSelect.disabled = false;
            
            // ⚠️ IMPORTANT: Load Fee Structure only if a batch is already selected 
            const currentBatchId = batchSelect.value;
            if (currentBatchId) {
                await displayFeeStructure(courseId, currentBatchId);
            } else {
                feeDetailsContent.innerHTML = '<p id="fee-status">Select a Batch to see fee details.</p>';
            }

        } catch (err) {
            console.error(err);
            alert(err.message);
            batchSelect.innerHTML = '<option value="">-- Error Loading --</option>';
        }
    });

    // ৪. ব্যাচ পরিবর্তন হলে ফি স্ট্রাকচার দেখান
    batchSelect.addEventListener('change', async () => {
        const courseId = courseSelect.value;
        const batchId = batchSelect.value;
        if (courseId && batchId) {
             await displayFeeStructure(courseId, batchId);
        } else {
             feeDetailsContent.innerHTML = '<p id="fee-status">Select a Course and Batch.</p>';
        }
    });

    // ⚠️ New Event Listener: Update fee structure when transport/hostel preference changes
    document.getElementById('transport_required').addEventListener('change', async () => {
        const courseId = courseSelect.value;
        const batchId = batchSelect.value;
        if (courseId && batchId) await displayFeeStructure(courseId, batchId);
    });
    document.getElementById('hostel_required').addEventListener('change', async () => {
        const courseId = courseSelect.value;
        const batchId = batchSelect.value;
        if (courseId && batchId) await displayFeeStructure(courseId, batchId);
    });


    // ৫. ফর্ম সাবমিট করা
    document.getElementById('add-student-form').addEventListener('submit', async function(event) {
        event.preventDefault();
        
        const form = event.target;
        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());

        // FIX: Ensure address field sends correct data 
        data.permanent_address = data.address; // Map textarea content to DB column
        delete data.address; // Remove the UI field 'address'

        // FIX: Convert DOB format if needed (Backend expects 'dob')
        data.dob = data.dob || null; // Ensure we send null if empty

        // Convert transport/hostel to boolean
        data.transport_required = data.transport_required === 'true';
        data.hostel_required = data.hostel_required === 'true';

        // নিশ্চিত করুন যে হিডেন ফিল্ডে মান আছে
        if (!data.academic_session_id || !data.branch_id) {
            alert('Error: Academic Session ID or Branch ID is missing or invalid. Please check configuration.');
            return;
        }

        // --- Frontend Validation Check ---
        if (!data.username || !data.password || !data.email || !data.course_id || !data.batch_id) {
             alert('Please fill out all required fields (Username, Password, Email, Course, Batch).');
             return;
        }
        
        try {
            // API route changed to '/' since we are not using multipart form data here
            const response = await fetch('/api/students', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(data)
            });

            const result = await response.json();

            if (response.ok) {
                alert(`Success! Student created successfully. Enrollment No: ${result.enrollment_no}`);
                form.reset(); // ফর্ম রিসেট
                courseSelect.value = ''; // Ensure course reset triggers batch reset via change event
                batchSelect.innerHTML = '<option value="">-- Select Course First --</option>';
                batchSelect.disabled = true;
                feeDisplaySection.style.display = 'none'; // Hide fee details after submission
                subjectDisplaySection.style.display = 'none'; // Hide subject details
            } else {
                alert(`Error: ${result.message}`);
            }

        } catch (err) {
            console.error('Frontend Fetch Error:', err);
            alert('A network error occurred. Please check the console.');
        }
    });

    // পেজ লোড হলে দুটি ফাংশনই কল করুন
    loadCourses();
    loadActiveIds();
});