/**
 * BCSM ERP - Advanced Feedback Admin Logic
 * Version: 4.1 (Fix for Null Priority Constraint)
 */

let masterFeedbackData = [];

// 1. GLOBAL SCOPE: Load Feedback
async function loadFeedback() {
    const feedbackList = document.getElementById('allFeedbackList');
    const spinner = document.getElementById('loading-spinner');
    
    if (!feedbackList) return;
    if (spinner) spinner.classList.remove('d-none');

    try {
        const response = await fetch('/api/feedback/all', {
            headers: { 
                'Authorization': `Bearer ${localStorage.getItem('erp-token')}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) throw new Error("Server communication failed.");

        masterFeedbackData = await response.json();
        
        updateDashboardStats();
        applyFilters();

    } catch (error) {
        console.error('Feedback Engine Error:', error);
        feedbackList.innerHTML = `<div class="alert alert-danger border-0 shadow-sm">Sync Error: ${error.message}</div>`;
    } finally {
        if (spinner) spinner.classList.add('d-none');
    }
}

// 2. Client-side Filtering & Search
function applyFilters() {
    const statusVal = document.getElementById('feedbackStatusFilter')?.value || 'all';
    const catVal = document.getElementById('feedbackCategoryFilter')?.value || 'all';
    const searchVal = document.getElementById('feedbackSearch')?.value.toLowerCase() || '';

    const filtered = masterFeedbackData.filter(item => {
        const matchesStatus = statusVal === 'all' || item.status === statusVal;
        const matchesCategory = catVal === 'all' || item.category === catVal;
        const matchesSearch = item.subject.toLowerCase().includes(searchVal) || 
                              (item.user_name && item.user_name.toLowerCase().includes(searchVal));
        return matchesStatus && matchesCategory && matchesSearch;
    });

    renderFeedbackUI(filtered);
}

// 3. UI Rendering
function renderFeedbackUI(items) {
    const feedbackList = document.getElementById('allFeedbackList');
    if (!feedbackList) return;

    const settings = window.erpSettings || {};
    const colors = settings.FEEDBACK_STATUS_COLORS || { 'Pending': '#f1c40f', 'Reviewed': '#3498db', 'Resolved': '#2ecc71' };
    const statuses = settings.FEEDBACK_STATUSES || ['Pending', 'Reviewed', 'Resolved'];

    if (items.length === 0) {
        feedbackList.innerHTML = '<div class="text-center p-5 text-muted">No records found.</div>';
        return;
    }

    feedbackList.innerHTML = items.map(item => {
        const status = item.status || 'Pending';
        const priority = item.priority || 'Medium';

        return `
            <li class="feedback-admin-item priority-${priority.toLowerCase()}" id="item-${item.id}">
                <div class="action-btns">
                    <button class="btn btn-light btn-sm text-danger border" onclick="deleteFeedback('${item.id}')"><i class="fas fa-trash"></i></button>
                </div>
                <div class="feedback-header pe-5">
                    <div>
                        <span class="badge bg-secondary mb-2" style="font-size:0.6rem;">${item.category?.toUpperCase() || 'OTHER'}</span>
                        <h5 class="fw-bold mb-1">${item.subject}</h5>
                        <div class="small text-muted">
                            <i class="fas fa-user-circle"></i> ${item.user_name || 'Anonymous'} | 
                            <i class="fas fa-calendar-alt"></i> ${new Date(item.created_at).toLocaleDateString()}
                        </div>
                    </div>
                    <span class="badge status-badge" style="background-color: ${colors[status] || '#888'}">${status}</span>
                </div>
                <div class="mt-3 p-3 bg-light rounded-3 border-start border-3 border-primary">
                    <p class="mb-0 text-dark">${item.content || item.message}</p>
                </div>
                <div class="admin-note-area mt-4">
                    <div class="row g-2 align-items-end">
                        <div class="col-md-3">
                             <label class="form-label small fw-bold">Update Status</label>
                             <select class="form-select form-select-sm" id="status-${item.id}">
                                ${statuses.map(s => `<option value="${s}" ${s === status ? 'selected' : ''}>${s}</option>`).join('')}
                            </select>
                        </div>
                        <div class="col-md-6">
                            <label class="form-label small fw-bold">Resolution Note</label>
                            <textarea class="form-control form-control-sm" id="note-${item.id}" rows="1">${item.admin_notes || ''}</textarea>
                        </div>
                        <div class="col-md-3">
                            <button class="btn btn-primary btn-sm w-100 fw-bold" onclick="updateFeedbackRecord('${item.id}')">Update</button>
                        </div>
                    </div>
                </div>
            </li>`;
    }).join('');
}

// 4. Update Function (FIXED: Capturing existing priority)
window.updateFeedbackRecord = async (id) => {
    const status = document.getElementById(`status-${id}`).value;
    const admin_note = document.getElementById(`note-${id}`).value;
    
    // Find existing data to get priority
    const existingItem = masterFeedbackData.find(item => item.id === id);
    const priority = existingItem ? existingItem.priority : 'Medium';

    try {
        const res = await fetch(`/api/feedback/update/${id}`, {
            method: 'PUT',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${localStorage.getItem('erp-token')}` 
            },
            body: JSON.stringify({ status, admin_note, priority }) // Now sending priority
        });
        
        if (res.ok) {
            alert('Updated successfully.');
            loadFeedback();
        } else {
            const err = await res.json();
            alert('Error: ' + err.message);
        }
    } catch (e) {
        alert('Update failed: ' + e.message);
    }
};

window.deleteFeedback = async (id) => {
    if (!confirm("Delete this record?")) return;
    try {
        const res = await fetch(`/api/feedback/delete/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('erp-token')}` }
        });
        if (res.ok) loadFeedback();
    } catch (e) { alert('Delete failed.'); }
};

function updateDashboardStats() {
    const stats = {
        total: masterFeedbackData.length,
        high: masterFeedbackData.filter(i => i.priority === 'High').length,
        pending: masterFeedbackData.filter(i => i.status === 'Pending').length,
        resolved: masterFeedbackData.filter(i => i.status === 'Resolved').length
    };
    Object.keys(stats).forEach(key => {
        const el = document.getElementById(`count-${key}`);
        if(el) el.innerText = stats[key];
    });
}

document.addEventListener('DOMContentLoaded', () => {
    loadFeedback();
    document.getElementById('feedbackStatusFilter')?.addEventListener('change', applyFilters);
    document.getElementById('feedbackCategoryFilter')?.addEventListener('change', applyFilters);
    let timeout = null;
    document.getElementById('feedbackSearch')?.addEventListener('input', () => {
        clearTimeout(timeout);
        timeout = setTimeout(applyFilters, 300);
    });
});