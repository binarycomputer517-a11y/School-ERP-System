/**
 * Student List Management Script
 * Features: View Profile Redirect, Secure PDF Generation, Filtering & Bulk Actions
 */

(function() {
    'use strict';

    // =========================================================
    // 1. CONFIGURATION & STATE
    // =========================================================
    
    // API URL কনফিগারেশন
    const API_BASE_URL = window.API_BASE_URL || '/api';
    
    const ENDPOINTS = {
        STUDENTS: '/students',
        COURSES: '/academicswithfees/courses',
        BATCHES: '/academicswithfees/batches',
        REPORTS: '/reports'
    };

    // অ্যাপ্লিকেশনের স্টেট
    let state = {
        allStudents: [],
        filteredStudents: [],
        selectedIds: new Set(),
        sortConfig: { column: 'admission_id', direction: 'asc' }
    };

    // DOM এলিমেন্টস
    const UI = {
        tableBody: document.getElementById('students-table-body'),
        statusMsg: document.getElementById('data-status'),
        spinner: document.getElementById('loading-spinner'),
        searchInput: document.getElementById('search-input'),
        bulkBtn: document.getElementById('generate-bulk-id-btn'),
        filters: {
            course: document.getElementById('course-filter'),
            batch: document.getElementById('batch-filter'),
            status: document.getElementById('status-filter')
        }
    };

    // =========================================================
    // 2. API HANDLER (Secure & Blob Support)
    // =========================================================

    async function apiCall(endpoint, options = {}) {
        const token = localStorage.getItem('erp-token');
        if (!token) {
            window.location.href = '/login.html';
            return null;
        }

        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...options.headers
        };

        try {
            const response = await fetch(`${API_BASE_URL}${endpoint}`, { ...options, headers });

            // টোকেন এক্সপায়ার হলে
            if (response.status === 401 || response.status === 403) {
                alert('Session expired. Please login again.');
                window.location.href = '/login.html';
                return null;
            }

            if (!response.ok) throw new Error(`Server Error: ${response.status}`);

            // PDF/Image ডাউনলোডের জন্য Blob রিটার্ন করা
            if (options.responseType === 'blob') return await response.blob();

            return await response.json();

        } catch (error) {
            console.error('API Error:', error);
            throw error;
        }
    }

    // =========================================================
    // 3. INITIALIZATION
    // =========================================================

    document.addEventListener('DOMContentLoaded', async () => {
        setupEventListeners();
        await loadCourses();
        await fetchStudents();
    });

    function setupEventListeners() {
        // ফিল্টার লিসেনার
        UI.searchInput.addEventListener('input', handleFilterChange);
        UI.filters.status.addEventListener('change', handleFilterChange);
        UI.filters.batch.addEventListener('change', handleFilterChange);
        
        // কোর্স চেঞ্জ হলে ব্যাচ লোড হবে
        UI.filters.course.addEventListener('change', async (e) => {
            await loadBatches(e.target.value);
            handleFilterChange();
        });

        // সর্টিং লিসেনার
        document.querySelectorAll('th[data-sort]').forEach(th => {
            th.addEventListener('click', () => handleSort(th.dataset.sort));
        });

        // বাল্ক অ্যাকশন বাটন
        if (UI.bulkBtn) {
            UI.bulkBtn.addEventListener('click', handleBulkGenerate);
            UI.bulkBtn.disabled = true;
        }
    }

    // =========================================================
    // 4. DATA FETCHING
    // =========================================================

    async function loadCourses() {
        try {
            const courses = await apiCall(ENDPOINTS.COURSES);
            if (courses) {
                courses.forEach(c => {
                    UI.filters.course.innerHTML += `<option value="${c.course_id}">${c.course_name}</option>`;
                });
            }
        } catch (e) { console.error('Error loading courses'); }
    }

    async function loadBatches(courseId) {
        UI.filters.batch.innerHTML = '<option value="">Filter by Batch (All)</option>';
        UI.filters.batch.disabled = true;
        if (!courseId) return;

        try {
            const batches = await apiCall(`${ENDPOINTS.BATCHES}/${courseId}`);
            if (batches && batches.length > 0) {
                batches.forEach(b => {
                    UI.filters.batch.innerHTML += `<option value="${b.batch_id}">${b.batch_name}</option>`;
                });
                UI.filters.batch.disabled = false;
            }
        } catch (e) { console.error('Error loading batches'); }
    }

    async function fetchStudents() {
        showLoading(true);
        try {
            const data = await apiCall(ENDPOINTS.STUDENTS);
            state.allStudents = data || [];
            state.filteredStudents = [...state.allStudents];
            applyFilters();
        } catch (error) {
            UI.statusMsg.innerText = "Error loading data.";
            UI.tableBody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Connection Failed.</td></tr>`;
        } finally {
            showLoading(false);
        }
    }

    // =========================================================
    // 5. FILTERING & RENDER
    // =========================================================

    function handleFilterChange() {
        applyFilters();
        renderTable();
    }

    function applyFilters() {
        const search = UI.searchInput.value.toLowerCase();
        const course = UI.filters.course.value;
        const batch = UI.filters.batch.value;
        const status = UI.filters.status.value;

        state.filteredStudents = state.allStudents.filter(s => {
            const matchesSearch = 
                (s.first_name || '').toLowerCase().includes(search) ||
                (s.last_name || '').toLowerCase().includes(search) ||
                (s.admission_id || '').toLowerCase().includes(search) ||
                (s.email || '').toLowerCase().includes(search);
            
            return matchesSearch &&
                   (!course || s.course_id == course) &&
                   (!batch || s.batch_id == batch) &&
                   (!status || s.status === status);
        });
        sortData();
    }

    function sortData() {
        const { column, direction } = state.sortConfig;
        state.filteredStudents.sort((a, b) => {
            let valA = (a[column] || '').toString().toLowerCase();
            let valB = (b[column] || '').toString().toLowerCase();
            if (valA < valB) return direction === 'asc' ? -1 : 1;
            if (valA > valB) return direction === 'asc' ? 1 : -1;
            return 0;
        });
    }

    function renderTable() {
        UI.tableBody.innerHTML = '';
        UI.statusMsg.innerText = `Showing ${state.filteredStudents.length} records`;

        if (state.filteredStudents.length === 0) {
            UI.tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:20px;">No students found.</td></tr>`;
            return;
        }

        const fragment = document.createDocumentFragment();
        state.filteredStudents.forEach((student, index) => {
            const tr = document.createElement('tr');
            
            // ফিস ফরম্যাটিং
            const fees = student.total_fees_due ? `₹${parseFloat(student.total_fees_due).toFixed(2)}` : 'N/A';
            const isChecked = state.selectedIds.has(student.student_id);
            const statusClass = (student.status || 'pending').toLowerCase();

            tr.innerHTML = `
                <td>
                    ${index + 1} <input type="checkbox" class="student-select-checkbox" value="${student.student_id}" ${isChecked ? 'checked' : ''} style="margin-left:5px;">
                </td>
                <td><strong>${student.admission_id}</strong></td>
                <td>${student.first_name} ${student.last_name}</td>
                <td>
                    <div class="course-info">
                        <span class="course-name">${student.course_name || '-'} (${student.batch_name || '-'})</span>
                        <span class="fees-label">Due: ${fees}</span>
                    </div>
                </td>
                <td>${student.email}<br><small style="color:#666">${student.phone_number || ''}</small></td>
                <td><span class="status-badge status-${statusClass}">${student.status || 'Pending'}</span></td>
                <td class="action-cell">
                    <button class="action-link view-btn" style="border:none; background:none; cursor:pointer;" onclick="window.ERP_Actions.view('${student.student_id}')">View</button>
                    <button class="action-link id-btn" style="border:none; background:none; cursor:pointer;" onclick="window.ERP_Actions.generateId('${student.student_id}')">ID Card</button>
                    <span class="action-link delete-link" style="cursor:pointer;" onclick="window.ERP_Actions.delete('${student.student_id}', '${student.first_name}')">Delete</span>
                    <a href="/edit-student.html?id=${student.student_id}" class="action-link">Edit</a>
                </td>
            `;
            
            // চেকবক্স ইভেন্ট হ্যান্ডলার
            tr.querySelector('.student-select-checkbox').addEventListener('change', (e) => toggleSelection(e.target.value, e.target.checked));
            fragment.appendChild(tr);
        });
        UI.tableBody.appendChild(fragment);
        updateBulkButtonState();
    }

    // =========================================================
    // 6. ACTIONS (Global Scope - Window)
    // =========================================================

    window.ERP_Actions = {
        
        // --- 1. View Profile (NEW UPDATE) ---
        view: (id) => {
            // এই লাইনটি পেজ রিডাইরেক্ট করবে
            window.location.href = `/student-profile.html?id=${id}`;
        },

        // --- 2. Generate Single ID (FIXED BLOB) ---
        generateId: async (id) => {
            if (!confirm('Generate ID Card?')) return;
            document.body.style.cursor = 'wait';
            try {
                // Blob হিসেবে রেসপন্স আনা হচ্ছে (Secure way)
                const blob = await apiCall(`${ENDPOINTS.REPORTS}/generate-id?studentId=${id}`, { responseType: 'blob' });
                if (blob) {
                    const url = window.URL.createObjectURL(blob);
                    window.open(url, '_blank');
                }
            } catch (error) { alert('Failed to generate ID.'); } 
            finally { document.body.style.cursor = 'default'; }
        },

        // --- 3. Delete Student ---
        delete: async (id, name) => {
            if (!confirm(`Are you sure you want to delete ${name}?`)) return;
            try {
                await apiCall(`${ENDPOINTS.STUDENTS}/${id}`, { method: 'DELETE' });
                // লোকাল স্টেট আপডেট
                state.allStudents = state.allStudents.filter(s => s.student_id !== id);
                state.selectedIds.delete(id);
                handleFilterChange();
                alert('Student deleted successfully.');
            } catch (error) { alert('Failed to delete student.'); }
        }
    };

    // =========================================================
    // 7. BULK ACTIONS & UTILS
    // =========================================================

    async function handleBulkGenerate() {
        const ids = Array.from(state.selectedIds);
        if (ids.length === 0) return;
        if (!confirm(`Generate ID Cards for ${ids.length} selected students?`)) return;

        UI.bulkBtn.textContent = "Processing...";
        UI.bulkBtn.disabled = true;

        try {
            const blob = await apiCall(`${ENDPOINTS.REPORTS}/generate-bulk-id?studentIds=${ids.join(',')}`, { responseType: 'blob' });
            if (blob) {
                const url = window.URL.createObjectURL(blob);
                window.open(url, '_blank');
                state.selectedIds.clear();
                handleFilterChange();
            }
        } catch (e) { alert('Bulk generation failed.'); } 
        finally {
            UI.bulkBtn.textContent = "💳 Generate ID Cards (Selected)";
            updateBulkButtonState();
        }
    }

    function toggleSelection(id, isChecked) {
        if (isChecked) state.selectedIds.add(id);
        else state.selectedIds.delete(id);
        updateBulkButtonState();
    }

    function updateBulkButtonState() {
        if (!UI.bulkBtn) return;
        const count = state.selectedIds.size;
        UI.bulkBtn.innerText = `💳 Generate ID Cards (${count})`;
        UI.bulkBtn.disabled = count === 0;
    }

    function showLoading(isLoading) {
        if (UI.spinner) UI.spinner.style.display = isLoading ? 'block' : 'none';
        if (UI.tableBody) UI.tableBody.style.opacity = isLoading ? '0.5' : '1';
    }

})();