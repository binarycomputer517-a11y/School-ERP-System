/**
 * students-list.js - FINAL ERP VERSION (SECURE MULTI-BRANCH)
<<<<<<< HEAD
 * Fixes: 15-Column Layout, Password Toggle, and User Table Integration.
=======
 * Fixed: branch_id=undefined bug and Auto-selection logic
>>>>>>> e74cb45f9cf0b7dfeaf3f71192b94ebcd52a8bee
 */

(function() {
    // -----------------------------------------------------------
    // --- 1. CONFIGURATION & STATE MANAGEMENT ---
    // -----------------------------------------------------------
    const API_BASE_URL = window.API_BASE_URL || '/api';
    const STUDENTS_API_ENDPOINT = '/students';
    const ACADEMICS_API_ENDPOINT = '/academicswithfees';
    const AUTH_ACTIVATE_ENDPOINT = '/auth/activate-student';
    const BRANCHES_API_ENDPOINT = '/branches';
    
    let allStudentsData = [];
    let selectedStudentIds = new Set(); 
    let currentSortColumn = 'admission_id';
    let currentSortDirection = 'asc';
    let targetUsernameForUnlock = ''; 
    let activeBranchFilter = ''; 

    const userRole = localStorage.getItem('user-role');
    const userBranchId = localStorage.getItem('user-branch-id'); 
    const activeBranchId = localStorage.getItem('active_branch_id'); 

    // --- DOM Elements ---
    const studentTableBody = document.getElementById('students-table-body');
    const searchInput = document.getElementById('search-input');
    const branchFilter = document.getElementById('branch-filter');
    const courseFilter = document.getElementById('course-filter');
    const statusFilter = document.getElementById('status-filter');
    const bulkIdBtn = document.getElementById('generate-bulk-id-btn');
    const selectAllCheckbox = document.getElementById('select-all-checkbox');
    const recordCountDisplay = document.getElementById('record-count');

    const unlockModalEl = document.getElementById('unlockModal');
    const confirmUnlockBtn = document.getElementById('confirm-unlock-btn');
    const targetStudentNameSpan = document.getElementById('target-student');

    // -----------------------------------------------------------
    // --- 2. INITIALIZATION ---
    // -----------------------------------------------------------
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        if (!studentTableBody) return; 

<<<<<<< HEAD
        activeBranchFilter = (userRole === 'Super Admin') ? (activeBranchId || '') : (userBranchId || '');

=======
        // 初期化: ড্রপডাউন থেকে ভ্যালু নেওয়ার আগে ডিফল্ট সেট করা
        activeBranchFilter = (userRole === 'Super Admin') ? (activeBranchId || '') : (userBranchId || '');

        // Event Listeners
>>>>>>> e74cb45f9cf0b7dfeaf3f71192b94ebcd52a8bee
        if (searchInput) searchInput.addEventListener('keyup', renderTable);
        if (courseFilter) courseFilter.addEventListener('change', renderTable);
        if (statusFilter) statusFilter.addEventListener('change', renderTable);
        
        if (branchFilter) {
            branchFilter.addEventListener('change', (e) => {
<<<<<<< HEAD
                activeBranchFilter = e.target.value; 
                loadStudents(); 
=======
                activeBranchFilter = e.target.value; // ড্রপডাউন থেকে আইডি আপডেট
                loadStudents(); // API রিলোড
>>>>>>> e74cb45f9cf0b7dfeaf3f71192b94ebcd52a8bee
            });
        }

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
    // --- 3. SECURE DATA FETCHING (Fixed Undefined Bug) ---
    // -----------------------------------------------------------
    async function loadStudents() {
        try {
            const token = localStorage.getItem('erp-token');
            const headers = { 'Authorization': `Bearer ${token}` };

<<<<<<< HEAD
=======
            // ব্রাঞ্চ সিলেকশন লজিক: নিশ্চিত করা হচ্ছে যেন branch_id কখনো undefined না হয়
>>>>>>> e74cb45f9cf0b7dfeaf3f71192b94ebcd52a8bee
            let targetBranch = activeBranchFilter;
            
            if (!targetBranch || targetBranch === 'undefined') {
                targetBranch = (userRole === 'Super Admin') ? activeBranchId : userBranchId;
            }
            
            const queryParams = (targetBranch && targetBranch !== 'null') ? `?branch_id=${targetBranch}` : '';

            const [studentsRes, coursesRes, branchesRes] = await Promise.all([
                fetch(`${API_BASE_URL}${STUDENTS_API_ENDPOINT}${queryParams}`, { headers }),
                fetch(`${API_BASE_URL}${ACADEMICS_API_ENDPOINT}/courses${queryParams}`, { headers }),
                (userRole === 'Super Admin') ? fetch(`${API_BASE_URL}${BRANCHES_API_ENDPOINT}`, { headers }) : Promise.resolve(null)
            ]);

            if (!studentsRes.ok) throw new Error("Unauthorized access or server timeout.");

            allStudentsData = await studentsRes.json();
            
<<<<<<< HEAD
=======
            // ফিল্টারগুলো পপুলেট করা
>>>>>>> e74cb45f9cf0b7dfeaf3f71192b94ebcd52a8bee
            if (branchesRes && branchesRes.ok) populateBranchFilter(await branchesRes.json());
            populateCourseFilter(await coursesRes.json());
            
            renderTable();
        } catch (error) {
            console.error("Critical Load Error:", error);
            studentTableBody.innerHTML = `<tr><td colspan="15" class="text-center text-danger py-4"><i class="fas fa-exclamation-triangle me-2"></i>Sync Error: ${error.message}</td></tr>`;
        }
    }

    // -----------------------------------------------------------
<<<<<<< HEAD
    // --- 4. RENDER LOGIC (15 COLUMNS WITH PASSWORD FIX) ---
=======
    // --- 4. RENDER LOGIC ---
>>>>>>> e74cb45f9cf0b7dfeaf3f71192b94ebcd52a8bee
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
<<<<<<< HEAD
        if (recordCountDisplay) recordCountDisplay.innerText = `Total Records: ${filtered.length}`;

        if (filtered.length === 0) {
            studentTableBody.innerHTML = `<tr><td colspan="15" class="text-center p-5 text-muted">No student records found.</td></tr>`;
=======
        if (recordCountDisplay) recordCountDisplay.innerText = `Records: ${filtered.length}`;

        if (filtered.length === 0) {
            studentTableBody.innerHTML = `<tr><td colspan="8" class="text-center p-4 text-muted">No records found.</td></tr>`;
>>>>>>> e74cb45f9cf0b7dfeaf3f71192b94ebcd52a8bee
            return;
        }

        filtered.forEach((student, index) => {
            const isRestricted = !student.is_paid || student.status === 'expired' || !student.is_active;
            const isChecked = selectedStudentIds.has(student.student_id.toString()) ? 'checked' : '';
            
            const statusBadge = isRestricted ? 
                `<span class="badge-status status-restricted"><i class="fas fa-lock me-1"></i>Restricted</span>` : 
                `<span class="badge-status status-active"><i class="fas fa-check-circle me-1"></i>Active</span>`;

            const unlockBtn = isRestricted ? 
                `<button class="btn btn-sm btn-success py-0 px-2 ms-1" style="font-size: 10px;" onclick="window.showUnlockModal('${student.username}')">Unlock</button>` : '';

            // Password handling for public.users.password_hash
            const displayPass = student.portal_password ? 
                `<span class="password-mask" id="pass-${student.student_id}">••••••••</span>
                 <i class="fas fa-eye-slash ms-1 text-muted cursor-pointer" style="font-size: 10px;" 
                 onclick="window.togglePassword(this, '${student.portal_password}', 'pass-${student.student_id}')"></i>` : 
                `<span class="text-muted italic">Not Set</span>`;

            const avatar = `<div class="avatar-circle">${(student.first_name || 'N').charAt(0)}</div>`;

            const row = `
                <tr class="student-row">
<<<<<<< HEAD
                    <td class="align-middle text-center">
                        <input class="form-check-input student-chk" type="checkbox" value="${student.student_id}" ${isChecked}>
                    </td>
                    <td class="align-middle text-center text-muted small">${index + 1}</td>
                    <td class="align-middle small fw-semibold text-truncate" style="max-width: 120px;">${student.branch_name || 'Main Campus'}</td>
                    <td class="align-middle"><code class="text-primary fw-bold" style="font-size: 11px;">${student.admission_id || student.username}</code></td>
                    <td class="align-middle small">${student.enrollment_no || '-'}</td>
                    <td class="align-middle small">${displayPass}</td>
                    <td class="align-middle">
                        <div class="d-flex align-items-center gap-2">
                            ${avatar}
                            <div class="fw-bold text-dark text-nowrap">${student.first_name} ${student.last_name || ''}</div>
=======
                    <td class="align-middle text-center"><input class="form-check-input student-chk" type="checkbox" value="${student.student_id}" ${isChecked}></td>
                    <td class="align-middle fw-bold text-indigo">${student.admission_id || '-'}</td>
                    <td class="align-middle">
                        <div class="d-flex align-items-center gap-2">
                            ${avatar}
                            <div>
                                <div class="fw-bold text-dark">${student.first_name} ${student.last_name || ''}</div>
                                <div class="small text-muted">@${student.username}</div>
                            </div>
>>>>>>> e74cb45f9cf0b7dfeaf3f71192b94ebcd52a8bee
                        </div>
                    </td>
                    <td class="align-middle small text-truncate" style="max-width: 130px;">${student.parent_first_name ? student.parent_first_name + ' ' + (student.parent_last_name || '') : '-'}</td>
                    <td class="align-middle small text-nowrap">${student.phone_number || '-'}</td>
                    <td class="align-middle small text-center">${student.course_code || '-'}</td>
                    <td class="align-middle text-end fw-bold text-danger">Rs. ${parseFloat(student.reg_fee || 0).toLocaleString()}</td>
                    <td class="align-middle text-center small">-</td>
                    <td class="align-middle small text-nowrap">${student.admission_date ? new Date(student.admission_date).toLocaleDateString('en-GB') : '-'}</td>
                    <td class="align-middle text-center">${statusBadge} ${unlockBtn}</td>
                    <td class="align-middle text-center">
<<<<<<< HEAD
                        <div class="d-flex justify-content-center gap-1">
                            <a class="btn btn-sm btn-outline-primary border-0" title="View" href="student-profile.html?id=${student.student_id}"><i class="fas fa-eye"></i></a>
                            <a class="btn btn-sm btn-outline-dark border-0" title="Edit" href="edit-student.html?id=${student.student_id}"><i class="fas fa-pen"></i></a>
                            <button class="btn btn-sm btn-outline-danger border-0 del-btn" title="Delete" data-id="${student.student_id}"><i class="fas fa-trash-alt"></i></button>
=======
                        <div class="d-flex justify-content-center gap-2">
                            <a class="btn btn-sm btn-outline-primary" href="student-profile.html?id=${student.student_id}"><i class="fas fa-eye"></i></a>
                            <a class="btn btn-sm btn-outline-dark" href="edit-student.html?id=${student.student_id}"><i class="fas fa-pen"></i></a>
                            <button class="btn btn-sm btn-outline-danger del-btn" data-id="${student.student_id}"><i class="fas fa-trash-alt"></i></button>
>>>>>>> e74cb45f9cf0b7dfeaf3f71192b94ebcd52a8bee
                        </div>
                    </td>
                </tr>`;
            studentTableBody.innerHTML += row;
        });
        
        attachDynamicListeners();
    }

    // -----------------------------------------------------------
<<<<<<< HEAD
    // --- 5. UTILITY & PASSWORD TOGGLE ---
    // -----------------------------------------------------------
    
    window.togglePassword = (icon, actualPassword, targetId) => {
        const target = document.getElementById(targetId);
        if (icon.classList.contains('fa-eye-slash')) {
            target.innerText = actualPassword.substring(0, 10) + '...'; // Show snippet of hash
            icon.classList.replace('fa-eye-slash', 'fa-eye');
            icon.classList.add('text-primary');
        } else {
            target.innerText = '••••••••';
            icon.classList.replace('fa-eye', 'fa-eye-slash');
            icon.classList.remove('text-primary');
        }
    };

    function populateBranchFilter(branches) {
        if (!branchFilter || branchFilter.options.length > 1) return;
        branches.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b.id; // Corrected to use ID from branches table
            opt.textContent = b.branch_name;
            if (b.id === activeBranchFilter) opt.selected = true;
=======
    // --- 5. UTILITY & FILTERS (Fixed Population) ---
    // -----------------------------------------------------------
    function populateBranchFilter(branches) {
        if (!branchFilter || branchFilter.options.length > 1) return;
        
        branches.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b.branch_id;
            opt.textContent = b.branch_name;
            // ডিফল্ট ব্রাঞ্চটি সিলেক্টেড রাখা
            if (b.branch_id === activeBranchFilter) opt.selected = true;
>>>>>>> e74cb45f9cf0b7dfeaf3f71192b94ebcd52a8bee
            branchFilter.appendChild(opt);
        });
    }

    function populateCourseFilter(courses) {
        if (!courseFilter) return;
<<<<<<< HEAD
        courseFilter.innerHTML = '<option value="">All Academic Courses</option>';
        courses.forEach(c => {
            courseFilter.innerHTML += `<option value="${c.id}">${c.course_name}</option>`;
        });
    }

=======
        courseFilter.innerHTML = '<option value="">All Courses</option>';
        courses.forEach(c => {
            courseFilter.innerHTML += `<option value="${c.course_id}">${c.course_name}</option>`;
        });
    }

    // --- Modal & Handlers (সংক্ষেপিত) ---
>>>>>>> e74cb45f9cf0b7dfeaf3f71192b94ebcd52a8bee
    window.showUnlockModal = (username) => {
        targetUsernameForUnlock = username;
        if (targetStudentNameSpan) targetStudentNameSpan.innerText = username;
        const modalInstance = new bootstrap.Modal(unlockModalEl);
        modalInstance.show();
    };

    async function processAccountUnlock() {
        if (!targetUsernameForUnlock) return;
        confirmUnlockBtn.disabled = true;
        confirmUnlockBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Processing...';
        
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
            } else {
<<<<<<< HEAD
                alert("Authorization Denied: Account activation failed.");
=======
                alert("Account activation failed.");
>>>>>>> e74cb45f9cf0b7dfeaf3f71192b94ebcd52a8bee
            }
        } catch (err) { 
            alert("Network Error: Could not reach server."); 
        } finally { 
            confirmUnlockBtn.disabled = false; 
            confirmUnlockBtn.innerText = 'Confirm & Grant Access';
        }
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
<<<<<<< HEAD
                if (confirm("DANGER: Permanently delete this student record? This erases all academic history.")) {
=======
                if (confirm("Delete this student record?")) {
>>>>>>> e74cb45f9cf0b7dfeaf3f71192b94ebcd52a8bee
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

    function handleSort(column) {
        currentSortDirection = (currentSortColumn === column && currentSortDirection === 'asc') ? 'desc' : 'asc';
        currentSortColumn = column;
        allStudentsData.sort((a, b) => {
            let valA = a[column] || '';
            let valB = b[column] || '';
            return currentSortDirection === 'asc' ? valA.toString().localeCompare(valB) : valB.toString().localeCompare(valA);
        });
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