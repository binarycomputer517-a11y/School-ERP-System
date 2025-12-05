/**
 * students-list.js
 * Manages fetching, filtering, sorting, and rendering the student records table
 * including enhanced features for bulk actions (ID Card Generation) and quick view.
 *
 * NOTE: Assumes backend GET /api/students returns joined fields like course_name, batch_name, and total_fees_due.
 */

(function() {
    // -----------------------------------------------------------
    // --- 1. Global Configuration and State ---
    // -----------------------------------------------------------
    const API_BASE_URL = window.API_BASE_URL || '/api';
    const STUDENTS_API_ENDPOINT = '/students';
    const ACADEMICS_API_ENDPOINT = '/academicswithfees';
    
    let allStudentsData = [];
    let selectedStudentIds = new Set(); // Tracks IDs for bulk actions
    let currentSortColumn = 'admission_id';
    let currentSortDirection = 'asc';
    
    // --- DOM Elements (Fetched globally on initialization) ---
    const studentTableBody = document.getElementById('students-table-body');
    const dataStatus = document.getElementById('data-status');
    const searchInput = document.getElementById('search-input');
    const courseFilter = document.getElementById('course-filter');
    const batchFilter = document.getElementById('batch-filter');
    const statusFilter = document.getElementById('status-filter');
    const loadingSpinner = document.getElementById('loading-spinner');
    const bulkIdBtn = document.getElementById('generate-bulk-id-btn');


    // -----------------------------------------------------------
    // --- 2. CORE API HANDLER (Reusable) ---
    // -----------------------------------------------------------

    async function handleApi(endpoint, options = {}) {
        const AUTH_TOKEN = localStorage.getItem('erp-token');
        const headers = { 
            'Content-Type': 'application/json', 
            'Authorization': `Bearer ${AUTH_TOKEN}`
        };
        options.method = options.method || 'GET';
        
        const url = `${API_BASE_URL}${endpoint}`;
        const response = await fetch(url, { ...options, headers });

        if (response.status === 401 || response.status === 403) {
            console.error('API Unauthorized or Forbidden:', url);
            alert('Session expired or unauthorized. Please log in again.');
            throw new Error('Unauthorized access.');
        }
        
        if (!response.ok) {
            let errorData = await response.json().catch(() => null);
            throw new Error(`Server error: ${response.status}. ${errorData?.message || 'Unknown error'}`);
        }
        
        return response; 
    }


    // -----------------------------------------------------------
    // --- 3. DATA FETCHING AND INITIALIZATION ---
    // -----------------------------------------------------------

    document.addEventListener('DOMContentLoaded', initializeStudentList);

    function initializeStudentList() {
        if (!studentTableBody) return; 

        // Attach event listeners for filtering and searching
        searchInput.addEventListener('keyup', renderTable);
        courseFilter.addEventListener('change', handleCourseFilterChange);
        batchFilter.addEventListener('change', renderTable);
        statusFilter.addEventListener('change', renderTable);
        
        // Attach bulk actions and selection handlers
        if (bulkIdBtn) bulkIdBtn.addEventListener('click', handleBulkIdGeneration);
        
        // Attach sorting handlers to table headers
        document.querySelectorAll('#students-table th[data-sort]').forEach(header => {
            header.addEventListener('click', () => handleSort(header.dataset.sort));
        });
        
        // Load all data
        fetchStudentList();
    }

    async function fetchStudentList() {
        if (dataStatus) dataStatus.textContent = 'Loading student records...';
        if (loadingSpinner) loadingSpinner.style.display = 'block';

        try {
            const studentsResponse = await handleApi(STUDENTS_API_ENDPOINT);
            allStudentsData = await studentsResponse.json();
            
            await populateFilterDropdowns();

            renderTable();

        } catch (error) {
            console.error("Failed to load student data:", error);
            if (dataStatus) dataStatus.textContent = `❌ Error loading data: ${error.message}`;
            studentTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center;">Failed to load records.</td></tr>`;
        } finally {
            if (loadingSpinner) loadingSpinner.style.display = 'none';
        }
    }
    
    // --- Filter Dropdown Population ---
    async function populateFilterDropdowns() {
        try {
            const courseResponse = await handleApi(`${ACADEMICS_API_ENDPOINT}/courses`);
            const courses = await courseResponse.json();
            
            courseFilter.innerHTML = '<option value="">Filter by Course (All)</option>';
            courses.forEach(c => {
                courseFilter.innerHTML += `<option value="${c.course_id}">${c.course_name}</option>`;
            });
            courseFilter.disabled = false;

        } catch (error) {
            console.error('Failed to populate courses for filters:', error);
            courseFilter.innerHTML = '<option value="">Error loading courses</option>';
        }
    }

    async function handleCourseFilterChange(event) {
        const courseId = event.target.value;
        batchFilter.innerHTML = '<option value="">Loading batches...</option>';
        batchFilter.disabled = true;

        if (!courseId) {
            batchFilter.innerHTML = '<option value="">Filter by Batch (All)</option>';
            renderTable();
            return;
        }

        try {
            const response = await handleApi(`${ACADEMICS_API_ENDPOINT}/batches/${courseId}`);
            const batches = await response.json();

            batchFilter.innerHTML = '<option value="">Filter by Batch (All)</option>';
            if (Array.isArray(batches) && batches.length > 0) {
                batches.forEach(b => {
                    batchFilter.innerHTML += `<option value="${b.batch_id}">${b.batch_name}</option>`;
                });
                batchFilter.disabled = false;
            } else {
                batchFilter.innerHTML = '<option value="">No batches found</option>';
            }
        } catch (error) {
            console.error('Failed to load batches for filter:', error);
            batchFilter.innerHTML = '<option value="">Error loading batches</option>';
        }
        renderTable();
    }


    // -----------------------------------------------------------
    // --- 4. FILTERING, SORTING, AND RENDERING ---
    // -----------------------------------------------------------

    function applyFiltersAndSearch(data) {
        const searchTerm = searchInput.value.toLowerCase();
        const selectedCourse = courseFilter.value;
        const selectedBatch = batchFilter.value;
        const selectedStatus = statusFilter.value;

        return data.filter(student => {
            // Search filter
            const matchesSearch = !searchTerm || 
                                  student.first_name.toLowerCase().includes(searchTerm) || 
                                  student.last_name.toLowerCase().includes(searchTerm) ||
                                  student.admission_id.toLowerCase().includes(searchTerm) ||
                                  student.email.toLowerCase().includes(searchTerm);

            // Course filter
            const matchesCourse = !selectedCourse || student.course_id === selectedCourse;

            // Batch filter
            const matchesBatch = !selectedBatch || student.batch_id === selectedBatch;

            // Status filter
            const matchesStatus = !selectedStatus || student.status === selectedStatus;

            return matchesSearch && matchesCourse && matchesBatch && matchesStatus;
        });
    }

    function sortData(data) {
        return data.sort((a, b) => {
            const aVal = a[currentSortColumn] || '';
            const bVal = b[currentSortColumn] || '';

            if (aVal < bVal) return currentSortDirection === 'asc' ? -1 : 1;
            if (aVal > bVal) return currentSortDirection === 'asc' ? 1 : -1;
            return 0;
        });
    }

    function handleSort(column) {
        if (currentSortColumn === column) {
            currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            currentSortColumn = column;
            currentSortDirection = 'asc';
        }
        renderTable();
    }
    
    function handleSelectionChange(event) {
        const studentId = event.target.value;
        if (event.target.checked) {
            selectedStudentIds.add(studentId);
        } else {
            selectedStudentIds.delete(studentId);
        }
        // Optionally update the bulk button text here
        if (bulkIdBtn) {
            bulkIdBtn.textContent = `💳 Generate ID Cards (${selectedStudentIds.size})`;
            bulkIdBtn.disabled = selectedStudentIds.size === 0;
        }
    }

    function renderTable() {
        let filteredData = applyFiltersAndSearch(allStudentsData);
        let sortedData = sortData(filteredData);

        if (studentTableBody) studentTableBody.innerHTML = '';
        
        if (dataStatus) {
            dataStatus.textContent = `Showing ${sortedData.length} of ${allStudentsData.length} records.`;
            dataStatus.style.color = sortedData.length > 0 ? '#155724' : '#721c24';
        }

        if (sortedData.length === 0) {
            if (studentTableBody) {
                studentTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center;">No students match the current criteria.</td></tr>`;
            }
            if (bulkIdBtn) bulkIdBtn.disabled = true;
            return;
        }

        sortedData.forEach(student => {
            const statusClass = student.status ? `status-${student.status.toLowerCase()}` : 'status-pending';
            const isSelected = selectedStudentIds.has(student.student_id);

            // Format Fees: Use 'total_fees_due'
            const feesDue = student.total_fees_due 
                            ? `₹${parseFloat(student.total_fees_due).toFixed(2)}` 
                            : 'N/A';
                            
            const loginContactCell = `
                ${student.email} / <span style="font-size: 0.85em;">${student.phone_number || 'N/A'}</span>
            `;
            
            // Construct the Course/Fees cell
            const courseFeesCell = `
                <div class="course-info">
                    <span class="course-name">${student.course_name || 'N/A'} - ${student.batch_name || 'N/A'}</span>
                    <span class="fees-label">Fees: ${feesDue}</span> 
                </div>
            `;

            const row = `
                <tr>
                    <td>
                        <input type="checkbox" value="${student.student_id}" ${isSelected ? 'checked' : ''} class="student-select-checkbox">
                    </td>
                    <td>${student.admission_id}</td>
                    <td>${student.first_name} ${student.last_name}</td>
                    <td>${courseFeesCell}</td> 
                    <td>${loginContactCell}</td>
                    <td><span class="status-badge ${statusClass}">${student.status || 'Pending'}</span></td>
                    <td class="action-cell">
                        <span class="action-link view-btn" onclick="handleQuickView('${student.student_id}', '${student.first_name}')">View</span>
                        <a href="/edit-student.html?id=${student.student_id}" class="action-link">Edit</a>
                        <span class="action-link delete-link" data-id="${student.student_id}" data-name="${student.first_name}">Delete</span>
                        <a href="#" class="action-link id-btn" onclick="handleGenerateId('${student.student_id}')">ID Card</a>
                    </td>
                </tr>
            `;
            if (studentTableBody) studentTableBody.innerHTML += row;
        });
        
        // Attach post-render handlers
        document.querySelectorAll('.delete-link').forEach(link => {
            link.addEventListener('click', handleDeleteClick);
        });
        document.querySelectorAll('.student-select-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', handleSelectionChange);
        });
        
        // Update the bulk button state after rendering all rows
        if (bulkIdBtn) {
            bulkIdBtn.textContent = `💳 Generate ID Cards (${selectedStudentIds.size})`;
            bulkIdBtn.disabled = selectedStudentIds.size === 0;
        }
    }


    // -----------------------------------------------------------
    // --- 5. ACTION HANDLERS (Delete, Quick View, ID Card) ---
    // -----------------------------------------------------------

    // Global function for Quick View (accessible via inline HTML)
    window.handleQuickView = (studentId, studentName) => {
        // Conceptual Quick View - would open a modal fetching detailed data
        alert(`Quick View Requested for ${studentName} (ID: ${studentId}).\nModal implementation required to fetch full profile details.`);
        // A real implementation would launch a modal here.
    };

    // Global function for Individual ID Card Generation (accessible via inline HTML)
    window.handleGenerateId = (studentId) => {
        // Conceptual ID Generation - would typically open a new tab with a report/PDF API link
        const apiPath = `${API_BASE_URL}/reports/generate-id?studentId=${studentId}`;
        alert(`Generating ID Card for ${studentId}. Opening new tab with path: ${apiPath}`);
        // window.open(apiPath, '_blank');
    };

    function handleBulkIdGeneration() {
        if (selectedStudentIds.size === 0) {
            alert("Please select at least one student to generate ID cards.");
            return;
        }
        
        const idsArray = Array.from(selectedStudentIds);
        const apiPath = `${API_BASE_URL}/reports/generate-bulk-id?studentIds=${idsArray.join(',')}`;
        
        if (confirm(`Generate ID Cards for ${idsArray.length} students?`)) {
            alert(`Initiating Bulk ID Generation. Opening new tab with path: ${apiPath}`);
            // window.open(apiPath, '_blank');
            selectedStudentIds.clear(); // Clear selection after initiating bulk action
            renderTable();
        }
    }


    async function handleDeleteClick(event) {
        const studentId = event.target.dataset.id;
        const studentName = event.target.dataset.name;

        if (!confirm(`Are you sure you want to deactivate student ${studentName} (ID: ${studentId})? This action is generally a soft delete.`)) {
            return;
        }
        
        try {
            // API: DELETE /api/students/:id
            await handleApi(`${STUDENTS_API_ENDPOINT}/${studentId}`, { method: 'DELETE' });
            
            alert(`${studentName}'s record has been successfully deactivated.`);
            
            // Remove the student from local data and re-render the table
            allStudentsData = allStudentsData.filter(s => s.student_id !== studentId);
            selectedStudentIds.delete(studentId); // Remove from selection set
            renderTable();

        } catch (error) {
            console.error('Deletion failed:', error);
            alert(`Failed to delete student ${studentName}. Error: ${error.message}`);
        }
    }


})();