/**
 * students-list.js
 * Comprehensive logic for managing student records.
 * Features: Fetch, Sort, Filter, Bulk Actions, and ID Card Routing.
 */

(function() {
    // -----------------------------------------------------------
    // --- 1. CONFIGURATION & STATE ---
    // -----------------------------------------------------------
    const API_BASE_URL = window.API_BASE_URL || '/api';
    const STUDENTS_API_ENDPOINT = '/students';
    const ACADEMICS_API_ENDPOINT = '/academicswithfees';
    
    let allStudentsData = [];
    let selectedStudentIds = new Set(); 
    let currentSortColumn = 'admission_id';
    let currentSortDirection = 'asc';
    
    // --- DOM Elements ---
    const studentTableBody = document.getElementById('students-table-body');
    const dataStatus = document.getElementById('data-status');
    const searchInput = document.getElementById('search-input');
    const courseFilter = document.getElementById('course-filter');
    const batchFilter = document.getElementById('batch-filter');
    const statusFilter = document.getElementById('status-filter');
    const loadingSpinner = document.getElementById('loading-spinner');
    const bulkIdBtn = document.getElementById('generate-bulk-id-btn');
    const selectAllCheckbox = document.getElementById('select-all-checkbox');


    // -----------------------------------------------------------
    // --- 2. API HANDLER (Centralized) ---
    // -----------------------------------------------------------

    async function handleApi(endpoint, options = {}) {
        const AUTH_TOKEN = localStorage.getItem('erp-token');
        
        const headers = { 
            'Content-Type': 'application/json', 
            'Authorization': `Bearer ${AUTH_TOKEN}`
        };
        
        options.method = options.method || 'GET';
        
        try {
            const response = await fetch(`${API_BASE_URL}${endpoint}`, { ...options, headers });

            if (response.status === 401 || response.status === 403) {
                console.warn('Session expired. Redirecting...');
                window.location.href = '/login.html';
                throw new Error('Unauthorized access.');
            }
            
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || `Server Error: ${response.status}`);
            }
            
            return response;
        } catch (error) {
            console.error(`API Request Failed:`, error);
            throw error;
        }
    }


    // -----------------------------------------------------------
    // --- 3. INITIALIZATION ---
    // -----------------------------------------------------------

    document.addEventListener('DOMContentLoaded', init);

    function init() {
        if (!studentTableBody) return; 

        // Attach Listeners
        searchInput.addEventListener('keyup', renderTable);
        courseFilter.addEventListener('change', handleCourseChange);
        batchFilter.addEventListener('change', renderTable);
        statusFilter.addEventListener('change', renderTable);

        if (bulkIdBtn) {
            bulkIdBtn.addEventListener('click', handleBulkIdGeneration);
            bulkIdBtn.disabled = true; 
        }

        if (selectAllCheckbox) {
            selectAllCheckbox.addEventListener('change', handleSelectAll);
        }
        
        // Sorting Headers
        document.querySelectorAll('th[data-sort]').forEach(header => {
            header.addEventListener('click', () => handleSort(header.dataset.sort));
            header.style.cursor = 'pointer'; 
        });

        // Initial Data Load
        loadStudents();
    }

    async function loadStudents() {
        if (dataStatus) dataStatus.textContent = 'Loading records...';
        if (loadingSpinner) loadingSpinner.style.display = 'block';

        try {
            // Parallel Fetch
            const [studentsRes, coursesRes] = await Promise.all([
                handleApi(STUDENTS_API_ENDPOINT),
                handleApi(`${ACADEMICS_API_ENDPOINT}/courses`)
            ]);

            allStudentsData = await studentsRes.json();
            const courses = await coursesRes.json();
            
            populateCourseFilter(courses);
            renderTable();

        } catch (error) {
            if (dataStatus) {
                dataStatus.innerHTML = `<span class="text-danger"><i class="fas fa-exclamation-triangle"></i> Error: ${error.message}</span>`;
            }
            studentTableBody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">Failed to load data. Please refresh.</td></tr>`;
        } finally {
            if (loadingSpinner) loadingSpinner.style.display = 'none';
        }
    }
    
    function populateCourseFilter(courses) {
        courseFilter.innerHTML = '<option value="">Filter by Course (All)</option>';
        courses.forEach(c => {
            courseFilter.innerHTML += `<option value="${c.course_id}">${c.course_name}</option>`;
        });
        courseFilter.disabled = false;
    }

    async function handleCourseChange(event) {
        const courseId = event.target.value;
        batchFilter.innerHTML = '<option value="">Loading...</option>';
        batchFilter.disabled = true;

        if (!courseId) {
            batchFilter.innerHTML = '<option value="">Filter by Batch (All)</option>';
            renderTable();
            return;
        }

        try {
            const res = await handleApi(`${ACADEMICS_API_ENDPOINT}/batches/${courseId}`);
            const batches = await res.json();

            batchFilter.innerHTML = '<option value="">Filter by Batch (All)</option>';
            if (batches.length > 0) {
                batches.forEach(b => {
                    batchFilter.innerHTML += `<option value="${b.batch_id}">${b.batch_name}</option>`;
                });
                batchFilter.disabled = false;
            } else {
                batchFilter.innerHTML = '<option value="">No batches found</option>';
            }
        } catch (error) {
            console.error(error);
            batchFilter.innerHTML = '<option value="">Error loading batches</option>';
        }
        renderTable();
    }


    // -----------------------------------------------------------
    // --- 4. RENDER & LOGIC (Updated for Small Picture/Avatar) ---
    // -----------------------------------------------------------

    function getFilteredAndSortedData() {
        const term = searchInput.value.toLowerCase();
        const course = courseFilter.value;
        const batch = batchFilter.value;
        const status = statusFilter.value;

        // 1. Filter
        let data = allStudentsData.filter(s => {
            const name = (s.first_name + ' ' + s.last_name).toLowerCase();
            const id = (s.admission_id || '').toString().toLowerCase();
            const phone = (s.phone_number || '').toString();
            const email = (s.email || '').toLowerCase();

            const matchesSearch = !term || name.includes(term) || id.includes(term) || phone.includes(term) || email.includes(term);
            const matchesCourse = !course || s.course_id == course;
            const matchesBatch = !batch || s.batch_id == batch;
            const matchesStatus = !status || s.status === status;

            return matchesSearch && matchesCourse && matchesBatch && matchesStatus;
        });

        // 2. Sort
        return data.sort((a, b) => {
            const aVal = (a[currentSortColumn] || '').toString().toLowerCase();
            const bVal = (b[currentSortColumn] || '').toString().toLowerCase();

            if (aVal < bVal) return currentSortDirection === 'asc' ? -1 : 1;
            if (aVal > bVal) return currentSortDirection === 'asc' ? 1 : -1;
            return 0;
        });
    }

    function renderTable() {
        const data = getFilteredAndSortedData();
        studentTableBody.innerHTML = '';
        
        if (dataStatus) {
            dataStatus.innerHTML = `Showing <strong>${data.length}</strong> record(s)`;
            dataStatus.style.color = '#333';
        }

        if(selectAllCheckbox) selectAllCheckbox.checked = false;

        if (data.length === 0) {
            studentTableBody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-muted">No students found.</td></tr>`;
            return;
        }

        data.forEach(student => {
            const isChecked = selectedStudentIds.has(student.student_id.toString()) ? 'checked' : '';
            
            // Payment Logic
            let paymentBadge = `<span class="badge bg-success"><i class="fas fa-check-circle"></i> Paid</span>`;
            if (student.total_fees_due > 0) {
                paymentBadge = `<span class="badge bg-danger">Due: ₹${parseFloat(student.total_fees_due).toFixed(2)}</span>`;
            }

            // --- AVATAR LOGIC (Small Picture Based) ---
            let avatar = `<div class="avatar-circle bg-light text-secondary d-flex align-items-center justify-content-center fw-bold border" style="width:40px;height:40px;border-radius:50%;font-size:16px;">${(student.first_name || 'N').charAt(0)}</div>`;
            if (student.profile_image) {
                let imgUrl = student.profile_image.startsWith('http') ? student.profile_image : `${API_BASE_URL}/${student.profile_image}`;
                avatar = `<img src="${imgUrl}" class="rounded-circle border" style="width:40px;height:40px;object-fit:cover;">`;
            }
            // --- END AVATAR LOGIC ---
            
            // --- ACTION CELL HTML (Inline Icon Only) ---
            const actionCellHtml = `
                <td class="align-middle action-cell">
                    <a class="action-link view-btn" href="student-profile.html?id=${student.student_id}" title="View Profile"><i class="fas fa-eye"></i></a>
                    <a class="action-link edit-btn" href="edit-student.html?id=${student.student_id}" title="Edit Details"><i class="fas fa-pen"></i></a>
                    <a class="action-link print-btn" href="id-card.html?id=${student.student_id}" target="_blank" title="Print ID Card"><i class="fas fa-id-badge"></i></a>
                    <a class="action-link delete-btn del-btn" href="#" data-id="${student.student_id}" title="Delete Record"><i class="fas fa-trash-alt"></i></a>
                </td>
            `;
            // --- END ACTION CELL HTML ---


            const row = `
                <tr>
                    <td class="align-middle">
                        <div class="form-check">
                            <input class="form-check-input student-chk" type="checkbox" value="${student.student_id}" ${isChecked}>
                        </div>
                    </td>
                    <td class="align-middle fw-bold text-primary">${student.admission_id || '-'}</td>
                    <td class="align-middle">
                        <div class="d-flex align-items-center gap-3">
                            ${avatar}
                            <div>
                                <div class="fw-bold text-dark">${student.first_name} ${student.last_name}</div>
                                <div class="small text-muted"><i class="fas fa-envelope me-1"></i>${student.email || ''}</div>
                            </div>
                        </div>
                    </td>
                    <td class="align-middle">
                        <span class="badge bg-light text-dark border mb-1">${student.course_name || '-'}</span>
                        <div class="small text-muted"><i class="fas fa-layer-group me-1"></i>${student.batch_name || '-'}</div>
                    </td>
                    <td class="align-middle">${student.phone_number || '-'}</td>
                    <td class="align-middle">${paymentBadge}</td>
                    <td class="align-middle">
                        <span class="badge bg-${getStatusColor(student.status)} text-uppercase">${student.status || 'Active'}</span>
                    </td>
                    ${actionCellHtml}
                </tr>
            `;
            studentTableBody.innerHTML += row;
        });
        
        attachRowListeners();
    }

    function getStatusColor(status) {
        if (!status) return 'secondary';
        const s = status.toLowerCase();
        if (s === 'active' || s === 'enrolled') return 'success';
        if (s === 'inactive' || s === 'left') return 'secondary';
        if (s === 'suspended') return 'danger';
        return 'warning';
    }

    function attachRowListeners() {
        // Checkboxes
        document.querySelectorAll('.student-chk').forEach(el => {
            el.addEventListener('change', (e) => {
                const id = e.target.value;
                e.target.checked ? selectedStudentIds.add(id) : selectedStudentIds.delete(id);
                updateBulkButton();
            });
        });

        // Delete Buttons (Now targets the inline 'del-btn' link)
        document.querySelectorAll('.del-btn').forEach(el => {
            el.addEventListener('click', async (e) => {
                e.preventDefault();
                // Get data-id from the link element itself
                const id = e.currentTarget.dataset.id; 
                if(confirm("Are you sure? This will deactivate the student.")) {
                    try {
                        await handleApi(`${STUDENTS_API_ENDPOINT}/${id}`, { method: 'DELETE' });
                        allStudentsData = allStudentsData.filter(s => s.student_id != id);
                        selectedStudentIds.delete(id);
                        renderTable();
                        updateBulkButton();
                        // Optional: Show toast
                    } catch(err) { alert(err.message); }
                }
            });
        });
    }

    // -----------------------------------------------------------
    // --- 5. HELPERS ---
    // -----------------------------------------------------------

    function handleSort(column) {
        if (currentSortColumn === column) {
            currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            currentSortColumn = column;
            currentSortDirection = 'asc';
        }
        renderTable();
    }

    function handleSelectAll(e) {
        const isChecked = e.target.checked;
        const visibleChecks = document.querySelectorAll('.student-chk');
        visibleChecks.forEach(chk => {
            chk.checked = isChecked;
            isChecked ? selectedStudentIds.add(chk.value) : selectedStudentIds.delete(chk.value);
        });
        updateBulkButton();
    }

    function updateBulkButton() {
        const count = selectedStudentIds.size;
        if (bulkIdBtn) {
            bulkIdBtn.innerHTML = `<i class="fas fa-id-card me-2"></i> Generate ID Cards (${count})`;
            bulkIdBtn.disabled = count === 0;
            // The class name update relies on existing CSS classes for styling
        }
    }

    // --- SMART BULK GENERATION LOGIC ---
    function handleBulkIdGeneration() {
        if (selectedStudentIds.size === 0) return;
        
        const idsArray = Array.from(selectedStudentIds);
        
        if (confirm(`Generate ID Cards for ${idsArray.length} selected student(s)?`)) {
            if (idsArray.length === 1) {
                // Single Student -> Single Card View
                window.open(`id-card.html?id=${idsArray[0]}`, '_blank');
            } else {
                // Multiple Students -> Bulk Sheet View
                const url = `bulk-id-card.html?ids=${idsArray.join(',')}`;
                window.open(url, '_blank');
            }
        }
    }

})();