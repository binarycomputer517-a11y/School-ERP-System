const API_BASE = '/api';
const authToken = localStorage.getItem('erp-token');

document.addEventListener('DOMContentLoaded', () => {
    loadClasses();
    document.getElementById('issue-date').valueAsDate = new Date();
    updatePreview();
});

async function loadClasses() {
    const select = document.getElementById('class-select');
    try {
        const res = await fetch(`${API_BASE}/sections`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        select.innerHTML = '<option value="">-- Select Class --</option>';
        data.forEach(c => {
            select.innerHTML += `<option value="${c.id}">${c.class_name} - ${c.section_name}</option>`;
        });
    } catch (e) { console.error(e); }
}

function updatePreview() {
    // Get values
    const val = (id) => document.getElementById(id)?.value || '';
    const primaryColor = val('accent-color');
    const secondaryColor = val('ribbon-color');
    const font = val('font-family');

    // Update Text
    document.getElementById('prev-title').innerText = val('cert-title');
    document.getElementById('prev-student-name').innerText = "JOHN DOE";
    document.getElementById('prev-date-text').innerText = val('issue-date');
    document.getElementById('prev-sig1-name').innerText = val('sig1-name');
    document.getElementById('prev-sig2-name').innerText = val('sig2-name');

    // Update Body logic
    let body = val('cert-body')
        .replace('{{StudentName}}', '<b>JOHN DOE</b>')
        .replace('{{Class}}', '[Class Name]')
        .replace('{{Event}}', val('course-event'));
    document.getElementById('prev-body').innerHTML = body;

    // --- APPLY DESIGN ---
    // 1. Font Family
    const box = document.getElementById('certificate-preview-container');
    if (font === 'Times') box.style.fontFamily = "'Times New Roman', serif";
    if (font === 'Helvetica') box.style.fontFamily = "'Arial', sans-serif";
    if (font === 'Courier') box.style.fontFamily = "'Courier New', monospace";

    // 2. Colors
    document.getElementById('prev-title').style.color = primaryColor;
    document.getElementById('prev-student-name').style.color = primaryColor;
    document.getElementById('prev-sig1-name').style.color = primaryColor;
    document.getElementById('prev-sig2-name').style.color = primaryColor;
    
    document.getElementById('prev-ribbon').style.backgroundColor = secondaryColor;
    box.style.borderColor = primaryColor;
}

// Global functions
window.openPreviewModal = () => { updatePreview(); document.getElementById('previewModal').style.display = 'block'; };
window.closePreviewModal = () => document.getElementById('previewModal').style.display = 'none';
window.updatePreview = updatePreview;

window.loadBackground = (e) => {
    const r = new FileReader();
    r.onload = () => document.getElementById('certificate-preview-container').style.backgroundImage = `url(${r.result})`;
    r.readAsDataURL(e.target.files[0]);
};
window.loadSignature = (e, n) => {
    const r = new FileReader();
    r.onload = () => { document.getElementById(`prev-sig${n}-img`).src=r.result; document.getElementById(`prev-sig${n}-img`).style.display='block'; };
    r.readAsDataURL(e.target.files[0]);
};

document.getElementById('certificate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('generate-btn');
    btn.disabled = true; btn.innerHTML = 'Processing...';

    try {
        const formData = new FormData(e.target);
        formData.append('dataSource', 'database');
        
        const bg = document.getElementById('bg-upload');
        if(bg.files[0]) formData.set('backgroundImage', bg.files[0]);
        const s1 = document.getElementById('sig1-upload');
        if(s1.files[0]) formData.set('signature1', s1.files[0]);
        const s2 = document.getElementById('sig2-upload');
        if(s2.files[0]) formData.set('signature2', s2.files[0]);
        
        const emailCheck = document.getElementById('sendEmail');
        formData.set('sendEmail', emailCheck.checked ? 'true' : 'false');

        const res = await fetch(`${API_BASE}/certificates/generate`, {
            method: 'POST', headers: {'Authorization': `Bearer ${authToken}`}, body: formData
        });

        if(!res.ok) throw new Error('Generation Failed');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'Certificates.zip';
        document.body.appendChild(a); a.click();
        
        alert('Certificates Generated!');
    } catch(err) { alert(err.message); }
    finally { btn.disabled = false; btn.innerHTML = 'GENERATE & DOWNLOAD'; }
});