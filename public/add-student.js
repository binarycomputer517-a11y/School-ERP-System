/**
 * add-student.js
 * Handles 5-step form navigation, data validation, file/webcam processing, 
 * and API interactions for student enrollment.
 * * FINAL VERSION: Robust, explicitly defined API paths, and clean structure.
 */

(function() {
    // -----------------------------------------------------------
    // --- 1. Global Configuration and Variables ---
    // -----------------------------------------------------------
    const API_BASE_URL = window.API_BASE_URL || '/api';
    const ACADEMICS_ROUTER_PATH = '/academicswithfees'; 
    const TOTAL_STEPS = 5; 

    // --- Core Webcam/Geo Variables (Shared across webcam functions) ---
    const cameraModal = document.getElementById('camera_modal');
    let stream = null; 
    let stabilityCount = 0;
    let captureInterval = null;
    const STABILITY_THRESHOLD = 15; 

    // -----------------------------------------------------------
    // --- 2. CORE API HANDLER ---
    // -----------------------------------------------------------

    /**
     * Executes an authenticated fetch request to the backend API.
     */
    async function handleApi(endpoint, options = {}) {
        const AUTH_TOKEN = localStorage.getItem('erp-token');
        const ACTIVE_BRANCH_ID = localStorage.getItem('active_branch_id');
        const ACTIVE_SESSION_ID = localStorage.getItem('active_session_id');

        options.method = options.method || 'GET';
        let requestBody = options.body;
        if (requestBody && typeof requestBody === 'object') {
            requestBody = JSON.stringify(requestBody);
        }
        
        options.headers = { 
            ...options.headers,
            'Content-Type': 'application/json', 
            'Authorization': `Bearer ${AUTH_TOKEN}`,
            'active-branch-id': ACTIVE_BRANCH_ID,
            'active-session-id': ACTIVE_SESSION_ID
        };
        
        if (options.method === 'GET' || options.method === 'HEAD') {
            delete options.headers['Content-Type'];
        }

        const url = `${API_BASE_URL}${endpoint}`;
        const response = await fetch(url, { ...options, body: requestBody });

        if (response.status === 401 || response.status === 403) {
            console.error('API Unauthorized or Forbidden:', url);
            alert('Session expired or unauthorized. Please log in again.');
            throw new Error('Unauthorized or Forbidden access.');
        }
        
        if (!response.ok) {
            let errorData = await response.json().catch(() => null);
            if (errorData?.message || errorData?.error) {
                throw new Error(`Server error: ${response.status}. ${errorData.message || errorData.error}`);
            } else {
                const errorText = await response.text().catch(() => 'Unknown server error');
                throw new Error(`Server error: ${response.status}. ${errorText.substring(0, 100)}...`);
            }
        }
        
        return response; 
    }
    
    // -----------------------------------------------------------
    // --- 3. UI and Validation Helpers ---
    // -----------------------------------------------------------
    
    function updateProgressBar(currentStep) {
        const progressBar = document.getElementById('progressBar');
        const progressPercent = (currentStep / TOTAL_STEPS) * 100;
        
        if (progressBar) {
            progressBar.style.width = `${progressPercent}%`;
            progressBar.textContent = `Step ${currentStep} of ${TOTAL_STEPS}`;
        }
    }

    function openTab(evt, tabId) { 
        const clickedButton = evt.currentTarget || document.querySelector(`.tab-button[data-tab="${tabId}"]`);
        
        const newStep = parseInt(clickedButton.getAttribute('data-step'), 10);
        const currentActiveStep = parseInt(document.querySelector('.tab-button.active')?.getAttribute('data-step') || '1', 10);
        
        if (newStep > currentActiveStep) {
            if (!validateCurrentStep()) {
                return; 
            }
        }
        
        document.querySelectorAll('.tab-content fieldset').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-button').forEach(el => el.classList.remove('active'));

        const targetFieldset = document.getElementById(tabId);
        if (targetFieldset) {
            targetFieldset.classList.add('active');
        }
        clickedButton.classList.add('active');
        
        updateProgressBar(newStep);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function clearFeeAndSubjectDisplay(feeDisplayEl, subjectsDisplayEl) { 
        if (feeDisplayEl) feeDisplayEl.innerHTML = 'Fee structure details will appear here upon Course and Batch selection.';
        if (subjectsDisplayEl) subjectsDisplayEl.innerHTML = '<p>Subjects assigned to this Course will appear here.</p>';
    }

    function clearFeeDisplay(feeDisplayEl) { 
        if (feeDisplayEl) feeDisplayEl.innerHTML = 'Fee structure details will appear here upon Course and Batch selection.';
    }
    
    function validateCurrentStep() {
        const activeFieldset = document.querySelector('.tab-content fieldset.active');
        if (!activeFieldset) return true; 

        const requiredInputs = activeFieldset.querySelectorAll('[required]:not([type="hidden"])');
        let isValid = true;
        
        requiredInputs.forEach(input => {
            let isFieldInvalid = false;

            if (input.type === 'file') {
                const hiddenPathInput = document.getElementById(input.name.replace('_input', '_path'));
                if (!hiddenPathInput || !hiddenPathInput.value) {
                    isFieldInvalid = true;
                }
            } else if (!input.value || (input.tagName === 'SELECT' && input.value === '')) {
                isFieldInvalid = true;
            }

            if (isFieldInvalid) {
                input.style.border = '2px solid red'; 
                isValid = false;
            } else {
                input.style.border = ''; 
            }
        });

        if (!isValid) {
            alert('🛑 Please complete all required fields in the current step before proceeding.');
        }

        return isValid;
    }

    function validateFullFormAndFindFirstError(form) {
        let firstInvalidInput = null;
        let isValid = true;
        const requiredInputs = form.querySelectorAll('[required]:not([type="hidden"])');

        requiredInputs.forEach(input => {
            input.style.border = '';

            let isFieldInvalid = false;

            if (input.type === 'file') {
                const hiddenPathInput = document.getElementById(input.name.replace('_input', '_path'));
                if (!hiddenPathInput || !hiddenPathInput.value) {
                    isFieldInvalid = true;
                }
            } else if (!input.value || (input.tagName === 'SELECT' && input.value === '')) {
                isFieldInvalid = true;
            }

            if (isFieldInvalid) {
                input.style.border = '2px solid red';
                if (isValid) {
                    isValid = false;
                    firstInvalidInput = input;
                }
            }
        });

        return firstInvalidInput;
    }
    
    function handleFileInputChange(fileInputId, hiddenInputId, previewId) {
        return (event) => {
            const file = event.target.files[0];
            const hiddenInput = document.getElementById(hiddenInputId);
            const previewImg = document.getElementById(previewId);
            const previewFrame = previewImg.parentElement;
            const placeholder = previewFrame.querySelector('.photo-placeholder');

            if (file) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    hiddenInput.value = e.target.result; 
                    if (previewImg) {
                        previewImg.src = e.target.result;
                        previewImg.style.display = 'block';
                    }
                    if (placeholder) {
                        placeholder.style.display = 'none';
                    }
                };
                reader.readAsDataURL(file);
            } else {
                hiddenInput.value = '';
                if (previewImg) previewImg.style.display = 'none';
                if (placeholder) placeholder.style.display = 'block';
            }
        };
    }

    // -----------------------------------------------------------
    // --- 4. WEBCAM AND GEOLOCATION UTILITIES ---
    // -----------------------------------------------------------
    
    function mockStandardComplianceCheck(videoElement) {
        if (!videoElement || videoElement.videoWidth === 0) return { compliant: false };

        const isCentered = Math.random() > 0.1; 
        const isLit = Math.random() > 0.2;      
        const isNeutral = Math.random() > 0.05;  

        if (isCentered && isLit && isNeutral) {
            if (Math.random() > 0.98) {
                return { compliant: true, message: "Perfect alignment. Holding steady..." };
            }
            return { compliant: true, message: "Stand still and look directly at the camera." };
        }
        
        if (!isCentered) return { compliant: false, message: "Face must be centered." };
        if (!isLit) return { compliant: false, message: "Improve lighting conditions." };
        
        return { compliant: false, message: "Checking standards..." };
    }

    function startAutoCapture() {
        const video = document.getElementById('webcam_video');
        const snapBtn = document.getElementById('snap_btn');
        const autoCaptureToggle = document.getElementById('auto_capture_toggle'); 
        const captureStatus = document.getElementById('capture_status');

        if (captureInterval) clearInterval(captureInterval);

        captureInterval = setInterval(() => {
            if (!video || (autoCaptureToggle && !autoCaptureToggle.checked)) { 
                clearInterval(captureInterval);
                stabilityCount = 0;
                if (captureStatus) captureStatus.style.display = 'none';
                return;
            }

            const complianceResult = mockStandardComplianceCheck(video);
            
            if (complianceResult.compliant) {
                stabilityCount++;
                if (captureStatus) {
                    captureStatus.textContent = `COMPLIANT - ${STABILITY_THRESHOLD - stabilityCount} frames left`;
                    captureStatus.style.display = 'block';
                    captureStatus.style.backgroundColor = '#1ABC9C'; 
                }

                if (stabilityCount >= STABILITY_THRESHOLD) {
                    clearInterval(captureInterval);
                    if (captureStatus) {
                        captureStatus.textContent = "CAPTURED!";
                        captureStatus.style.backgroundColor = '#27AE60'; 
                    }
                    if (snapBtn) snapBtn.disabled = true; 
                    capturePhoto(); 
                }
            } else {
                stabilityCount = 0;
                if (captureStatus) {
                    captureStatus.textContent = `❌ ${complianceResult.message}`;
                    captureStatus.style.display = 'block';
                    captureStatus.style.backgroundColor = '#C0392B'; 
                }
                if (snapBtn) snapBtn.disabled = false;
            }
        }, 100); 
    }
    
    function getGeolocation() {
        const statusElement = document.getElementById('location_status');
        if (!statusElement) return;
        
        statusElement.textContent = '📍 Acquiring Location...';

        if ('geolocation' in navigator) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const coords = `${position.coords.latitude},${position.coords.longitude}`;
                    document.getElementById('location_coords').value = coords;
                    statusElement.textContent = `📍 Captured GPS: ${coords}`;
                },
                (error) => {
                    statusElement.textContent = `⚠️ Location error: ${error.message}`;
                    document.getElementById('location_coords').value = 'Error';
                }, { timeout: 10000, enableHighAccuracy: true }
            );
        } else {
            statusElement.textContent = '❌ Geolocation not supported.';
            document.getElementById('location_coords').value = 'Not Supported';
        }
    }

    function openCameraModal() { 
        if (!cameraModal) {
            alert("Webcam Modal elements are missing from the HTML structure.");
            return;
        }

        cameraModal.style.display = 'flex';
        document.getElementById('location_coords').value = ''; 
        getGeolocation(); 
        
        navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } })
            .then(s => {
                const video = document.getElementById('webcam_video');
                stream = s;
                video.srcObject = s;
                video.play();
                startAutoCapture(); 
            })
            .catch(err => {
                alert("Error accessing camera. Please ensure permissions are granted. Error: " + err.message);
                closeCameraModal();
            });
    }

    function closeCameraModal() {
        if (captureInterval) clearInterval(captureInterval); 
        stabilityCount = 0;

        const video = document.getElementById('webcam_video');
        const cameraModal = document.getElementById('camera_modal');

        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
        if (cameraModal) cameraModal.style.display = 'none';
    }

    function capturePhoto() {
        const video = document.getElementById('webcam_video');
        const canvas = document.getElementById('webcam_canvas'); // Use webcam_canvas ID
        
        if (!video || !canvas) return;
        
        const targetWidth = 450;
        const targetHeight = 570; 

        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const context = canvas.getContext('2d');
        
        const videoRatio = video.videoWidth / video.videoHeight;
        const targetRatio = targetWidth / targetHeight;
        let sx, sy, sw, sh; 

        if (videoRatio > targetRatio) {
            sw = video.videoHeight * targetRatio;
            sh = video.videoHeight;
            sx = (video.videoWidth - sw) / 2;
            sy = 0;
        } else {
            sw = video.videoWidth;
            sh = video.videoWidth / targetRatio;
            sx = 0;
            sy = (video.videoHeight - sh) / 2;
        }

        context.translate(targetWidth, 0);
        context.scale(-1, 1);
        context.drawImage(video, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
        
        const imageDataURL = canvas.toDataURL('image/jpeg', 0.8);
        
        document.getElementById('profile_image_path').value = imageDataURL;
        document.getElementById('photo-preview').src = imageDataURL;
        document.getElementById('photo-preview').style.display = 'block';
        
        const placeholder = document.getElementById('photo-preview-frame').querySelector('.photo-placeholder');
        if (placeholder) placeholder.style.display = 'none';

        closeCameraModal();
    }
    
    // -----------------------------------------------------------
    // --- 5. Academic Data Loading (API Functions) ---
    // -----------------------------------------------------------
    
    async function loadFeeStructure(courseId, batchId, feeDisplayEl) {
        if (!feeDisplayEl || !courseId || !batchId) return; 

        feeDisplayEl.innerHTML = '<p style="color: var(--primary-color);">Fetching Fee Structure...</p>';
        try {
            // Use the full, explicit router path
            const response = await handleApi(`${ACADEMICS_ROUTER_PATH}/fees/structures/find?course_id=${courseId}&batch_id=${batchId}`);
            const structure = await response.json();
            
            const calculateTotalFee = (s) => {
                const admission = parseFloat(s.admission_fee) || 0;
                const registration = parseFloat(s.registration_fee) || 0;
                const examination = parseFloat(s.examination_fee) || 0;
                const duration = parseInt(s.course_duration_months) || 1; 
                const transport = s.has_transport ? (parseFloat(s.transport_fee) || 0) * duration : 0;
                const hostel = s.has_hostel ? (parseFloat(s.hostel_fee) || 0) * duration : 0;
                return (admission + registration + examination + transport + hostel).toFixed(2);
            };
            
            const totalFee = calculateTotalFee(structure);

            feeDisplayEl.innerHTML = `
                <h4>💰 Fee Structure Details</h4>
                <p><strong>Structure Name:</strong> ${structure.structure_name || 'N/A'}</p>
                <p><strong>Admission Fee:</strong> ₹${(parseFloat(structure.admission_fee) || 0).toFixed(2)}</p>
                <p><strong>Registration Fee:</strong> ₹${(parseFloat(structure.registration_fee) || 0).toFixed(2)}</p>
                <p><strong>Examination Fee:</strong> ₹${(parseFloat(structure.examination_fee) || 0).toFixed(2)}</p>
                ${structure.has_transport ? `<p><strong>Transport Fee:</strong> ₹${(parseFloat(structure.transport_fee) || 0).toFixed(2)} / month</p>` : ''}
                ${structure.has_hostel ? `<p><strong>Hostel Fee:</strong> ₹${(parseFloat(structure.hostel_fee) || 0).toFixed(2)} / month</p>` : ''}
                <hr>
                <p style="font-weight: bold;">TOTAL ESTIMATED FEE (Course Duration ${structure.course_duration_months || 1} mos): ₹${totalFee}</p>
            `;
            
        } catch (err) {
            if (err.message.includes('Server error: 404')) {
                feeDisplayEl.innerHTML = '<p style="color:red;">⚠️ No Fee Structure found for this Course/Batch combination.</p>';
            } else {
                console.error('Fee Fetch Error:', err);
                feeDisplayEl.innerHTML = '<p style="color:red;">A server error occurred while retrieving fees.</p>';
            }
        }
    }
    
    async function loadSubjects(courseId, subjectsDisplayEl) {
        if (!subjectsDisplayEl || !courseId) return;

        subjectsDisplayEl.innerHTML = 'Fetching assigned subjects...';
        
        try {
            // FIX: Use the full, explicit router path
            const response = await handleApi(`${ACADEMICS_ROUTER_PATH}/courses/${courseId}/subjects`);
            const subjects = await response.json();

            if (Array.isArray(subjects) && subjects.length > 0) {
                const listHtml = subjects.map(s => `<li>${s.subject_name} (${s.subject_code})</li>`).join('');
                subjectsDisplayEl.innerHTML = `<h4>📚 Assigned Subjects (${subjects.length})</h4><ul style="margin-top: 5px; padding-left: 20px;">${listHtml}</ul>`;
            } else {
                subjectsDisplayEl.innerHTML = '<p>⚠️ No subjects are currently assigned to this course.</p>';
            }

        } catch (err) {
            console.error('Subject Fetch Error:', err);
            subjectsDisplayEl.innerHTML = '<p style="color:red;">A network error occurred while retrieving subjects.</p>';
        }
    }
    
    async function populateBatchDropdown(courseId) {
        const batchSelect = document.getElementById('batch_id');
        if (!batchSelect) return;

        batchSelect.removeEventListener('change', handleBatchChange); 
        batchSelect.innerHTML = '<option value="">Loading batches...</option>';
        batchSelect.disabled = true;
        
        if (!courseId) {
            batchSelect.innerHTML = '<option value="">-- Waiting for Course --</option>';
            return;
        }

        try {
            // FIX: Use the full, explicit router path
            const response = await handleApi(`${ACADEMICS_ROUTER_PATH}/batches/${courseId}`); 
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
    
    async function loadInitialDropdowns() {
        const courseSelect = document.getElementById('course_id');
        const batchSelect = document.getElementById('batch_id');
        const sessionSelect = document.getElementById('academic_session_id');
        
        if (!courseSelect || !batchSelect || !sessionSelect) {
            console.error('Missing critical select elements (session, course, or batch)');
            return;
        }

        courseSelect.innerHTML = '<option value="">Loading Courses...</option>';
        sessionSelect.innerHTML = '<option value="">Loading Sessions...</option>';
        batchSelect.innerHTML = '<option value="">-- Waiting for Course --</option>';
        batchSelect.disabled = true;

        try {
            // FIX: Use the full, explicit router path for Sessions
            const sessionResponse = await handleApi(`${ACADEMICS_ROUTER_PATH}/sessions`); 
            const sessions = await sessionResponse.json();
            
            sessionSelect.innerHTML = '<option value="">-- Select Session --</option>';
            if (Array.isArray(sessions)) {
                sessions.forEach(s => {
                    sessionSelect.innerHTML += `<option value="${s.id || s.academic_session_id}">${s.name || s.session_name}</option>`;
                });
            }
            
            // FIX: Use the full, explicit router path for Courses
            const courseResponse = await handleApi(`${ACADEMICS_ROUTER_PATH}/courses`); 
            const courses = await courseResponse.json();
            
            if (!Array.isArray(courses) || courses.length === 0) {
                 courseSelect.innerHTML = '<option value="">No courses found</option>';
                 return;
            }

            courseSelect.innerHTML = '<option value="">-- Select Course --</option>';
            courses.forEach(c => {
                courseSelect.innerHTML += `<option value="${c.id || c.course_id}">${c.course_name} (${c.course_code})</option>`;
            });
            
        } catch (err) {
            console.error('Failed to load initial data:', err);
            sessionSelect.innerHTML = '<option value="">Error loading sessions</option>';
            courseSelect.innerHTML = '<option value="">Error loading courses</option>';
        }
    }
    
    async function handleCourseChange(event) {
        const courseId = event.target.value;
        const feeDisplayEl = document.getElementById('fee-structure-display'); 
        const subjectsDisplayEl = document.getElementById('subjects-display');
        
        clearFeeAndSubjectDisplay(feeDisplayEl, subjectsDisplayEl);
        await populateBatchDropdown(courseId);
        
        if (courseId) loadSubjects(courseId, subjectsDisplayEl); 
    }
    
    
    // -----------------------------------------------------------
    // --- 6. Server Submission Logic ---
    // -----------------------------------------------------------

    async function handleAddStudentSubmit(event) {
        event.preventDefault(); 
        const form = event.target;
        const submitButton = form.querySelector('button[type="submit"]');

        const firstInvalidInput = validateFullFormAndFindFirstError(form);

        if (firstInvalidInput) {
            const fieldsetWithError = firstInvalidInput.closest('fieldset');
            const stepMap = { personal: 1, academics: 2, parents: 3, documents: 4, login: 5 }; 
            const stepId = fieldsetWithError.id;
            const stepNumber = stepMap[stepId];
            
            const tabButton = document.querySelector(`.tab-button[data-step="${stepNumber}"]`);
            
            if (tabButton) {
                openTab({currentTarget: tabButton}, stepId);
            }
            
            firstInvalidInput.focus();
            return; 
        }
        
        const passwordInput = form.querySelector('#password');
        const confirmPasswordInput = form.querySelector('#confirm_password');
        
        if (passwordInput.value !== confirmPasswordInput.value) {
            alert("Error: Passwords do not match!");
            passwordInput.style.border = '2px solid red'; 
            confirmPasswordInput.style.border = '2px solid red'; 
            
            const loginTabButton = document.querySelector('.tab-button[data-step="5"]');
            if (loginTabButton) openTab({currentTarget: loginTabButton}, 'login');
            return; 
        } else {
            passwordInput.style.border = '';
            confirmPasswordInput.style.border = '';
        }

        const formData = new FormData(form);
        const studentData = Object.fromEntries(formData.entries());
        delete studentData.confirm_password; 

        // --- Data Cleanup and Nulling Empty Strings ---
        for (const key of Object.keys(studentData)) {
            if (studentData[key] === '' || studentData[key] === 'null' || studentData[key] === 'N/A') {
                studentData[key] = null;
            }
        }
        if (!studentData.username && studentData.email) {
            studentData.username = studentData.email;
        }

        // Use the correct, non-prefixed endpoint path
        const API_ENDPOINT = '/students'; 
        submitButton.textContent = 'Submitting...';
        submitButton.disabled = true;

        try {
            const response = await handleApi(API_ENDPOINT, { method: 'POST', body: studentData }); 
            const result = await response.json();
            
            alert(`✅ Student successfully enrolled! Enrollment No: ${result.enrollment_no || 'N/A'}`);
            form.reset(); 
            
            clearFeeAndSubjectDisplay(document.getElementById('fee-structure-display'), document.getElementById('subjects-display'));
            
            const firstTabButton = document.querySelector('.tab-button[data-step="1"]');
            if (firstTabButton) {
                openTab({currentTarget: firstTabButton}, 'personal');
            }
            
        } catch (error) {
             console.error('Submission Error:', error);
             alert(`❌ Enrollment Failed: ${error.message || 'Unknown error'}`);
        } finally {
            submitButton.textContent = 'Add Student';
            submitButton.disabled = false;
        }
    }
    
    // -----------------------------------------------------------
    // --- 7. Initialization Entry Point ---
    // -----------------------------------------------------------
    
    document.addEventListener('DOMContentLoaded', initializeAddForm);

    function initializeAddForm() {
        const form = document.getElementById('addStudentForm'); 
        const token = localStorage.getItem('erp-token');
        
        if (!form || !token) {
            if (!token) console.warn('Authentication token missing. Please log in.');
            return;
        }
        
        form.addEventListener('submit', handleAddStudentSubmit);
        
        document.querySelectorAll('.tab-button[data-tab]').forEach(button => {
            button.addEventListener('click', (event) => {
                const tabId = event.currentTarget.getAttribute('data-tab');
                openTab(event, tabId);
            });
        });
        
        document.getElementById('profile_image_input').addEventListener('change', handleFileInputChange('profile_image_input', 'profile_image_path', 'photo-preview'));
        document.getElementById('signature_input').addEventListener('change', handleFileInputChange('signature_input', 'signature_path', 'signature-preview'));
        document.getElementById('id_document_input').addEventListener('change', handleFileInputChange('id_document_input', 'id_document_path', 'id-proof-preview'));

        const livePhotoBtn = document.querySelector('.live-photo-btn');
        if (livePhotoBtn) livePhotoBtn.addEventListener('click', openCameraModal); 
        
        const snapBtn = document.getElementById('snap_btn');
        const closeCameraBtn = document.getElementById('close_camera_btn');
        if (snapBtn) snapBtn.addEventListener('click', capturePhoto);
        if (closeCameraBtn) closeCameraBtn.addEventListener('click', closeCameraModal);

        const courseSelect = document.getElementById('course_id');
        const batchSelect = document.getElementById('batch_id');
        
        if (courseSelect) courseSelect.addEventListener('change', handleCourseChange);
        if (batchSelect) batchSelect.addEventListener('change', handleBatchChange);
        
        updateProgressBar(1);
        loadInitialDropdowns();
        const dateInput = document.getElementById('admission_date');
        if(dateInput) dateInput.valueAsDate = new Date();
    }


})(); // End of IIFE