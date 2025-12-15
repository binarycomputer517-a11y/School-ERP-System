document.getElementById('login-form').addEventListener('submit', async function(event) {
    event.preventDefault();

    const username = event.target.username.value.trim();
    const password = event.target.password.value;
    const errorMsg = document.getElementById('error-msg');
    const loginButton = document.getElementById('login-button');

    // 1. UI Feedback: Disable button and clear old errors
    errorMsg.textContent = '';
    loginButton.disabled = true;
    loginButton.textContent = 'Logging in...';

    try {
        // 2. Make the API Request
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        // 3. Handle HTTP Errors (401, 404, 500)
        if (!response.ok) {
            throw new Error(data.message || 'Login failed. Please check credentials.');
        }

        // 4. Validate Critical Data
        if (data.token && data.role && data.activeSessionId) {
            
            console.log("Login Successful, saving session data...");

            // --- A. Save Core Auth Data ---
            localStorage.setItem('erp-token', data.token);
            localStorage.setItem('user-role', data.role);
            localStorage.setItem('user-name', data.username);
            
            // --- B. Save IDs ---
            const userId = data['user-id'] || data.userId || data.reference_id;
            if (userId) {
                localStorage.setItem('profile-id', userId); 
            }

            // ✅ CRITICAL FIX: Save Student ID using the authoritative value from the server response
            if (data.role === 'Student' && data.student_id) {
                // Server (auth.js) sends the student's actual UUID in data.student_id
                localStorage.setItem('student_id', data.student_id); 
            } else {
                // Ensure no stale student_id is left if the user is not a student
                localStorage.removeItem('student_id');
            }

            // --- C. Save Configuration IDs ---
            localStorage.setItem('active_session_id', data.activeSessionId);
            
            // Save Branch ID safely
            localStorage.setItem('active_branch_id', data.userBranchId || '');

            // --- D. Dynamic Redirection based on Role ---
            const role = data.role;

            if (['Admin', 'Super Admin', 'HR', 'Accountant'].includes(role)) {
                window.location.href = '/admin-dashboard.html';
            } 
            else if (role === 'Student') {
                window.location.href = '/student-dashboard.html';
            } 
            else if (role === 'Teacher') {
                window.location.href = '/teacher-dashboard.html'; 
            } 
            else {
                // Fallback for any other roles (e.g., Librarian, Driver)
                window.location.href = '/dashboard.html'; 
            }

        } else {
            // Debugging log to see exactly what is missing in the console
            console.error("Missing Data in Response:", data);
            throw new Error('Login successful, but server response is missing required data (Token, Role, or Session ID).');
        }

    } catch (err) {
        console.error('Login Error:', err);
        errorMsg.style.color = 'red';
        errorMsg.textContent = err.message;
        
        // Reset button state
        loginButton.disabled = false;
        loginButton.textContent = 'Login';
    }
});