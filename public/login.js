document.getElementById('login-form').addEventListener('submit', async function(event) {
    event.preventDefault();

    const username = event.target.username.value.trim();
    const password = event.target.password.value;
    const errorMsg = document.getElementById('error-msg');
    const loginButton = document.getElementById('login-button');

    // 1. UI Feedback: Disable button and show loading state
    errorMsg.textContent = '';
    loginButton.disabled = true;
    loginButton.textContent = 'Authenticating...';

    try {
        // 2. API Request
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        // 3. Handle Errors
        if (!response.ok) {
            throw new Error(data.message || 'Login failed. Invalid credentials.');
        }

        // 4. Validate and Save Session Data
        if (data.token && data.role) {
            console.log("Login Successful, synchronizing storage...");

            // --- A. Authentication Data ---
            localStorage.setItem('erp-token', data.token);
            localStorage.setItem('user-role', data.role);
            localStorage.setItem('username', data.username || username);
            
            // --- B. Primary User ID Synchronization ---
            const userId = data['user-id'] || data.userId || data.id;
            if (userId) localStorage.setItem('profile-id', userId);

            // --- C. Role-Specific Identifiers (Reference Linking) ---
            // Clear old reference data first to prevent cross-account issues
            localStorage.removeItem('student_id');
            localStorage.removeItem('driver_id');
            localStorage.removeItem('user-reference-id');

            if (data.role === 'Student' && data.student_id) {
                localStorage.setItem('student_id', data.student_id); 
                localStorage.setItem('user-reference-id', data.student_id); 
                console.log("Student Profile Linked:", data.student_id);
            } 
            else if (data.role === 'Driver' && data.driver_id) {
                localStorage.setItem('driver_id', data.driver_id);
                localStorage.setItem('user-reference-id', data.driver_id);
                console.log("Driver reference linked:", data.driver_id);
            }

            // --- D. Global Config & Branching ---
            if (data.activeSessionId) {
                localStorage.setItem('active_session_id', data.activeSessionId);
            }
            localStorage.setItem('active_branch_id', data.userBranchId || '');

            // --- E. Role-Based Redirection (OPTIMIZED) ---
            const role = data.role;
            const adminRoles = ['Admin', 'Super Admin', 'HR', 'Accountant', 'Coordinator'];
            
            if (adminRoles.includes(role)) {
                window.location.href = '/admin-dashboard.html';
            } 
            else if (role === 'Student') {
                window.location.href = '/student-dashboard.html';
            } 
            else if (role === 'Teacher') {
                window.location.href = '/teacher-dashboard.html'; 
            } 
            else if (role === 'Driver') {
                window.location.href = '/driver-dashboard.html'; 
            }
            else if (role === 'Parent') {
                window.location.href = '/parent-dashboard.html';
            }
            else {
                window.location.href = '/dashboard.html'; 
            }

        } else {
            throw new Error('Server response missing required session fields.');
        }

    } catch (err) {
        console.error('Login Error:', err);
        errorMsg.style.color = '#ef4444';
        errorMsg.textContent = err.message;
        
        // Re-enable button on failure
        loginButton.disabled = false;
        loginButton.textContent = 'Login';
    }
});