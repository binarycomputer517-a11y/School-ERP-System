// public/js/feedback-admin.js (UPDATED to use window.erpSettings)

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
        console.error('Feedback Admin: Global configuration (erpSettings) or user session not found.');
        const container = document.querySelector('.feedback-container');
        if(container) container.innerHTML = '<p style="color: red;">Cannot load feedback management system. Please check permissions.</p>';
        return;
    }
    
    // --- DOM Elements ---
    const allFeedbackList = document.getElementById('allFeedbackList');
    // Use settings properties directly
    const feedbackStatusColors = settings.FEEDBACK_STATUS_COLORS || {};
    const feedbackStatusFilter = document.getElementById('feedbackStatusFilter');

    // --- Utility Function (Ensure fetchWithAuth is accessible) ---
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
    // A. LOAD ALL FEEDBACK
    // =========================================================

    // Populate Status Filter Dropdown using settings
    if (feedbackStatusFilter) {
        // Use settings property for statuses
        const availableStatuses = settings.FEEDBACK_STATUSES || ['New', 'In Progress', 'Resolved', 'Closed'];

        ['All', ...availableStatuses].forEach(status => {
            const option = document.createElement('option');
            option.value = status;
            option.textContent = status;
            feedbackStatusFilter.appendChild(option);
        });
        feedbackStatusFilter.addEventListener('change', loadAllFeedback);
    }
    

    async function loadAllFeedback() {
        if (!allFeedbackList) return;

        allFeedbackList.innerHTML = '<li>Loading all system feedback...</li>';
        const selectedStatus = feedbackStatusFilter ? feedbackStatusFilter.value : 'All';
        
        // Use settings property for API endpoint
        const baseEndpoint = settings.API_ENDPOINTS.ALL_FEEDBACK || '/api/feedback/all';
        const apiUrl = selectedStatus === 'All' 
                       ? baseEndpoint
                       : `${baseEndpoint}?status=${selectedStatus}`;


        try {
            const feedbackEntries = await fetchWithAuth(apiUrl);
            
            allFeedbackList.innerHTML = ''; 
            
            if (feedbackEntries.length === 0) {
                allFeedbackList.innerHTML = `<li>No ${selectedStatus.toLowerCase()} feedback found.</li>`;
                return;
            }

            // Use settings property for statuses
            const availableStatuses = settings.FEEDBACK_STATUSES || ['New', 'In Progress', 'Resolved', 'Closed'];


            feedbackEntries.forEach(entry => {
                const listItem = document.createElement('li');
                listItem.classList.add('feedback-admin-item');
                listItem.setAttribute('data-id', entry.id);
                
                const statusColor = feedbackStatusColors[entry.status] || '#888';

                listItem.innerHTML = `
                    <div class="feedback-header">
                        <span class="feedback-subject">${entry.subject} (From: ${entry.sender_username} / ${entry.user_role})</span>
                        <span class="feedback-status" style="background-color: ${statusColor};">${entry.status}</span>
                    </div>
                    <div class="feedback-body">
                        <p><strong>Content:</strong> ${entry.content}</p>
                        <p><strong>Priority:</strong> ${entry.priority}</p>
                        <p><strong>Submitted:</strong> ${new Date(entry.created_at).toLocaleString()}</p>
                        ${entry.admin_notes ? `<p class="admin-note">Note: ${entry.admin_notes}</p>` : ''}
                        
                        <div class="admin-actions" data-id="${entry.id}">
                            <select class="status-selector">
                                ${availableStatuses.map(s => 
                                    `<option value="${s}" ${s === entry.status ? 'selected' : ''}>${s}</option>`
                                ).join('')}
                            </select>
                            <textarea placeholder="Admin Notes/Resolution (Optional)" class="admin-notes-input">${entry.admin_notes || ''}</textarea>
                            <button class="update-btn">Update Status</button>
                        </div>
                    </div>
                `;
                allFeedbackList.appendChild(listItem);
            });

        } catch (error) {
            console.error('Failed to load all feedback:', error);
            allFeedbackList.innerHTML = `<li style="color: red;">Failed to load system feedback. ${error.message}</li>`;
        }
    }

    // =========================================================
    // B. HANDLE STATUS UPDATE
    // =========================================================

    allFeedbackList.addEventListener('click', async (event) => {
        if (!event.target.classList.contains('update-btn')) return;

        const container = event.target.closest('.admin-actions');
        const feedbackId = container.getAttribute('data-id');
        const status = container.querySelector('.status-selector').value;
        const adminNotes = container.querySelector('.admin-notes-input').value.trim();
        const updateBtn = event.target;

        if (!confirm(`Are you sure you want to change status to ${status}?`)) return;

        updateBtn.disabled = true;
        updateBtn.textContent = 'Updating...';

        try {
            // Use settings property for API endpoint
            const endpoint = settings.API_ENDPOINTS.UPDATE_STATUS(feedbackId) || `/api/feedback/${feedbackId}/status`;

            await fetchWithAuth(endpoint, {
                method: 'PUT',
                body: JSON.stringify({ status, adminNotes })
            });

            alert('Status updated successfully!');
            await loadAllFeedback(); // Reload the list

        } catch (error) {
            alert(`Failed to update status: ${error.message}`);
        } finally {
            updateBtn.disabled = false;
            updateBtn.textContent = 'Update Status';
        }
    });
    
    // Initial Load
    loadAllFeedback();
});