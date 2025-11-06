// certificate-generator.js

document.addEventListener('DOMContentLoaded', () => {
    // --- Get DOM Elements ---
    const form = document.getElementById('certificate-form');
    const templateSelect = document.getElementById('template-select');
    const studentSelect = document.getElementById('student-select');
    const bulkToggle = document.getElementById('bulk-generate-toggle');
    const studentNameInput = document.getElementById('student-name');
    const courseEventInput = document.getElementById('course-event');
    const issueDateInput = document.getElementById('issue-date');
    const signatoryInput = document.getElementById('signatory');
    const includeQrCheckbox = document.getElementById('include-qr');
    const includeSignatureCheckbox = document.getElementById('include-signature');
    const previewButton = document.getElementById('preview-btn');
    const generateButton = document.getElementById('generate-btn');
    const emailButton = document.getElementById('email-btn');
    const previewContainer = document.getElementById('certificate-preview-container');
    const previewQrCode = document.getElementById('preview-qr-code');

    // --- State Variables ---
    let selectedStudentData = null; // Store fetched student details

    // --- Helper Functions ---

    /**
     * Fetches student/class list from the API and populates the dropdown.
     */
    async function populateStudentSelect() {
        const authToken = localStorage.getItem('erp-token');
        if (!authToken) {
            console.error("Authentication token not found.");
            alert("Error: You must be logged in to fetch student data.");
            return;
        }

        try {
            // 📝 TODO: Replace with your actual API endpoint for students/classes
            const response = await fetch('/api/students?fields=id,first_name,last_name', {
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
            const students = await response.json();

            studentSelect.innerHTML = '<option value="">-- Select Student --</option>'; // Clear existing options
            students.forEach(student => {
                const option = document.createElement('option');
                option.value = student.id; // Assuming 'id' is the student's unique ID
                option.textContent = `${student.first_name} ${student.last_name}`;
                option.dataset.name = `${student.first_name} ${student.last_name}`; // Store name for easy access
                studentSelect.appendChild(option);
            });
             console.log("Student list populated.");

        } catch (error) {
            console.error("Error fetching students:", error);
            alert("Failed to load student list. Please check the console.");
        }
    }

    /**
     * Updates the student name input when a student is selected.
     */
    function handleStudentSelect() {
        const selectedOption = studentSelect.options[studentSelect.selectedIndex];
        if (selectedOption && selectedOption.value) {
            studentNameInput.value = selectedOption.dataset.name || ''; // Use stored name
            selectedStudentData = { id: selectedOption.value, name: studentNameInput.value };
            // In a real app, you might fetch more details here if needed
        } else {
            studentNameInput.value = ''; // Clear if "-- Select Student --" is chosen
            selectedStudentData = null;
        }
        updatePreview(); // Update preview when student changes
    }

    /**
     * Updates the certificate preview area based on form inputs.
     * This is a basic text-based preview. A WYSIWYG preview would involve canvas or SVG.
     */
    function updatePreview() {
        // Clear previous preview
        previewContainer.innerHTML = '';

        // Get current form values
        const templateName = templateSelect.options[templateSelect.selectedIndex].text;
        const studentName = studentNameInput.value || "[Student Name]";
        const courseEvent = courseEventInput.value || "[Course/Event Name]";
        const issueDate = issueDateInput.value ? new Date(issueDateInput.value).toLocaleDateString() : "[Date]";
        const signatory = signatoryInput.value || "[Issuing Authority]";

        // Basic HTML structure for preview
        const previewHTML = `
            <h3 style="text-align: center; margin-bottom: 20px;">${templateName} Certificate</h3>
            <p style="text-align: center;">This certifies that</p>
            <h4 style="text-align: center; font-size: 1.5em; margin: 10px 0;">${studentName}</h4>
            <p style="text-align: center;">has successfully completed/participated in</p>
            <p style="text-align: center; font-style: italic;">${courseEvent}</p>
            <p style="text-align: center; margin-top: 20px;">Issued on: ${issueDate}</p>
            <p style="text-align: right; margin-top: 30px; padding-right: 20px;">Signed:</p>
            <p style="text-align: right; padding-right: 20px;"><i>${signatory}</i></p>
            ${includeSignatureCheckbox.checked ? '<p style="position: absolute; bottom: 40px; right: 20px; font-family: cursive; font-size: 1.2em;">[Signature Img]</p>' : ''}
        `;

        previewContainer.innerHTML = previewHTML;

        // Show/hide QR code placeholder in preview
        previewQrCode.style.display = includeQrCheckbox.checked ? 'block' : 'none';
        if(includeQrCheckbox.checked){
            previewContainer.appendChild(previewQrCode); // Ensure QR is inside if shown
        }
        console.log("Preview updated.");
    }

    /**
     * Handles the form submission to generate the PDF via API call.
     */
    async function handleGenerate(event) {
        event.preventDefault(); // Prevent default form submission
        generateButton.disabled = true;
        generateButton.textContent = 'Generating...';

        const authToken = localStorage.getItem('erp-token');
        if (!authToken) {
            alert("Error: Authentication token missing. Please log in again.");
            generateButton.disabled = false;
            generateButton.textContent = 'Generate & Download PDF';
            return;
        }

        const formData = new FormData(form);
        const data = Object.fromEntries(formData.entries());

        // Add selected student ID if not bulk
        if (!data.isBulk && selectedStudentData) {
            data.studentId = selectedStudentData.id;
        } else if (data.isBulk) {
            // 📝 TODO: Handle bulk generation logic - maybe get class ID from studentSelect?
             console.warn("Bulk generation logic not fully implemented.");
             // For now, let's assume studentId holds classId if bulk is checked
             data.classId = studentSelect.value;
             delete data.studentId; // Remove single student ID
        }

        console.log("Submitting data for PDF generation:", data);

        try {
            // 📝 TODO: Replace with your actual certificate generation API endpoint
            const response = await fetch('/api/certificates/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || `Server error: ${response.status}`);
            }

            // Expecting PDF blob or a link to the PDF
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            // Create a dynamic filename
            const filename = `Certificate-${data.studentName || 'Bulk'}-${data.courseEvent}.pdf`;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            a.remove();

            alert('Certificate generated and downloaded successfully!');
             emailButton.style.display = 'inline-block'; // Show email button after successful generation (optional)

        } catch (error) {
            console.error("Error generating certificate:", error);
            alert(`Failed to generate certificate: ${error.message}`);
        } finally {
            generateButton.disabled = false;
            generateButton.textContent = 'Generate & Download PDF';
        }
    }

     /**
     * Handles emailing the certificate (requires last generated data or fetching).
     * NOTE: This is a basic example; emailing usually happens server-side.
     */
    async function handleEmail() {
        if (!selectedStudentData) {
            alert("Please select a student first.");
            return;
        }

        const authToken = localStorage.getItem('erp-token');
         if (!authToken) {
            alert("Error: Authentication token missing.");
            return;
        }

        emailButton.disabled = true;
        emailButton.textContent = 'Sending...';

        try {
            // 📝 TODO: Replace with your actual email sending API endpoint
            // This might need the generated certificate ID or resend generation data
            const response = await fetch('/api/certificates/email', {
                 method: 'POST',
                 headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                 },
                 body: JSON.stringify({
                    studentId: selectedStudentData.id,
                    // Include necessary details like templateId, courseEvent etc.
                    // Or ideally, the ID of the already generated certificate.
                    templateId: templateSelect.value,
                    courseEvent: courseEventInput.value,
                    issueDate: issueDateInput.value
                 })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || `Server error: ${response.status}`);
            }

            alert(`Certificate emailed successfully to ${selectedStudentData.name}!`);

        } catch (error) {
             console.error("Error emailing certificate:", error);
             alert(`Failed to email certificate: ${error.message}`);
        } finally {
            emailButton.disabled = false;
            emailButton.textContent = 'Email to Student';
        }
    }


    // --- Event Listeners ---
    studentSelect.addEventListener('change', handleStudentSelect);
    previewButton.addEventListener('click', updatePreview);
    form.addEventListener('submit', handleGenerate);
    emailButton.addEventListener('click', handleEmail);

    // Update preview dynamically on input changes
    form.addEventListener('input', updatePreview); // Update preview on any form input change

    // --- Initial Setup ---
    populateStudentSelect(); // Load student list on page load
    updatePreview(); // Show initial blank preview

}); // End DOMContentLoaded