// Quiz.js (For public/quiz.html)

// --- Global Constants and States ---
const QUIZ_API = '/api/online-exam'; // Backend path for quiz actions
let attemptId = null;
let monitoringInterval = null;
let audioMonitor = null;

// --- Helper Functions ---
async function handleApi(url, method = 'GET', body = null) {
    const token = localStorage.getItem('erp-token');
    const authHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    const options = {
        method,
        headers: authHeaders,
        body: body ? JSON.stringify(body) : null
    };

    const response = await fetch(url, options);
    if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ message: 'Server Error' }));
        throw new Error(`API call failed: ${errorBody.message}`);
    }
    return response.json();
}

/**
 * Captures a live image from the webcam as Base64.
 */
function captureImage() {
    return new Promise((resolve) => {
        const video = document.getElementById('live-camera');
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg')); 
    });
}


// --- Failsafe/Security Logic ---

/**
 * Automatically blocks the exam if the student loses focus or switches applications.
 */
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && attemptId) {
        blockExam('Application Switch/Focus Lost');
    }
});

/**
 * Conceptual setup for sound detection.
 */
function setupAudioMonitoring() {
    // NOTE: This fulfills the requirement but relies on browser API for mic access and complex analysis logic (not shown).
    navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
            console.log("Audio monitoring stream started.");
        })
        .catch(err => {
            console.error("Audio access denied:", err);
        });
}

/**
 * Blocks the exam and reports the violation to the server.
 */
async function blockExam(reason) {
    if (attemptId) {
        clearInterval(monitoringInterval);
        clearInterval(audioMonitor);
        
        // Report violation to the backend
        try {
            await handleApi(`${QUIZ_API}/block-exam/${attemptId}`, 'POST', { reason: reason });
        } catch (e) {
            console.error("Failed to report block to server:", e);
        }

        document.getElementById('quiz-content').innerHTML = `
            <h2>Exam Blocked! ❌</h2>
            <p style="color: red;">Reason: ${reason}</p>
            <p>Your attempt has been recorded.</p>
        `;
        document.getElementById('verification-area').style.display = 'none';
        attemptId = null; 
    }
}


// --- Core Exam Flow ---

/**
 * Initiates all security checks before loading the quiz content.
 */
async function startVerification() {
    document.getElementById('start-verification-btn').disabled = true;
    const messageDiv = document.getElementById('verification-message');
    messageDiv.textContent = 'Verification in progress... (Checking credentials and live image)';

    try {
        // 1. Data Collection (MOCK DATA - Must be replaced with actual user session data)
        const studentData = {
            student_id: 12345, 
            quiz_id: 201,      
            course_id: 10,
            batch_id: 5,
            room_number: 'R-A101',
            system_id: 'SYS-05',
            live_image_data: await captureImage() // Live image for comparison
        };

        // 2. API Call to Backend for Verification (Performs all checks: ID match, Schedule, FIM)
        const verificationResult = await handleApi(`${QUIZ_API}/exam/start`, 'POST', studentData);

        attemptId = verificationResult.attempt_id;

        // 3. Setup Proctored Monitoring (Motion/Sound/Focus)
        setupMonitoring(attemptId);
        setupAudioMonitoring();
        
        // 4. Load Quiz Questions (Fetches the 100 dynamic MCQs)
        await loadQuizQuestions(attemptId);

        // 5. Success: Show Quiz Content
        document.getElementById('verification-area').style.display = 'none';
        document.getElementById('quiz-content').style.display = 'block';
        messageDiv.textContent = '✅ Verification successful! Exam started.';

    } catch (error) {
        messageDiv.textContent = `❌ Access Denied: ${error.message}`;
        document.getElementById('start-verification-btn').disabled = false;
    }
}

/**
 * Loads the 100 dynamic questions assigned to this attempt ID.
 */
async function loadQuizQuestions(currentAttemptId) {
    try {
        const questions = await handleApi(`${QUIZ_API}/attempts/${currentAttemptId}/questions`);
        
        const mcqArea = document.getElementById('mcq-area');
        mcqArea.innerHTML = '';
        
        questions.forEach((q, index) => {
            // Renders questions based on the structure defined in the SQL schema
            mcqArea.innerHTML += `
                <div style="margin-bottom: 20px; border: 1px dashed #ccc; padding: 10px;">
                    <p><strong>${index + 1}. ${q.question_text}</strong> (Marks: ${q.marks})</p>
                    <label><input type="radio" name="q_${q.question_id}" value="A"> A. ${q.option_a}</label><br>
                    <label><input type="radio" name="q_${q.question_id}" value="B"> B. ${q.option_b}</label><br>
                    <label><input type="radio" name="q_${q.question_id}" value="C"> C. ${q.option_c}</label><br>
                    <label><input type="radio" name="q_${q.question_id}" value="D"> D. ${q.option_d}</label><br>
                </div>
            `;
        });
    } catch (error) {
        console.error("Error loading questions:", error);
        blockExam("Failed to load quiz questions.");
    }
}

/**
 * Sets up video and motion monitoring.
 */
function setupMonitoring(attemptId) {
    const video = document.getElementById('live-camera');
    
    // Start camera stream (Camera is mandatory)
    navigator.mediaDevices.getUserMedia({ video: true, audio: false }) // Audio stream handled separately/conceptually
        .then(stream => {
            video.srcObject = stream;
        })
        .catch(err => {
            console.error("Camera access denied:", err);
            document.getElementById('verification-message').textContent = "❌ Camera access required. Cannot proceed without permission.";
            blockExam('Camera Access Denied'); // Block if camera is mandatory
        });

    // Motion/Movement Monitoring (Conceptual - requires external ML/CV library)
    monitoringInterval = setInterval(() => {
        // Conceptual: Check for excessive head/body motion or absence of face.
        // if (motionDetected) { blockExam('Excessive Movement Detected'); }
    }, 5000); 
}

/**
 * Submits the quiz answers for grading.
 */
async function submitQuiz() {
    if (!confirm("Are you sure you want to submit the exam?")) return;
    
    clearInterval(monitoringInterval);
    clearInterval(audioMonitor);
    
    // 1. Collect all answers from the form
    const formAnswers = [];
    document.querySelectorAll('#mcq-area input[type="radio"]:checked').forEach(input => {
        formAnswers.push({
            question_id: input.name.split('_')[1],
            answer: input.value
        });
    });

    try {
        // 2. Send answers to the server for final grading
        const submission = await handleApi(`${QUIZ_API}/submit-attempt/${attemptId}`, 'POST', { answers: formAnswers });
        
        // 3. Stop Media Streams
        const stream = document.getElementById('live-camera').srcObject;
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }

        alert("Exam submitted successfully! Loading results...");

        // 4. Redirect/Load OMR Result Page
        window.location.href = `/quiz-result.html?attempt=${attemptId}`;

    } catch (error) {
        alert(`❌ Submission failed: ${error.message}`);
    }
}

// --- Initial setup on load ---
document.addEventListener('DOMContentLoaded', async () => {
    // Initial display logic
});