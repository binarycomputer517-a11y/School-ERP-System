// public/js/payroll.js - Frontend Logic (Fixed for TypeError and Token handling)

const API_BASE = '/api/payroll'; 
const DEPARTMENTS_API = '/api/hr/departments'; 
// Use a dummy token if none found, to prevent 'Bearer null' header issue
const token = localStorage.getItem('authToken') || 'dummy-token-for-dev'; 

// --- Utility Functions ---

/**
 * Handles API calls, including setting headers and checking response status.
 */
async function handleApi(url, options = {}) {
    const defaultHeaders = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    };

    const config = { 
        ...options, 
        headers: { 
            ...defaultHeaders, 
            ...options.headers, 
        } 
    };

    const response = await fetch(url, config);

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: `HTTP error! Status: ${response.status}` }));
        throw new Error(errorData.message || `An unknown HTTP error occurred (Status: ${response.status}).`);
    }

    return response.json();
}

/**
 * Formats a number as currency (INR).
 */
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(Number(amount));
}

// --- Data Loading and Filtering ---

/**
 * Populates the Department dropdown with data.
 */
async function loadDepartments() {
    try {
        const departments = await handleApi(DEPARTMENTS_API);
        const departmentSelect = document.getElementById('departmentId');
        
        if (!departmentSelect) return;

        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '-- All Departments --';
        
        departmentSelect.innerHTML = '';
        departmentSelect.appendChild(defaultOption);

        departments.forEach(dept => {
            const option = document.createElement('option');
            option.value = dept.id;
            option.textContent = dept.name;
            departmentSelect.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading departments:', error);
    }
}

/**
 * Populates month and year dropdowns for pay period selection.
 * FIXED: Includes robust check for null elements using .filter(select => select !== null).
 */
function populatePayPeriodFilters() {
    const currentYear = moment().year();
    const currentMonth = moment().month() + 1; // moment months are 0-indexed

    // Month Selects - Protected against the TypeError
    const monthNames = moment.months();
    [
        document.getElementById('payPeriodMonth'), 
        document.getElementById('filterPeriodMonth')
    ]
    .filter(select => select !== null) // <-- CRITICAL FIX
    .forEach(select => {
        select.innerHTML = '';
        monthNames.forEach((name, index) => {
            const option = document.createElement('option');
            option.value = index + 1; // 1-indexed month value for API
            option.textContent = name;
            if (index + 1 === currentMonth) {
                option.selected = true;
            }
            select.appendChild(option);
        });
    });

    // Year Selects - Protected against the TypeError
    [
        document.getElementById('payPeriodYear'), 
        document.getElementById('filterPeriodYear')
    ]
    .filter(select => select !== null) // <-- CRITICAL FIX
    .forEach(select => {
        select.innerHTML = '';
        for (let year = currentYear + 1; year >= currentYear - 5; year--) {
            const option = document.createElement('option');
            option.value = year;
            option.textContent = year;
            if (year === currentYear) {
                option.selected = true;
            }
            select.appendChild(option);
        }
    });
}

// --- Core Payroll Functionality ---

/**
 * Triggers the payroll generation process.
 */
async function generatePayroll() {
    const departmentId = document.getElementById('departmentId')?.value;
    const payPeriodMonth = document.getElementById('payPeriodMonth')?.value;
    const payPeriodYear = document.getElementById('payPeriodYear')?.value;
    const calculationMethodElement = document.querySelector('input[name="calculationMethod"]:checked');

    if (!payPeriodMonth || !payPeriodYear || !calculationMethodElement) {
        alert('Please select a valid pay period and calculation method.');
        return;
    }
    
    const calculationMethod = calculationMethodElement.value;

    const confirmMessage = `Are you sure you want to GENERATE payroll...?`; 

    if (!confirm(confirmMessage)) return;

    try {
        const payload = {
            department_id: departmentId || null, 
            pay_period_month: parseInt(payPeriodMonth),
            pay_period_year: parseInt(payPeriodYear),
            calculation_method: calculationMethod 
        };

        const result = await handleApi(`${API_BASE}/generate`, {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        alert(`Payroll generation initiated successfully! Processed: ${result.processed_count || 0} employees.`);
        fetchPayrollRegister(payPeriodMonth, payPeriodYear); 

    } catch (error) {
        console.error('Payroll Generation Failed:', error);
        alert(`Failed to generate payroll: ${error.message}`);
    }
}
window.generatePayroll = generatePayroll; 

/**
 * Fetches and displays the Payroll Register History.
 */
async function fetchPayrollRegister(month, year) {
    const tableBody = document.querySelector('#payrollRegisterTable tbody');
    if (!tableBody) return; 

    tableBody.innerHTML = '<tr><td colspan="7" class="text-center"><i class="bi bi-hourglass-split"></i> Loading payroll records...</td></tr>';
    
    const filterMonth = month || document.getElementById('filterPeriodMonth')?.value;
    const filterYear = year || document.getElementById('filterPeriodYear')?.value;

    if (!filterMonth || !filterYear) {
        tableBody.innerHTML = '<tr><td colspan="7" class="text-center">Please select a filter period.</td></tr>';
        return;
    }
    
    const query = new URLSearchParams({
        month: filterMonth,
        year: filterYear,
    }).toString();

    try {
        const registerRecords = await handleApi(`${API_BASE}/register?${query}`);
        
        tableBody.innerHTML = ''; 

        if (registerRecords.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="7" class="text-center">No payroll records found for the selected period.</td></tr>';
            return;
        }

        registerRecords.forEach(record => {
            const row = tableBody.insertRow();
            
            const employeeName = record.employee_name || `Staff ID: ${record.user_id.substring(0, 8)}...`;
            const payPeriod = `${moment(record.pay_period_start).format('DD MMM')} - ${moment(record.pay_period_end).format('DD MMM, YYYY')}`;

            row.insertCell().textContent = employeeName;
            row.insertCell().textContent = payPeriod;
            row.insertCell().textContent = formatCurrency(record.gross_earnings);
            row.insertCell().textContent = formatCurrency(record.net_pay);
            row.insertCell().textContent = Number(record.total_present_days).toFixed(1); 
            
            const statusCell = row.insertCell();
            statusCell.innerHTML = `<span class="status-${record.status.replace(/\s/g, '_')}">${record.status}</span>`;
            
            const actionCell = row.insertCell();
            const payslipDataEncoded = encodeURIComponent(JSON.stringify(record.payslip_data));

            actionCell.innerHTML = `
                <button class="small-btn" onclick='viewPayslip("${record.id}", "${employeeName}", "${payPeriod}", "${payslipDataEncoded}")'>
                    <i class="bi bi-file-earmark-text-fill"></i> View Payslip
                </button>
            `;
        });

    } catch (error) {
        console.error('Error fetching payroll register:', error);
        tableBody.innerHTML = `<tr><td colspan="7" class="text-center" style="color: red;">Failed to load data: ${error.message}</td></tr>`;
    }
}
window.fetchPayrollRegister = fetchPayrollRegister; 

/**
 * Opens the modal to display detailed payslip data.
 */
function viewPayslip(payrollId, employeeName, payPeriod, payslipDataEncoded) {
    const payslipData = JSON.parse(decodeURIComponent(payslipDataEncoded));
    const modal = document.getElementById('payslipModal');

    if (!modal) return;
    
    document.getElementById('modalEmployeeName').textContent = employeeName;
    document.getElementById('modalPayPeriod').textContent = payPeriod;
    
    document.getElementById('payslipJsonData').textContent = JSON.stringify(payslipData, null, 2);
    
    modal.style.display = 'block';
}
window.viewPayslip = viewPayslip;

// --- Initialization ---

document.addEventListener('DOMContentLoaded', () => {
    populatePayPeriodFilters();
    loadDepartments();
    
    const currentMonth = moment().month() + 1;
    const currentYear = moment().year();
    fetchPayrollRegister(currentMonth, currentYear);
    
    // Attach event listeners for filtering
    document.getElementById('filterPeriodMonth')?.addEventListener('change', () => fetchPayrollRegister());
    document.getElementById('filterPeriodYear')?.addEventListener('change', () => fetchPayrollRegister());
});

// Close modal when clicking outside
window.onclick = function(event) {
    const modal = document.getElementById('payslipModal');
    if (modal && event.target === modal) {
        modal.style.display = "none";
    }
}