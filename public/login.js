/**
 * Student & Staff Login Handler
 * ----------------------------
 * Features: Role-based routing, Account Restriction Detection, 
 * Payment Link Integration, and Session Synchronization.
 */

document.getElementById('login-form').addEventListener('submit', async function(event) {
    event.preventDefault();

    const username = event.target.username.value.trim();
    const password = event.target.password.value;
    const errorMsg = document.getElementById('error-msg');
    const loginButton = document.getElementById('login-button');

    // 1. UI Feedback: Disable button and show loading state
    errorMsg.innerHTML = ''; 
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

        // 3. Handle Errors (Including Account Expiry/Restriction)
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

            // --- C. Role-Specific Identifiers ---
            localStorage.removeItem('student_id');
            localStorage.removeItem('driver_id');
            localStorage.removeItem('user-reference-id');

            if (data.role === 'Student' && data.student_id) {
                localStorage.setItem('student_id', data.student_id); 
                localStorage.setItem('user-reference-id', data.student_id); 
            } 
            else if (data.role === 'Driver' && data.driver_id) {
                localStorage.setItem('driver_id', data.driver_id);
                localStorage.setItem('user-reference-id', data.driver_id);
            }

            // --- D. Global Config & Branching ---
            if (data.activeSessionId) {
                localStorage.setItem('active_session_id', data.activeSessionId);
            }
            localStorage.setItem('active_branch_id', data.userBranchId || '');

            // --- E. Role-Based Redirection ---
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
            else {
                window.location.href = '/dashboard.html'; 
            }

        } else {
            throw new Error('Server response missing required session fields.');
        }

    } catch (err) {
        console.error('Login Error:', err);
        errorMsg.style.color = '#ef4444';

        // --- 🛑 PROFILE RESTRICTION & PAYMENT ACTIVATION ---
        // Matches the "Restricted" message from your backend
        const isRestricted = err.message.toLowerCase().includes('restricted') || 
                             err.message.toLowerCase().includes('expired');

        if (isRestricted) {
            errorMsg.innerHTML = `
                <div style="background: #fff1f2; border: 1px solid #fecaca; padding: 15px; border-radius: 12px; margin-top: 15px; text-align: left; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                    <p style="color: #991b1b; font-size: 14px; margin-bottom: 6px; font-weight: 700;">
                        <i class="fas fa-shield-alt me-2"></i> Access Restricted
                    </p>
                    <p style="color: #b91c1c; font-size: 13px; margin-bottom: 12px; line-height: 1.4;">
                        ${err.message}
                    </p>
                    <a href="/pay-registration.html" 
                       style="display: block; text-align: center; background: #6366f1; color: white; padding: 12px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 14px; transition: 0.3s; box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);">
                        <i class="fas fa-credit-card me-2"></i> Pay Rs. 1,000 to Unlock Profile
                    </a>
                </div>
            `;
        } else {
            errorMsg.textContent = err.message;
        }
        
        loginButton.disabled = false;
        loginButton.textContent = 'Login';
    }
});