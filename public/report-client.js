// /path/to/static/assets/report-client.js (NEW FILE)

document.getElementById('report-filter-form').addEventListener('submit', function(event) {
    event.preventDefault(); // Stop the form from submitting normally

    // 1. Collect form data
    const userType = document.getElementById('user-type-select').value;
    const year = document.getElementById('year-select').value;
    const month = document.getElementById('month-select').value;
    const userId = document.getElementById('user-id-input').value.trim();

    // 2. Build the query parameters
    const params = new URLSearchParams({
        user_type: userType,
        year: year,
        month: month
    });

    if (userId) {
        params.append('user_id', userId);
    }

    const apiUrl = `/api/attendance/report/monthly?${params.toString()}`;

    // 3. Fetch data from the server endpoint
    fetch(apiUrl, {
        method: 'GET',
        headers: {
            // NOTE: You must include the authorization token here!
            // This is a placeholder; you need to retrieve the actual token (e.g., from localStorage)
            'Authorization': 'Bearer YOUR_AUTH_TOKEN_HERE' 
        }
    })
    .then(response => {
        if (!response.ok) {
            // Handle HTTP errors (400, 401, 500 etc.)
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        // 4. Update the report title and info
        const dateString = new Date(year, month - 1).toLocaleString('default', { month: 'long', year: 'numeric' });
        document.getElementById('report-title').textContent = `Monthly Attendance Summary for ${dateString}`;
        document.getElementById('report-info').textContent = `Total Days in Month: ${data.total_days_in_month}. Records Found: ${data.report.length}`;
        
        // 5. Render the table
        renderReportTable(data); 
    })
    .catch(error => {
        console.error('Error generating report:', error);
        document.getElementById('report-body').innerHTML = `<tr><td colspan="35" class="text-center text-danger">Failed to load report: ${error.message}. Check your token and server logs.</td></tr>`;
    });
});

/**
 * Renders the fetched data into the HTML table.
 * (Simplified function to focus on structure)
 */
function renderReportTable(data) {
    const tableBody = document.getElementById('report-body');
    tableBody.innerHTML = ''; // Clear previous data
    const totalDays = data.total_days_in_month;

    // Generate the Daily Header (1 to 31)
    const dailyHeaderRow = document.querySelector('#daily-header').parentNode.nextElementSibling;
    let dailyHeaders = '';
    for (let i = 1; i <= 31; i++) {
        dailyHeaders += `<th style="min-width: 30px;">${i}</th>`;
    }
    // Update the second header row (the one with P, A, L, LV and the daily numbers)
    dailyHeaderRow.innerHTML = `
        <th>P</th>
        <th>A</th>
        <th>L</th>
        <th>LV</th>
        ${dailyHeaders}
    `;
    document.querySelector('#daily-header').colSpan = 31;


    if (data.report.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="35" class="text-center">No attendance records found for the selected criteria.</td></tr>`;
        return;
    }

    data.report.forEach(user => {
        let dailyCells = '';
        for (let day = 1; day <= totalDays; day++) {
            // Use the daily_attendance_pivot object to get the status
            const status = user.daily_attendance_pivot[day] || ''; 
            const statusShort = status ? status.charAt(0) : ''; // P, A, L, V (for Leave)
            
            // Apply status-specific CSS class (P, A, L, V are defined in the HTML style block)
            // 'V' is used for Leave, which is 'Leave' in the server code
            const cssClass = statusShort === 'P' ? 'status-P' :
                             statusShort === 'A' ? 'status-A' :
                             statusShort === 'L' ? 'status-L' :
                             statusShort === 'L' ? 'status-V' : ''; 
            
            dailyCells += `<td class="${cssClass}">${statusShort}</td>`;
        }

        const row = `
            <tr>
                <td>${user.user_id}</td>
                <td style="text-align: left;">${user.full_name}</td>
                <td class="status-P">${user.present_count}</td>
                <td class="status-A">${user.absent_count}</td>
                <td class="status-L">${user.late_count}</td>
                <td class="status-V">${user.leave_count}</td>
                ${dailyCells}
            </tr>
        `;
        tableBody.innerHTML += row;
    });
}