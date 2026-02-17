// public/js/login-client.js

document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const errorMsgElement = document.getElementById('login-error-msg');

    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorMsgElement.textContent = ''; // Clear previous errors

        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;

        try {
            const response = await fetch('/api/users/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });

            if (response.ok) {
                // Login successful!
                const data = await response.json();
                
                // **THIS IS THE MOST IMPORTANT STEP**
                // Save the token to the browser's localStorage.
                localStorage.setItem('authToken', data.token);

                // Redirect to the dashboard or exam page.
                // The scripts on that page will now find the token.
                window.location.href = '/exam-management.html';

            } else {
                // Login failed
                const errorData = await response.json();
                errorMsgElement.textContent = errorData.message || 'Login failed. Please try again.';
            }
        } catch (error) {
            console.error('Login request error:', error);
            errorMsgElement.textContent = 'An error occurred. Please check your connection.';
        }
    });
});