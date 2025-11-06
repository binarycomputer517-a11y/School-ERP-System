document.getElementById('login-form').addEventListener('submit', async function(event) {
    event.preventDefault();

    const username = event.target.username.value;
    const password = event.target.password.value;
    const errorMsg = document.getElementById('error-msg');
    const loginButton = document.getElementById('login-button');

    errorMsg.textContent = '';
    loginButton.disabled = true;
    loginButton.textContent = 'Logging in...';

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || 'Login failed. Please check credentials.');
        }

        // --- CRITICAL DATA CHECK ---
        if (data.token && data.role && data.activeSessionId && data.userBranchId) {
            
            // 1. Save Token, Role, and Profile ID
            localStorage.setItem('erp-token', data.token);
            localStorage.setItem('user-role', data.role);
            localStorage.setItem('user-name', data.username);
            
            if (data.reference_id) {
                // Save the primary reference ID (Student ID or Teacher ID)
                localStorage.setItem('profile-id', data.reference_id); 
            }

            // 2. Save Configuration IDs
            localStorage.setItem('active_session_id', data.activeSessionId);
            localStorage.setItem('active_branch_id', data.userBranchId);

            // 3. Dynamic Redirection based on role
            const role = data.role;
            if (role === 'Admin' || role === 'Super Admin' || role === 'HR' || role === 'Accountant') {
                window.location.href = '/admin-dashboard.html';
            } else if (role === 'Student') {
                window.location.href = '/student-dashboard.html';
            } else if (role === 'Teacher') {
                window.location.href = '/teacher-dashboard.html'; 
            } else {
                // Fallback for other roles
                window.location.href = '/dashboard.html'; 
            }

        } else {
            // This error is now definitively caused by the server if it fails to return the four essential configuration IDs.
            throw new Error('Login successful, but server response is missing required data for session setup.');
        }

    } catch (err) {
        console.error('Login Error:', err);
        errorMsg.textContent = err.message;
        loginButton.disabled = false;
        loginButton.textContent = 'Login';
    }
});