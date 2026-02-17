// /js/manage-settings.js
// Logic for Global System Settings Management

// --- DOM Elements ---
const settingsForm = document.getElementById('settings-form');
const loader = document.getElementById('loader'); // Assuming loader is available
// Assuming other utility functions (handleApi, showMessage, clearMessage, showLoader)
// are defined or imported elsewhere, similar to the student.js file.

// --- Core Function: Load Settings (GET) ---
/**
 * Fetches the current global settings from the API and populates the form.
 */
async function loadSettings() {
    // Optionally show the loader if available
    // showLoader(true); 
    clearMessage();

    try {
        const response = await handleApi('/api/settings/global');
        if (!response.ok) {
            throw new Error('Server returned an error when fetching settings.');
        }
        
        const settings = await response.json();
        
        // This function needs to be implemented separately to map
        // API response keys (e.g., settings.academic_year) to form field values.
        populateForm(settings); 
        
    } catch (error) {
        console.error('Settings Load Error:', error);
        showMessage('Failed to load system settings. Please check the network.', 'error');
    } finally {
        // showLoader(false);
    }
}

// --- Event Handler: Save Settings (PUT) ---
settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMessage();
    // showLoader(true);

    const formData = new FormData(settingsForm);
    // Convert form data into a JSON payload
    const payload = Object.fromEntries(formData.entries());

    try {
        const response = await handleApi('/api/settings/global', {
            method: 'PUT', // Use PUT for updating an existing resource
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (response.ok) {
            // Re-call loadSettings to ensure the form reflects the latest server data
            // loadSettings(); 
            showMessage('Settings updated successfully. All changes are live.', 'success');
        } else {
            // Handle validation errors or server-side issues
            showMessage(result.message || 'Failed to save settings due to a server error.', 'error');
        }
    } catch (error) {
        console.error('Settings Save Error:', error);
        showMessage('A network error occurred while saving settings.', 'error');
    } finally {
        // showLoader(false);
    }
});


// --- Initialization ---
// Load the current settings when the page content is fully loaded
document.addEventListener('DOMContentLoaded', loadSettings);

// NOTE: You must implement the populateForm(settings) utility function
// and ensure that handleApi, showMessage, and clearMessage are available 
// in this file's scope.