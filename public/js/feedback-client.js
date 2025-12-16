// public/js/feedback-client.js (UPDATED to use window.erpSettings)

document.addEventListener('DOMContentLoaded', async () => {
    
    // --- UTILITY: Function to safely wait for erpSettings to load ---
    async function getSettings() {
        let attempts = 0;
        // Wait up to 500ms (5 attempts * 100ms) for settings to load
        while (!window.erpSettings && attempts < 5) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
        return window.erpSettings;
    }

    const settings = await getSettings();

    // Check for essential settings and user session
    if (!settings || !localStorage.getItem('erp-token')) {
        console.error('Feedback Client: Global configuration (erpSettings) or user session not found.');
        // Optionally hide the form or show a message
        const container = document.querySelector('.feedback-container');
        if(container) container.innerHTML = '<p style="color: red;">Cannot load feedback system. Please log in again.</p>';
        return;
    }

    // --- DOM Elements ---
    const feedbackForm = document.getElementById('feedbackForm');
    const submissionList = document.getElementById('submissionList');
    
    // Use settings property directly
    const feedbackStatusColors = settings.FEEDBACK_STATUS_COLORS || { 'Resolved': '#2ecc71' };


    // --- Utility Function (Reuse fetchWithAuth) ---
    async function fetchWithAuth(url, options = {}) {
        const token = localStorage.getItem('erp-token');
        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers };
        const response = await fetch(url, { ...options, headers });
        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({ message: 'Server error.' }));
            throw new Error(errorBody.message || `API request failed: ${response.status}`);
        }
        return response.json();
    }


    // =========================================================
    // A. HANDLE NEW SUBMISSION
    // =========================================================

    if (feedbackForm) {
        // Populate Priority Dropdown using settings
        const prioritySelect = document.getElementById('feedbackPriority');
        (settings.FEEDBACK_PRIORITIES || ['Low', 'Medium', 'High']).forEach(p => {
            const option = document.createElement('option');
            option.value = p;
            option.textContent = p;
            prioritySelect.appendChild(option);
        });

        feedbackForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const subject = document.getElementById('feedbackSubject').value.trim();
            const content = document.getElementById('feedbackContent').value.trim();
            const priority = prioritySelect.value;
            const submitBtn = document.getElementById('submitFeedbackBtn');
            const messageArea = document.getElementById('formMessage');

            submitBtn.disabled = true;
            messageArea.textContent = 'Submitting...';
            messageArea.style.color = '#3498db';

            try {
                // Use settings property for API endpoint
                const endpoint = settings.API_ENDPOINTS.SUBMIT_FEEDBACK || '/api/feedback/submit';
                
                const response = await fetchWithAuth(endpoint, {
                    method: 'POST',
                    body: JSON.stringify({ subject, content, priority })
                });

                messageArea.textContent = response.message || 'Feedback submitted successfully!';
                messageArea.style.color = feedbackStatusColors.Resolved; 

                feedbackForm.reset();
                loadMySubmissions(); 

            } catch (error) {
                console.error('Submission failed:', error);
                messageArea.textContent = `Submission failed: ${error.message}`;
                messageArea.style.color = 'red';
            } finally {
                submitBtn.disabled = false;
            }
        });
    }

    // =========================================================
    // B. LOAD USER SUBMISSIONS
    // =========================================================

    async function loadMySubmissions() {
        if (!submissionList) return;

        submissionList.innerHTML = '<li>Loading your feedback submissions...</li>';

        try {
            // Use settings property for API endpoint
            const endpoint = settings.API_ENDPOINTS.MY_SUBMISSIONS || '/api/feedback/my-submissions';
            const submissions = await fetchWithAuth(endpoint);
            
            submissionList.innerHTML = ''; 
            
            if (submissions.length === 0) {
                submissionList.innerHTML = '<li>You have not submitted any feedback yet.</li>';
                return;
            }

            submissions.forEach(submission => {
                const listItem = document.createElement('li');
                listItem.classList.add('feedback-item');
                
                const statusColor = feedbackStatusColors[submission.status] || '#888';

                listItem.innerHTML = `
                    <div class="feedback-header">
                        <span class="feedback-subject">${submission.subject}</span>
                        <span class="feedback-priority priority-${submission.priority.toLowerCase()}">${submission.priority}</span>
                        <span class="feedback-status" style="background-color: ${statusColor};">${submission.status}</span>
                    </div>
                    <div class="feedback-body">
                        <p>${submission.content.substring(0, 150)}...</p>
                        <small>Submitted on: ${new Date(submission.created_at).toLocaleDateString()}</small>
                        ${submission.admin_notes ? `<p class="admin-response">Admin Note: ${submission.admin_notes}</p>` : ''}
                    </div>
                `;
                submissionList.appendChild(listItem);
            });

        } catch (error) {
            console.error('Failed to load submissions:', error);
            submissionList.innerHTML = `<li style="color: red;">Failed to load your submissions. ${error.message}</li>`;
        }
    }
    
    // Initial Load
    loadMySubmissions(); 
});