/**
 * File: public/js/view-student.js
 * Description: Client-side logic for fetching, displaying, filtering, sorting,
 * and handling actions (View, Edit, Delete, Print, Export, Bulk Delete) for the student list.
 */

document.addEventListener('DOMContentLoaded', async () => {
    const tableBody = document.getElementById('student-list-body');
    const studentCountSpan = document.getElementById('student-count');
    const courseFilterSelect = document.getElementById('course-filter');
    const statusFilterSelect = document.getElementById('status-filter');
    const searchInput = document.getElementById('student-search');
    const searchButton = document.getElementById('search-button');
    const token = localStorage.getItem('erp-token');

    // Action Buttons
    const printButton = document.getElementById('print-list');
    const exportButton = document.getElementById('export-excel');

    // Summary Count Spans
    const activeCountSpan = document.getElementById('active-count');
    const leaveCountSpan = document.getElementById('leave-count');
    const graduatedCountSpan = document.getElementById('graduated-count');
    const unassignedCountSpan = document.getElementById('unassigned-count');

    // Bulk Action Elements
    const selectAllCheckbox = document.getElementById('select-all-students');
    const bulkDeleteButton = document.getElementById('bulk-delete-btn');
    const bulkActionsArea = document.getElementById('bulk-actions-area');
    const selectedCountSpan = document.getElementById('selected-count');

    // State for tracking the current sort order
    let currentSort = { column: 'name', order: 'asc' };

    if (!token) {
        tableBody.innerHTML = '<tr><td colspan="10" class="text-danger text-center">Authentication token missing. Please log in.</td></tr>';
        studentCountSpan.textContent = '0 Total';
        return;
    }

    const authHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    };

    /**
     * Fetches the list of courses and populates the course filter dropdown.
     */
    async function loadCourseFilterDropdown() {
        try {
            const response = await fetch('/api/academicswithfees/courses', { headers: authHeaders });
            if (!response.ok) { console.error('Failed to load course list for filter.'); return; }
            const courses = await response.json();

            courses.forEach(course => {
                const option = document.createElement('option');
                option.value = course.course_code;
                option.textContent = course.course_name || course.course_code;
                courseFilterSelect.appendChild(option);
            });
        } catch (error) {
            console.error('Network error loading course dropdown:', error);
        }
    }

    /**
     * Attaches listeners to the Edit buttons for navigation.
     */
    function addEditButtonListeners() {
        document.querySelectorAll('.edit-btn').forEach(button => {
            button.addEventListener('click', (e) => {
                const studentId = e.currentTarget.getAttribute('data-id');
                if (studentId) {
                    window.location.href = `/edit-student.html?id=${studentId}`;
                } else {
                    console.error("Missing student ID for edit button.");
                }
            });
        });
    }

    /**
     * Attaches listeners to the Delete buttons for individual student deletion.
     */
    function addDeleteButtonListeners() {
        document.querySelectorAll('.delete-btn').forEach(button => {
            button.addEventListener('click', async (e) => {
                const studentId = e.currentTarget.getAttribute('data-id');
                const studentRow = e.currentTarget.closest('tr');
                
                // ⭐ FIX: Add strict check for studentId before proceeding (to catch 'undefined' errors)
                if (!studentId || studentId === 'undefined') {
                    console.error("Missing or invalid student ID for delete button. Cannot proceed.");
                    alert("Error: Student ID is missing or invalid. Cannot delete.");
                    return; 
                }
                
                const studentName = studentRow.cells[4].textContent; 

                if (confirm(`Are you sure you want to permanently delete student: ${studentName} (ID: ${studentId})? This action cannot be undone.`)) {
                    try {
                        const response = await fetch(`/api/students/${studentId}`, {
                            method: 'DELETE',
                            headers: authHeaders
                        });

                        if (!response.ok) {
                            const error = await response.json().catch(() => ({ message: 'Failed to delete student.' }));
                            throw new Error(`Deletion failed: ${error.message}`);
                        }

                        alert(`Student ${studentName} (ID: ${studentId}) has been deleted successfully.`);
                        fetchStudentList(); // Refresh the list after deletion

                    } catch (error) {
                        console.error('Single Delete Error:', error);
                        alert(`Error deleting student: ${error.message}`);
                    }
                }
            });
        });
    }

    // --- START: PASSWORD RESET FUNCTIONALITY ---
    /**
     * Handles the password reset logic.
     */
    async function resetPassword(userId, studentName) {
        // ⭐ FIX: Validate userId before proceeding to prevent the "invalid input syntax for type uuid: "undefined"" error.
        if (!userId || userId === 'undefined' || userId === 'null') {
            alert('Error: User ID is missing or invalid. Cannot reset password for this student.');
            console.error("Attempted to reset password with invalid User ID:", userId); 
            return;
        }
        
        const defaultPassword = 'Password@123'; 
        
        const isConfirmed = confirm(
            `Are you sure you want to reset the password for ${studentName} (User ID: ${userId})?` +
            `\n\nTheir new password will be: ${defaultPassword}`
        );

        if (!isConfirmed) return;

        try {
            const response = await fetch(`/api/users/reset-password`, { 
                method: 'POST',
                headers: authHeaders, 
                body: JSON.stringify({ 
                    userId: userId, 
                    newPassword: defaultPassword 
                }) 
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const message = errorData.error || errorData.message || 'Failed to reset password.';
                throw new Error(`Reset failed: ${message}`);
            }
            
            alert(`Password for ${studentName} has been reset successfully.\n\nNew Password: ${defaultPassword}`);

        } catch (error) {
            console.error('Password Reset Error:', error);
            alert(`Error resetting password: ${error.message}`);
        }
    }

    /**
     * Attaches listeners to the Reset Password buttons.
     */
    function addResetPasswordListeners() {
        document.querySelectorAll('.reset-pass-btn').forEach(button => {
            button.addEventListener('click', (e) => {
                const btn = e.currentTarget;
                const userId = btn.getAttribute('data-user-id');
                const studentName = btn.getAttribute('data-name');
                
                resetPassword(userId, studentName);
            });
        });
    }
    // --- END: PASSWORD RESET FUNCTIONALITY ---


    /**
     * Renders the student data into the HTML table.
     */
    function renderStudentTable(students) {
        let rowsHtml = '';
        students.forEach(student => {
            const fullName = `${student.first_name} ${student.last_name}`;
            const statusBadgeClass = student.status === 'Active' ? 'bg-success' :
                                     student.status === 'Graduated' ? 'bg-secondary' :
                                     'bg-warning text-dark';

            rowsHtml += `
                <tr>
                    <td><input type="checkbox" class="student-select-checkbox" data-student-id="${student.id}"></td>
                    <td style="width: 50px;"><i class="bi bi-person-circle fs-4 text-muted"></i></td>
                    <td>${student.admission_id || 'N/A'}</td>
                    <td>${student.enrollment_no || 'N/A'}</td>
                    <td>${fullName}</td>
                    <td>${student.course_name || 'N/A'}</td>
                    <td>${student.email}</td>
                    <td>${student.phone_number || '-'}</td>
                    <td><span class="badge ${statusBadgeClass}">${student.status || 'N/A'}</span></td>
                    <td class="action-btns">
                        <a href="/student-profile.html?id=${student.id}" class="btn btn-sm btn-info text-white me-1" title="View Details"><i class="bi bi-eye"></i></a>
                        
                        <button class="btn btn-sm btn-warning edit-btn" data-id="${student.id}" title="Edit Student"><i class="bi bi-pencil"></i></button>
                        
                        <button class="btn btn-sm btn-secondary reset-pass-btn me-1" 
                                data-user-id="${student.user_id}" 
                                data-name="${fullName}"
                                title="Reset Password">
                            <i class="bi bi-key-fill"></i>
                        </button>
                        
                        <button class="btn btn-sm btn-danger delete-btn" data-id="${student.id}" title="Delete Student"><i class="bi bi-trash"></i></button>
                    </td>
                </tr>
            `;
        });
        tableBody.innerHTML = rowsHtml;
    }

    // =======================================================
    // --- SORTING AND FILTERING LOGIC ---
    // =======================================================
    
    let isCompactView = false;
    const viewToggleBtn = document.getElementById('view-toggle-btn');
    
    if (viewToggleBtn) {
        viewToggleBtn.addEventListener('click', () => {
            isCompactView = !isCompactView;
            fetchStudentList(); // Re-fetch to apply view changes
        });
    }

    /**
     * Updates the sort icons in the table header to provide visual feedback.
     */
    function updateSortIcons() {
        document.querySelectorAll('th[data-sort]').forEach(th => {
            const icon = th.querySelector('i.bi');
            if (icon) icon.remove(); 

            if (th.getAttribute('data-sort') === currentSort.column) {
                const newIcon = document.createElement('i');
                newIcon.className = `bi ${currentSort.order === 'asc' ? 'bi-caret-down-fill' : 'bi-caret-up-fill'}`;
                newIcon.style.fontSize = '0.8em';
                newIcon.style.marginLeft = '5px';
                th.appendChild(newIcon);
            }
        });
    }

    /**
     * Adds click listeners to all sortable table headers.
     */
    function addSortListeners() {
        document.querySelectorAll('th[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const sortColumn = th.getAttribute('data-sort');

                if (currentSort.column === sortColumn) {
                    currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
                } else {
                    currentSort.column = sortColumn;
                    currentSort.order = 'asc';
                }

                fetchStudentList(); 
            });
        });
    }

    /**
     * Collects all current filter, search, and sort values into a query string.
     */
    function buildQueryString() {
        const params = new URLSearchParams();
        const searchTerm = searchInput.value.trim();
        if (searchTerm) { params.append('q', searchTerm); }
        if (courseFilterSelect.value) { params.append('course', courseFilterSelect.value); }
        if (statusFilterSelect.value) { params.append('status', statusFilterSelect.value); }

        params.append('sortBy', currentSort.column);
        params.append('sortOrder', currentSort.order);

        return params.toString() ? '?' + params.toString() : '';
    }

    /**
     * Processes the list of students to calculate and update the summary counts.
     */
    function updateSummaryCounts(students) {
        let active = 0, leaveDeferred = 0, graduated = 0, unassigned = 0;
        students.forEach(student => {
            const status = student.status;
            if (status === 'Active') active++;
            else if (status === 'On-Leave' || status === 'Deferred') leaveDeferred++;
            else if (status === 'Graduated') graduated++;
            else if (!status || student.status === 'New') unassigned++; 
        });
        activeCountSpan.textContent = active;
        leaveCountSpan.textContent = leaveDeferred;
        graduatedCountSpan.textContent = graduated;
        unassignedCountSpan.textContent = unassigned;
    }

    /**
     * Fetches the student list, optionally filtered and sorted by the current selections.
     */
    async function fetchStudentList() {
        const queryString = buildQueryString();
        tableBody.innerHTML = `<tr><td colspan="10" class="text-center text-muted py-4"><i class="bi bi-arrow-clockwise spin-icon me-2"></i>Loading student data...</td></tr>`;
        studentCountSpan.textContent = 'Loading...';

        try {
            const response = await fetch(`/api/students${queryString}`, { headers: authHeaders });
            if (!response.ok) {
                const error = await response.json().catch(() => ({ message: 'Failed to load list.' }));
                throw new Error(`Status ${response.status}: ${error.message}`);
            }
            const students = await response.json();

            if (students.length === 0) {
                tableBody.innerHTML = '<tr><td colspan="10" class="text-center text-muted py-4">No students found matching the criteria.</td></tr>';
                studentCountSpan.textContent = '0 Total';
            }

            updateSummaryCounts(students);
            renderStudentTable(students);
            updateSortIcons(); 
            studentCountSpan.textContent = `${students.length} Total`;

            addEditButtonListeners();
            addDeleteButtonListeners();
            addResetPasswordListeners(); 
            addSelectionListeners();

        } catch (error) {
            console.error('API Error fetching student list:', error);
            tableBody.innerHTML = `<tr><td colspan="10" class="text-danger text-center py-4">Error: ${error.message}</td></tr>`;
            studentCountSpan.textContent = 'Error';
            updateSummaryCounts([]);
        }
    }

    // --- BULK ACTION (SELECTION, DELETE) ---

    function updateBulkActionsUI() {
        const selectedCheckboxes = document.querySelectorAll('.student-select-checkbox:checked');
        const count = selectedCheckboxes.length;
        selectedCountSpan.textContent = count;

        bulkActionsArea.classList.toggle('d-none', count === 0);

        const totalCheckboxes = document.querySelectorAll('.student-select-checkbox').length;
        if (totalCheckboxes > 0) {
            selectAllCheckbox.checked = (count === totalCheckboxes);
            selectAllCheckbox.indeterminate = (count > 0 && count < totalCheckboxes);
        } else {
            selectAllCheckbox.checked = false;
        }
    }

    function addSelectionListeners() {
        document.querySelectorAll('.student-select-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', updateBulkActionsUI);
        });
        selectAllCheckbox.addEventListener('change', handleSelectAll);
        updateBulkActionsUI();
    }

    function handleSelectAll() {
        document.querySelectorAll('.student-select-checkbox').forEach(checkbox => {
            checkbox.checked = selectAllCheckbox.checked;
        });
        updateBulkActionsUI();
    }

    async function handleBulkDelete() {
        const selectedIds = Array.from(document.querySelectorAll('.student-select-checkbox:checked'))
                                 .map(cb => cb.getAttribute('data-student-id'));
        if (selectedIds.length === 0) {
            return alert('Please select at least one student to delete.');
        }
        if (!confirm(`Are you sure you want to permanently delete ${selectedIds.length} student(s)? This action cannot be undone.`)) {
            return;
        }
        try {
            const response = await fetch('/api/students/bulk-delete', {
                method: 'DELETE',
                headers: authHeaders,
                body: JSON.stringify({ student_ids: selectedIds })
            });
            if (!response.ok) {
                const error = await response.json().catch(() => ({ message: 'Failed to delete students.' }));
                throw new Error(`Deletion failed: ${error.message}`);
            }
            alert(`${selectedIds.length} student(s) successfully deleted.`);
            fetchStudentList();
        } catch (error) {
            console.error('Bulk Delete Error:', error);
            alert(`Error performing bulk deletion: ${error.message}`);
        }
    }

    if (bulkDeleteButton) {
        bulkDeleteButton.addEventListener('click', handleBulkDelete);
    }

    // --- PRINT & EXPORT ---

    if (printButton) {
        printButton.addEventListener('click', () => window.print());
    }

    function tableToCSV() {
        let csv = [];
        // Exclude checkbox, photo, and action columns
        const headers = Array.from(document.querySelectorAll('.table thead th:not(:first-child):not(:nth-child(2)):not(:last-child)'))
            .map(th => `"${th.textContent.trim().replace(/"/g, '""')}"`);
        csv.push(headers.join(','));
        document.querySelectorAll('#student-list-body tr').forEach(row => {
            if (row.querySelector('td[colspan="10"]')) return;
            let rowData = [];
            row.querySelectorAll('td').forEach((cell, index) => {
                // Include data from ID (index 2) up to Enroll Status (index 9)
                if (index >= 2 && index <= 9) { 
                    rowData.push(`"${cell.textContent.trim().replace(/"/g, '""')}"`);
                }
            });
            if (rowData.length > 0) csv.push(rowData.join(','));
        });
        return csv.join('\n');
    }

    if (exportButton) {
        exportButton.addEventListener('click', () => {
            const blob = new Blob([tableToCSV()], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.setAttribute('href', url);
            link.setAttribute('download', 'student_list_export.csv');
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    }

    // --- EVENT LISTENERS & INITIALIZATION ---

    courseFilterSelect.addEventListener('change', fetchStudentList);
    statusFilterSelect.addEventListener('change', fetchStudentList);
    searchButton.addEventListener('click', fetchStudentList);
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            fetchStudentList();
        }
    });

    addSortListeners(); 
    loadCourseFilterDropdown();
    fetchStudentList(); // Initial data fetch
});