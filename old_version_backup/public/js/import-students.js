/**
 * File: public/js/import-students.js
 * Description: Client-side logic for handling CSV file upload and initiating batch student import.
 */

document.addEventListener('DOMContentLoaded', () => {
    
    // --- AUTHENTICATION & SETUP ---
    const token = localStorage.getItem('erp-token');
    if (!token) {
        alert('Authentication Error: You must be logged in to import data.');
        window.location.href = '/login.html';
        return;
    }
    const authHeaders = { 'Authorization': `Bearer ${token}` };

    const importForm = document.getElementById('importForm');
    const importButton = document.getElementById('importButton');
    const importStatusArea = document.getElementById('import-status-area');
    const importProgress = document.getElementById('import-progress');
    const importSummary = document.getElementById('import-summary');
    const totalRowsSpan = document.getElementById('total-rows');
    const successCountSpan = document.getElementById('success-count');
    const errorCountSpan = document.getElementById('error-count');
    const errorLogArea = document.getElementById('error-log-area');
    const errorLogPre = document.getElementById('error-log');

    // --- Reset function to clear results area ---
    function resetStatusArea() {
        importStatusArea.classList.add('d-none');
        importProgress.classList.remove('d-none', 'alert-danger', 'alert-success');
        importProgress.classList.add('alert-info');
        importProgress.innerHTML = '<div class="spinner-border spinner-border-sm me-2" role="status"></div>Import in progress...';
        importSummary.classList.add('d-none');
        errorLogArea.classList.add('d-none');
        errorLogPre.textContent = '';
        importButton.disabled = false;
        importButton.innerHTML = '<i class="bi bi-upload"></i> Start Import';
    }

    // --- FORM SUBMISSION HANDLER ---
    if (importForm) {
        importForm.addEventListener('submit', async function(event) {
            event.preventDefault();
            
            if (!importForm.checkValidity()) {
                 importForm.classList.add('was-validated');
                 return;
            }

            // Reset and update UI for start
            resetStatusArea();
            importStatusArea.classList.remove('d-none');
            importButton.disabled = true;
            importButton.innerHTML = '<div class="spinner-border spinner-border-sm me-2" role="status"></div> Importing...';

            const formData = new FormData(importForm);
            
            try {
                // Ensure the file input name 'csvFile' matches the Multer configuration on the server
                const response = await fetch('/api/students/import-csv', {
                    method: 'POST',
                    headers: authHeaders, // Auth header is still needed
                    body: formData 
                });
                
                const result = await response.json();
                
                // --- Process Results ---
                importProgress.classList.add('d-none');
                importSummary.classList.remove('d-none');

                totalRowsSpan.textContent = result.totalRows || 0;
                successCountSpan.textContent = result.successCount || 0;
                errorCountSpan.textContent = result.errorCount || 0;

                if (response.ok) {
                    // Success, or success with some errors
                    const msg = result.errorCount > 0 
                        ? `Import finished with ${result.errorCount} errors.`
                        : 'Import completed successfully!';
                        
                    alert(`✅ ${msg}`);
                    
                    if (result.errorCount > 0 && result.errors) {
                        errorLogArea.classList.remove('d-none');
                        errorLogPre.textContent = result.errors.map(e => `Row ${e.row}: ${e.message}`).join('\n');
                    }
                    
                    // Allow navigation back to list
                    setTimeout(() => {
                        window.location.href = '/view-student.html';
                    }, 1000); 

                } else {
                    // Hard error (e.g., file validation failure, server crash)
                    importStatusArea.classList.remove('d-none');
                    importProgress.classList.remove('alert-info');
                    importProgress.classList.add('alert-danger');
                    importProgress.innerHTML = `<i class="bi bi-x-octagon"></i> Import Failed: ${result.message || 'Server error occurred.'}`;
                    
                    alert(`❌ Import Failed: ${result.message || 'Check server logs.'}`);
                }

            } catch (error) {
                console.error('Network or Submission Error:', error);
                
                importProgress.classList.remove('alert-info');
                importProgress.classList.add('alert-danger');
                importProgress.innerHTML = '<i class="bi bi-exclamation-triangle"></i> A network error occurred. Please try again.';
                
                alert('A network error occurred. Please check your connection.');
            } finally {
                importButton.disabled = false;
                importButton.innerHTML = '<i class="bi bi-upload"></i> Start Import';
            }
        });
    }
});