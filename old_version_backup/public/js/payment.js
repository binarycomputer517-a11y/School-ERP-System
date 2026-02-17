// This script runs after the HTML page is loaded
document.addEventListener('DOMContentLoaded', () => {

    // Get references to all the dynamic elements
    const tableBody = document.getElementById('payment-table-body');
    const totalDueEl = document.getElementById('total-due');
    const totalPaidEl = document.getElementById('total-paid');
    const balanceDueEl = document.getElementById('balance-due');
    const errorDiv = document.getElementById('error-message');

    /**
     * Fetches payment history from the API and populates the page.
     */
    async function fetchPaymentHistory() {
        try {
            // Get the student ID and token from browser storage
            const studentId = localStorage.getItem('student-id');
            const token = localStorage.getItem('erp-token');

            if (!studentId) {
                showError('Student ID not found. Please log in again.');
                return;
            }

            // This is a new API endpoint you will need to create on your backend
            const apiUrl = `/api/students/${studentId}/payments`;

            const response = await fetch(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch data. Server responded with ${response.status}`);
            }

            const data = await response.json();
            
            // Populate the summary cards
            populateSummary(data.summary);

            // Populate the transactions table
            populateTable(data.transactions);

        } catch (error) {
            console.error('Failed to fetch payment history:', error);
            showError('Could not load payment history. Please try again later.');
            tableBody.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Error loading data.</td></tr>';
        }
    }

    /**
     * Populates the three summary cards (Due, Paid, Balance).
     * @param {object} summary - The summary object from the API.
     */
    function populateSummary(summary) {
        if (!summary) return;

        const due = summary.total_due_fees || 0;
        const paid = summary.total_paid || 0;
        const balance = due - paid;

        totalDueEl.textContent = `₹${due.toLocaleString('en-IN')}`;
        totalPaidEl.textContent = `₹${paid.toLocaleString('en-IN')}`;
        balanceDueEl.textContent = `₹${balance.toLocaleString('en-IN')}`;

        // Add red text for balance, green if paid in full or overpaid
        if (balance > 0) {
            balanceDueEl.classList.add('text-danger');
        } else {
            balanceDueEl.classList.add('text-success');
        }
    }

    /**
     * Populates the main table with payment transactions.
     * @param {Array} transactions - A list of transaction objects.
     */
    function populateTable(transactions) {
        // Clear the "Loading..." row
        tableBody.innerHTML = '';

        if (!transactions || transactions.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="6" class="text-center">No payment history found.</td></tr>';
            return;
        }

        transactions.forEach(tx => {
            const row = tableBody.insertRow();
            
            // Format date to be more readable
            const paymentDate = new Date(tx.payment_date).toLocaleDateString('en-GB');

            row.insertCell(0).textContent = paymentDate;
            row.insertCell(1).textContent = tx.payment_id || tx.receipt_no || 'N/A'; // Use payment_id or receipt_no
            row.insertCell(2).textContent = tx.description;
            row.insertCell(3).textContent = tx.payment_method;

            // Add a Bootstrap badge for status
            const statusCell = row.insertCell(4);
            statusCell.innerHTML = `<span class="badge ${getStatusClass(tx.status)}">${tx.status}</span>`;

            // Format amount and right-align it
            const amountCell = row.insertCell(5);
            amountCell.textContent = `₹${tx.amount_paid.toLocaleString('en-IN')}`;
            amountCell.className = 'text-end fw-bold';
        });
    }

    /**
     * Returns a Bootstrap class based on payment status.
     * @param {string} status - The payment status (e.g., "Completed", "Pending").
     */
    function getStatusClass(status) {
        if (!status) return 'bg-secondary';
        switch (status.toLowerCase()) {
            case 'completed': return 'bg-success';
            case 'pending': return 'bg-warning text-dark';
            case 'failed': return 'bg-danger';
            default: return 'bg-secondary';
        }
    }

    /**
     * Displays a prominent error message at the top of the page.
     * @param {string} message - The error message to show.
     */
    function showError(message) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
    }

    // Run the main function when the page loads
    fetchPaymentHistory();
});