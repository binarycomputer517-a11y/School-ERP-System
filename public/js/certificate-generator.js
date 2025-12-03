/**
 * certificate-generator.js
 * Production Ready - Connects to Real Backend APIs
 * Handles: Data Fetching, Real-time Preview, Design Studio, and PDF Generation
 */

const API_BASE = '/api';
const authToken = localStorage.getItem('erp-token');
const authHeaders = { 'Authorization': `Bearer ${authToken}` };

// Security: Redirect if not logged in
if (!authToken) window.location.href = '/login.html';

// ==========================================
// 1. INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    // 1. Load Classes for Dropdown from DB
    loadClasses();
    
    // 2. Set Default Date to Today
    const dateInput = document.getElementById('issue-date');
    if (dateInput) dateInput.valueAsDate = new Date();
    
    // 3. Initialize Event Listeners
    setupEventListeners();
    
    // 4. Render Initial Preview
    updatePreview();
});

// ==========================================
// 2. DATA LOADING (REAL DB CONNECTION)
// ==========================================

/**
 * Fetch Classes/Sections from Database
 * Route: GET /api/sections
 */
async function loadClasses() {
    const classSelect = document.getElementById('class-select');
    try {
        const response = await fetch(`${API_BASE}/sections`, { headers: authHeaders });
        
        if (!response.ok) throw new Error('Failed to fetch classes');
        
        const classes = await response.json();
        
        classSelect.innerHTML = '<option value="">-- Select Class --</option>';
        classes.forEach(cls => {
            // cls.id is the UUID of the batch/section
            classSelect.innerHTML += `<option value="${cls.id}">${cls.class_name} - ${cls.section_name}</option>`;
        });
    } catch (error) {
        console.error('Error loading classes:', error);
        classSelect.innerHTML = '<option value="">Error loading data</option>';
    }
}

/**
 * Auto-populate Students when Class is selected
 * Route: GET /api/students?batch_id=UUID
 */
async function loadStudents(batchId) {
    const studentSelect = document.getElementById('student-select');
    studentSelect.innerHTML = '<option value="">Loading students...</option>';

    try {
        // Fetch real students filtered by the selected batch_id
        const response = await fetch(`${API_BASE}/students?batch_id=${batchId}`, { 
            headers: authHeaders 
        });

        if (!response.ok) throw new Error('Failed to fetch students');

        const students = await response.json();

        studentSelect.innerHTML = '<option value="">-- All Students in Class --</option>';
        
        if (students.length === 0) {
            studentSelect.innerHTML += '<option value="" disabled>No students found</option>';
            return;
        }

        students.forEach(std => {
            // Value is student_id, Text is Name + Roll
            studentSelect.innerHTML += `<option value="${std.student_id}">${std.first_name} ${std.last_name} (${std.roll_number || 'N/A'})</option>`;
        });

    } catch (error) {
        console.error('Error loading students:', error);
        studentSelect.innerHTML = '<option value="">Error loading students</option>';
    }
}

// ==========================================
// 3. EVENT LISTENERS
// ==========================================
function setupEventListeners() {
    // A. Class Selection Logic
    const classSelect = document.getElementById('class-select');
    if (classSelect) {
        classSelect.addEventListener('change', (e) => {
            const batchId = e.target.value;
            if (batchId) {
                loadStudents(batchId);
            } else {
                document.getElementById('student-select').innerHTML = '<option value="">-- Select Class First --</option>';
            }
        });
    }

    // B. Live Preview Triggers (Text Inputs)
    const inputs = ['cert-title', 'course-event', 'issue-date', 'cert-body', 'sig1-name', 'sig2-name'];
    inputs.forEach(id => {
        document.getElementById(id)?.addEventListener('input', updatePreview);
    });

    // C. Design Studio Triggers
    document.getElementById('font-family')?.addEventListener('change', updatePreview);
    document.getElementById('accent-color')?.addEventListener('input', updatePreview);
    document.getElementById('orientation')?.addEventListener('change', changeOrientation);
}

// ==========================================
// 4. PREVIEW & DESIGN LOGIC
// ==========================================

/**
 * Updates the visual preview based on form inputs
 */
function updatePreview() {
    const val = (id) => document.getElementById(id)?.value || '';

    // 1. Text Replacement Logic (Visual Only)
    // The backend handles the real replacement for every student PDF.
    let bodyText = val('cert-body');
    const selectedClass = document.getElementById('class-select').selectedOptions[0]?.text || '[Class Name]';
    
    // Replace placeholders with visual examples
    bodyText = bodyText
        .replace(/{{StudentName}}/g, '<span style="border-bottom:1px dashed #666; font-weight:bold;">[Student Name]</span>')
        .replace(/{{Class}}/g, selectedClass)
        .replace(/{{Event}}/g, val('course-event'))
        .replace(/{{Date}}/g, val('issue-date'));

    // 2. Update DOM Elements
    setText('prev-title', val('cert-title'));
    setText('prev-course', val('course-event'));
    setText('prev-date-text', val('issue-date'));
    setText('prev-sig1-name', val('sig1-name'));
    setText('prev-sig2-name', val('sig2-name'));
    
    const bodyContainer = document.getElementById('prev-body');
    if (bodyContainer) bodyContainer.innerHTML = bodyText;

    // 3. Apply Styles (Font & Color)
    const box = document.getElementById('certificate-preview-container');
    if (box) {
        box.style.fontFamily = val('font-family');
        // The border color is handled by CSS classes mostly, but we can override:
        // box.style.borderColor = val('accent-color'); 
    }

    // 4. Apply Accent Colors to Text
    const color = val('accent-color');
    setStyleColor('prev-title', color); // Fallback if background-clip not supported
    setStyleColor('prev-student-name', color);
}

// Helpers
function setText(id, text) { const el = document.getElementById(id); if(el) el.innerText = text; }
function setStyleColor(id, color) { const el = document.getElementById(id); if(el) el.style.color = color; }

/**
 * Inserts variables like {{StudentName}} into the textarea
 */
function insertVar(variable) {
    const textarea = document.getElementById('cert-body');
    if (textarea) {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = textarea.value;
        textarea.value = text.substring(0, start) + variable + text.substring(end);
        updatePreview();
        textarea.focus();
    }
}

function changeOrientation() {
    const orient = document.getElementById('orientation').value;
    const box = document.getElementById('certificate-preview-container');
    if (box) {
        box.classList.remove('landscape', 'portrait');
        box.classList.add(orient);
    }
}

// ==========================================
// 5. GLOBAL WINDOW FUNCTIONS (For HTML onclick)
// ==========================================

// Tab Switching
window.switchTab = function(id) {
    // Hide all content
    document.querySelectorAll('.tab-content').forEach(d => d.style.display = 'none');
    document.querySelectorAll('.tab-content').forEach(d => d.classList.remove('active')); // Important for detection
    
    // Show selected
    const selected = document.getElementById(id);
    selected.style.display = 'block';
    selected.classList.add('active'); // Add active class for form logic
    
    // Update buttons
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    if(event && event.target) event.target.closest('button').classList.add('active');
};

// Modal Logic
window.openPreviewModal = function() {
    updatePreview();
    document.getElementById('previewModal').style.display = 'block';
    document.body.style.overflow = 'hidden'; 
};

window.closePreviewModal = function() {
    document.getElementById('previewModal').style.display = 'none';
    document.body.style.overflow = 'auto';
};

// File Loaders
window.loadBackground = function(event) {
    const reader = new FileReader();
    reader.onload = function() { 
        document.getElementById('certificate-preview-container').style.backgroundImage = `url(${reader.result})`; 
    };
    if (event.target.files[0]) reader.readAsDataURL(event.target.files[0]);
};

window.loadSignature = function(event, num) {
    const reader = new FileReader();
    reader.onload = function() {
        const img = document.getElementById(`prev-sig${num}-img`);
        if (img) {
            img.src = reader.result;
            img.style.display = 'block';
        }
    };
    if (event.target.files[0]) reader.readAsDataURL(event.target.files[0]);
};

// ==========================================
// 6. GENERATION (SUBMIT TO BACKEND)
// ==========================================
const certForm = document.getElementById('certificate-form');
if (certForm) {
    certForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const btn = document.getElementById('generate-btn');
        const originalText = btn.innerHTML;

        try {
            // 1. Determine Data Source
            // Check which tab has the 'active' class (set by switchTab)
            const activeTab = document.querySelector('.tab-content.active') || document.getElementById('db-source');
            const sourceMode = (activeTab.id === 'db-source') ? 'database' : 'csv';
            
            const classId = document.getElementById('class-select').value;

            // 2. Validation
            if (sourceMode === 'database' && !classId) {
                alert('Please select a Class/Batch from the dropdown.');
                return;
            }

            // 3. UI Feedback
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';

            // 4. Prepare FormData
            const formData = new FormData(e.target);
            
            // Explicitly set the data source so backend knows what to do
            formData.set('dataSource', sourceMode);
            formData.set('classId', classId); // Ensure classId is sent

            // Handle file inputs manually (safeguard for FormData quirks)
            const bg = document.getElementById('bg-upload');
            if(bg?.files[0]) formData.set('backgroundImage', bg.files[0]);
            
            const sig1 = document.getElementById('sig1-upload');
            if(sig1?.files[0]) formData.set('signature1', sig1.files[0]);

            const sig2 = document.getElementById('sig2-upload');
            if(sig2?.files[0]) formData.set('signature2', sig2.files[0]);

            // 5. Send to Backend
            const response = await fetch(`${API_BASE}/certificates/generate`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${authToken}` },
                body: formData
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || 'Server error during generation');
            }

            // 6. Download ZIP
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Certificates_${new Date().toISOString().slice(0,10)}.zip`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            
            alert('Success! Certificates generated and downloaded.');

        } catch (error) {
            console.error(error);
            alert('Generation Failed: ' + error.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    });
}