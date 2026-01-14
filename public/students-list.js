/**
 * students-list.js - FULL ERP VERSION
 * Features: View, Edit, Print ID, Delete, and Quick Unlock (Rs. 1,000).
 */

(function() {
    // -----------------------------------------------------------
    // --- 1. CONFIGURATION & STATE ---
    // -----------------------------------------------------------
    const API_BASE_URL = window.API_BASE_URL || '/api';
    const STUDENTS_API_ENDPOINT = '/students';
    const ACADEMICS_API_ENDPOINT = '/academicswithfees';
    const AUTH_ACTIVATE_ENDPOINT = '/auth/activate-student';
    
    let allStudentsData = [];
    let selectedStudentIds = new Set(); 
    let currentSortColumn = 'admission_id';
    let currentSortDirection = 'asc';
    let targetUsernameForUnlock = ''; 

    // --- DOM Elements ---
    const studentTableBody = document.getElementById('students-table-body');
    const searchInput = document.getElementById('search-input');
    const courseFilter = document.getElementById('course-filter');
    const statusFilter = document.getElementById('status-filter');
    const bulkIdBtn = document.getElementById('generate-bulk-id-btn');
    const selectAllCheckbox = document.getElementById('select-all-checkbox');
    const recordCountDisplay = document.getElementById('record-count');

    // Modal Elements
    const unlockModalEl = document.getElementById('unlockModal');
    const confirmUnlockBtn = document.getElementById('confirm-unlock-btn');
    const targetStudentNameSpan = document.getElementById('target-student');

    // -----------------------------------------------------------
    // --- 2. INITIALIZATION ---
    // -----------------------------------------------------------
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        if (!studentTableBody) return; 

        if (searchInput) searchInput.addEventListener('keyup', renderTable);
        if (courseFilter) courseFilter.addEventListener('change', renderTable);
        if (statusFilter) statusFilter.addEventListener('change', renderTable);
        if (selectAllCheckbox) selectAllCheckbox.addEventListener('change', handleSelectAll);
        
        if (bulkIdBtn) bulkIdBtn.addEventListener('click', handleBulkIdGeneration);
        if (confirmUnlockBtn) confirmUnlockBtn.addEventListener('click', processAccountUnlock);

        document.querySelectorAll('th[data-sort]').forEach(header => {
            header.addEventListener('click', () => handleSort(header.dataset.sort));
            header.style.cursor = 'pointer';
        });

        loadStudents();
    }

    // -----------------------------------------------------------
    // --- 3. DATA FETCHING ---
    // -----------------------------------------------------------
    async function loadStudents() {
        try {
            const token = localStorage.getItem('erp-token');
            const headers = { 'Authorization': `Bearer ${token}` };

            const [studentsRes, coursesRes] = await Promise.all([
                fetch(`${API_BASE_URL}${STUDENTS_API_ENDPOINT}`, { headers }),
                fetch(`${API_BASE_URL}${ACADEMICS_API_ENDPOINT}/courses`, { headers })
            ]);

            allStudentsData = await studentsRes.json();
            populateCourseFilter(await coursesRes.json());
            renderTable();
        } catch (error) {
            studentTableBody.innerHTML = `<tr><td colspan="8" class="text-center text-danger">Error: ${error.message}</td></tr>`;
        }
    }

    // -----------------------------------------------------------
    // --- 4. RENDER LOGIC (Restoring View, Edit, ID Card) ---
    // -----------------------------------------------------------
    function renderTable() {
        const term = searchInput ? searchInput.value.toLowerCase() : '';
        const course = courseFilter ? courseFilter.value : '';
        const status = statusFilter ? statusFilter.value : '';

        let filtered = allStudentsData.filter(s => {
            const fullName = `${s.first_name} ${s.last_name || ''}`.toLowerCase();
            return (fullName.includes(term) || s.username.toLowerCase().includes(term)) &&
                   (!course || s.course_id == course) &&
                   (!status || s.status === status);
        });

        studentTableBody.innerHTML = '';
        if (recordCountDisplay) recordCountDisplay.innerText = `Showing ${filtered.length} records`;

        filtered.forEach(student => {
            const isRestricted = !student.is_paid || student.status === 'expired' || !student.is_active;
            const isChecked = selectedStudentIds.has(student.student_id.toString()) ? 'checked' : '';
            
            const statusBadge = isRestricted ? 
                `<span class="badge bg-light text-danger border border-danger-subtle"><i class="fas fa-lock me-1"></i>Restricted</span>` : 
                `<span class="badge bg-light text-success border border-success-subtle"><i class="fas fa-check-circle me-1"></i>Active</span>`;

            const unlockBtn = isRestricted ? 
                `<button class="btn btn-sm btn-success py-0 px-2 ms-1" onclick="window.showUnlockModal('${student.username}')">Unlock</button>` : '';

            const avatar = `<div class="avatar-circle">${(student.first_name || 'N').charAt(0)}</div>`;

            const row = `
                <tr class="student-row">
                    <td class="align-middle text-center"><input class="form-check-input student-chk" type="checkbox" value="${student.student_id}" ${isChecked}></td>
                    <td class="align-middle fw-bold">${student.admission_id || '-'}</td>
                    <td class="align-middle">
                        <div class="d-flex align-items-center gap-2">
                            ${avatar}
                            <div>
                                <div class="fw-bold">${student.first_name} ${student.last_name || ''}</div>
                                <div class="small text-muted">@${student.username}</div>
                            </div>
                        </div>
                    </td>
                    <td class="align-middle small">${student.course_name || '-'}</td>
                    <td class="align-middle small">${student.phone_number || '-'}</td>
                    <td class="align-middle text-end fw-bold text-danger">Rs. ${parseFloat(student.total_fees_due || 0).toFixed(0)}</td>
                    <td class="align-middle text-center">${statusBadge} ${unlockBtn}</td>
                    <td class="align-middle text-center">
                        <div class="d-flex justify-content-center gap-2">
                            <a class="btn btn-sm btn-outline-primary" href="student-profile.html?id=${student.student_id}" title="View"><i class="fas fa-eye"></i></a>
                            <a class="btn btn-sm btn-outline-dark" href="edit-student.html?id=${student.student_id}" title="Edit"><i class="fas fa-pen"></i></a>
                            <a class="btn btn-sm btn-outline-info" href="id-card.html?id=${student.student_id}" target="_blank" title="ID Card"><i class="fas fa-id-card"></i></a>
                            <button class="btn btn-sm btn-outline-danger del-btn" data-id="${student.student_id}" title="Delete"><i class="fas fa-trash-alt"></i></button>
                        </div>
                    </td>
                </tr>`;
            studentTableBody.innerHTML += row;
        });
        
        attachDynamicListeners();
    }

    // -----------------------------------------------------------
    // --- 5. FUNCTIONALITY HANDLERS ---
    // -----------------------------------------------------------
    window.showUnlockModal = (username) => {
        targetUsernameForUnlock = username;
        if (targetStudentNameSpan) targetStudentNameSpan.innerText = username;
        const modalInstance = new bootstrap.Modal(unlockModalEl);
        modalInstance.show();
    };

    async function processAccountUnlock() {
        if (!targetUsernameForUnlock) return;
        confirmUnlockBtn.disabled = true;
        try {
            const response = await fetch(`${API_BASE_URL}${AUTH_ACTIVATE_ENDPOINT}`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('erp-token')}`
                },
                body: JSON.stringify({ username: targetUsernameForUnlock })
            });
            if (response.ok) {
                bootstrap.Modal.getInstance(unlockModalEl).hide();
                loadStudents();
            }
        } catch (err) { alert("Activation failed"); }
        finally { confirmUnlockBtn.disabled = false; }
    }

    function attachDynamicListeners() {
        document.querySelectorAll('.student-chk').forEach(chk => {
            chk.addEventListener('change', (e) => {
                const id = e.target.value;
                e.target.checked ? selectedStudentIds.add(id) : selectedStudentIds.delete(id);
                if (bulkIdBtn) bulkIdBtn.disabled = selectedStudentIds.size === 0;
            });
        });

        document.querySelectorAll('.del-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.dataset.id;
                if (confirm("Permanently deactivate this student record?")) {
                    const token = localStorage.getItem('erp-token');
                    await fetch(`${API_BASE_URL}${STUDENTS_API_ENDPOINT}/${id}`, { 
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    loadStudents();
                }
            });
        });
    }

    function populateCourseFilter(courses) {
        if (!courseFilter) return;
        courseFilter.innerHTML = '<option value="">All Courses</option>';
        courses.forEach(c => {
            courseFilter.innerHTML += `<option value="${c.course_id}">${c.course_name}</option>`;
        });
    }

    function handleSort(column) {
        currentSortDirection = (currentSortColumn === column && currentSortDirection === 'asc') ? 'desc' : 'asc';
        currentSortColumn = column;
        renderTable();
    }

    function handleSelectAll(e) {
        const isChecked = e.target.checked;
        document.querySelectorAll('.student-chk').forEach(chk => {
            chk.checked = isChecked;
            isChecked ? selectedStudentIds.add(chk.value) : selectedStudentIds.delete(chk.value);
        });
        if (bulkIdBtn) bulkIdBtn.disabled = selectedStudentIds.size === 0;
    }

    function handleBulkIdGeneration() {
        const ids = Array.from(selectedStudentIds);
        window.open(`bulk-id-card.html?ids=${ids.join(',')}`, '_blank');
    }

})();