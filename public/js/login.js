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

        // ---
        // *** THIS IS THE CRITICAL UPDATE ***
        // ---
        // Check if the server response contains all the data we need.
        // Your backend MUST send these 4 pieces of data.
        if (data.token && data.role && data.activeSessionId && data.userBranchId) {
            
            // 1. Save Token and Role
            localStorage.setItem('erp-token', data.token);
            localStorage.setItem('user-role', data.role);

            // 2. *** NEW: Save the IDs needed by other pages ***
            localStorage.setItem('active_session_id', data.activeSessionId);
            localStorage.setItem('active_branch_id', data.userBranchId);

            // 3. Redirect to the dashboard
            window.location.href = '/admin-dashboard.html';

        } else {
            // This error means your backend login route is not sending the new data.
            throw new Error('Login successful, but server response is missing required data.');
        }

    } catch (err) {
        console.error('Login Error:', err);
        errorMsg.textContent = err.message;
        loginButton.disabled = false;
        loginButton.textContent = 'Login';
    }
});