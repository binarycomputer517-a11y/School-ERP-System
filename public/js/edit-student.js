/**
 * File: public/js/edit-student.js
 * Description: Client-side logic for the student edit form.
 * Handles fetching existing student data, populating the form, dynamic academic info, and submitting updates.
 *
 * FIX: Correctly maps the HTML field 'date_of_birth' to the API field 'dob' during submission to prevent data loss.
 */

document.addEventListener('DOMContentLoaded', async () => {
    
    // --- AUTHENTICATION & SETUP ---
    const token = localStorage.getItem('erp-token');
    if (!token) {
        alert('Authentication Error: You must be logged in to edit data.');
        window.location.href = '/login.html'; 
        return;
    }
    const authHeaders = { 'Authorization': `Bearer ${token}` }; 

    const form = document.getElementById('editStudentForm');
    const courseSelect = document.getElementById('course_id');
    const batchSelect = document.getElementById('batch_id');
    const dynamicDataArea = document.getElementById('course_dynamic_data');

    // --- GET STUDENT ID FROM URL ---
    const urlParams = new URLSearchParams(window.location.search);
    const studentId = urlParams.get('id');
    
    // CRITICAL FIX: Ensure studentId is valid before proceeding
    if (!studentId || studentId === 'undefined') {
        alert('Error: Invalid or missing student ID in the URL. Redirecting to Student List.');
        window.location.href = '/view-student.html'; 
        return;
    }

    // --- API HELPER (for GET requests) ---
    async function handleApiGet(url) {
        try {
            const response = await fetch(url, { headers: authHeaders });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return response.json();
        } catch (error) {
            console.error('API GET Error:', error);
            alert(`Failed to load data: ${error.message}. Check server logs for exact DB error.`);
            return null;
        }
    }
    
    // ----------------------------------------------------------------------------------
    // 1. DATA LOADING & FORM POPULATION
    // ----------------------------------------------------------------------------------

    async function loadInitialCourses() {
        // NOTE: Assuming /api/academicswithfees/courses exists and returns {course_id, course_name, course_code}
        const courses = await handleApiGet('/api/academicswithfees/courses');
        if (courses && courseSelect) {
            courseSelect.innerHTML = '<option value="">Select Course...</option>'; 
            courses.forEach(course => {
                const option = document.createElement('option');
                option.value = course.course_id;
                option.textContent = `${course.course_name} (${course.course_code})`;
                courseSelect.appendChild(option);
            });
        }
    }

    async function loadAndPopulateStudentData() {
        const student = await handleApiGet(`/api/students/${studentId}`); 
        if (!student) {
            form.innerHTML = '<h3 class="text-danger text-center">Could not load student data or the student does not exist (Check API Status: 404/500).</h3>';
            return;
        }

        // --- Data Mapping & Population ---
        for (const key in student) {
            if (student.hasOwnProperty(key)) {
                const field = form.elements[key];
                if (field) {
                    if (field.type === 'checkbox') {
                        field.checked = !!student[key];
                    } else if (field.type === 'date' && student[key]) {
                        // Handle date fields, including the original 'dob' which is mapped to 'date_of_birth' in HTML
                        field.value = student[key].split('T')[0];
                    } else if (key === 'photo_url' || key === 'signature_path') {
                        // Handle file path display
                        const linkContainer = document.getElementById(`${key}_link`);
                        if (student[key] && linkContainer) {
                             linkContainer.innerHTML = `<a href="${student[key]}" target="_blank" class="current-file-link">View Current File</a>`;
                        }
                    } else if (key === 'student_user_id') {
                        // Map the aliased username from DB query
                        field.value = student.student_user_id || '';
                    } else if (key === 'address' && student.address) {
                        // Map the aliased 'address' (permanent_address from DB)
                        field.value = student.address;
                    } else {
                        field.value = student[key];
                    }
                }
            }
        }
        
        // --- Special Handling for DOB field name mismatch ---
        // Manually set the HTML field 'date_of_birth' using the DB value 'dob'
        const dobField = form.elements['date_of_birth']; 
        if (dobField && student.dob) {
            dobField.value = student.dob.split('T')[0]; 
        }

        // --- Roll Number Check (enrollment_no in DB) ---
        const rollNumberField = form.elements['roll_number'];
        if (rollNumberField && student.enrollment_no) {
            rollNumberField.value = student.enrollment_no;
        }

        // --- STEP 1C: Set the course and trigger batch loading ---
        if (student.course_id) {
            courseSelect.value = student.course_id;
            await fetchCourseDetails(student.course_id);
            if(student.batch_id) {
                 batchSelect.value = student.batch_id;
            }
        }
    }
    
    // ----------------------------------------------------------------------------------
    // 2. DYNAMIC ACADEMIC DATA 
    // ----------------------------------------------------------------------------------

    if (courseSelect) {
        courseSelect.addEventListener('change', (event) => {
            const selectedCourseId = event.target.value;
            if (selectedCourseId) {
                fetchCourseDetails(selectedCourseId);
                if (batchSelect) batchSelect.disabled = false;
            } else {
                if (batchSelect) {
                    batchSelect.innerHTML = '<option value="">Select Batch...</option>';
                    batchSelect.disabled = true;
                }
                dynamicDataArea.innerHTML = '';
            }
        });
    }

    async function fetchCourseDetails(courseId) {
        dynamicDataArea.innerHTML = '<p class="text-info mt-3">Loading academic details...</p>';
        // NOTE: Assuming /api/academicswithfees/course-details/:courseId exists and returns {batches, subjects, feeStructures}
        const data = await handleApiGet(`/api/academicswithfees/course-details/${courseId}`);
        if (!data) return; 

        updateBatchDropdown(data.batches);
        renderSubjectsAndFees(data.subjects, data.feeStructures);
    }
    
    function updateBatchDropdown(batches) {
        if (!batchSelect) return;
        const currentBatch = batchSelect.value; 
        batchSelect.innerHTML = '<option value="">Select Batch...</option>';
        if (batches && batches.length > 0) {
            batches.forEach(batch => {
                const option = document.createElement('option');
                option.value = batch.batch_id;
                option.textContent = `${batch.batch_name} (${batch.batch_code})`;
                batchSelect.appendChild(option);
            });
            batchSelect.value = currentBatch; 
            batchSelect.disabled = false;
        } else {
            batchSelect.innerHTML = '<option value="">No Batches available</option>';
            batchSelect.disabled = true;
        }
    }

    function renderSubjectsAndFees(subjects, feeStructures) {
        dynamicDataArea.innerHTML = `<p class="mt-3">Academic and Fee details for the course are now loaded.</p>`;
    }


    // ----------------------------------------------------------
    // 3. FORM SUBMISSION HANDLER (for UPDATE)
    // ----------------------------------------------------------
    if (form) {
        form.addEventListener('submit', async function(event) {
            event.preventDefault();
            if (!form.checkValidity()) {
                 event.stopPropagation();
                 form.classList.add('was-validated');
                 return;
            }
            
            const formData = new FormData(form);
            const body = {};

            // Convert FormData to JSON payload
            formData.forEach((value, key) => {
                // Ensure photo/signature fields are excluded if they are files (API expects JSON here)
                if (!['photo_file', 'signature_file'].includes(key)) {
                    body[key] = value || null; // Send null for empty strings
                }
            });

            // ⭐ CRITICAL FIX: Map the HTML field 'date_of_birth' to the API parameter 'dob'
            if (body.date_of_birth) {
                body.dob = body.date_of_birth;
            } else {
                // If the field is left blank, ensure 'dob' is explicitly NULL for the COALESCE logic on the server to work.
                body.dob = null;
            }
            delete body.date_of_birth; 


            // Clean up unnecessary fields for a cleaner API call
            delete body.student_user_id;
            delete body.roll_number;
            delete body.security_question; 
            
            // SECURITY: Only include password fields if a new value was provided
            if (!body.student_password_hash) {
                delete body.student_password_hash;
            }
            if (!body.parent_password_hash) {
                delete body.parent_password_hash;
            }


            try {
                const response = await fetch(`/api/students/${studentId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, // Use JSON headers
                    body: JSON.stringify(body) 
                });
                
                if (response.ok) {
                    alert('✅ Update successful! Redirecting to profile...');
                    window.location.href = `/student-profile.html?id=${studentId}`;
                } else {
                    let errorText = `Update failed (Status: ${response.status}).`;
                    
                    try {
                        const errorData = await response.json();
                        errorText = errorData.message || errorText;
                    } catch (e) {
                        console.error("Server returned non-JSON response:", e);
                        errorText = `Update failed. The server returned an unexpected error format (Status: ${response.status}). Please check server logs.`;
                    }
                    
                    console.error('Submission Error:', errorText); 
                    alert(`❌ ${errorText}`);
                }

            } catch (error) {
                console.error('Network or Unhandled Error:', error);
                alert('A network error occurred. Please try again.');
            }
        });
    }

    // --- INITIALIZATION ---
    await loadInitialCourses();
    await loadAndPopulateStudentData();
});