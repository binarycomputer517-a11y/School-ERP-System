document.addEventListener('DOMContentLoaded', () => {
    const studentForm = document.querySelector('#student-form');

    if (studentForm) {
        studentForm.addEventListener('submit', (event) => {
            event.preventDefault(); // Prevent the form from causing a page reload

            const formData = new FormData(studentForm);
            // The endpoint must match the one defined in server.js
            const endpoint = '/api/students';

            // For file uploads, you should not set Content-Type header manually.
            // The browser will set it to 'multipart/form-data' automatically with the correct boundary.
            fetch(endpoint, {
                method: 'POST',
                // When using FormData with files, do not set Content-Type header.
                // headers: { 'Content-Type': 'application/json' }, // This is incorrect for file uploads
                body: formData, // Send the FormData object directly
            })
            .then(response => {
                if (!response.ok) {
                    // Get the error message from the server if it exists
                    return response.text().then(text => { throw new Error(text) });
                }
                return response.json();
            })
            .then(result => {
                console.log('Success:', result);
                alert('Student added successfully!');
                studentForm.reset(); // Clear the form
            })
            .catch(error => {
                console.error('Error:', error);
                alert('Error! Could not add student: ' + error.message);
            });
        });
    }
});