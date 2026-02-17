/**
 * ফাইল: student-attendance-report.js
 * বিবরণ: স্টুডেন্ট ড্যাশবোর্ডের জন্য ক্লায়েন্ট-সাইড অ্যাটেনডেন্স রিপোর্ট লজিক (সংশোধিত)।
 */

document.addEventListener('DOMContentLoaded', async () => {
    const token = localStorage.getItem('erp-token');
    
    // --- FIX 1: টোকেন অনুপস্থিত থাকলে দ্রুত লগইন পেজে রিডাইরেক্ট করা ---
    if (!token) {
        alert('আপনার সেশন শেষ হয়ে গেছে বা আপনি লগইন করেননি। অনুগ্রহ করে আবার লগইন করুন।');
        console.error('Authentication token not found.');
        window.location.href = '/login.html'; // ধরে নেওয়া হলো লগইন পেজটি /login.html
        return;
    }

    const reportBody = document.getElementById('attendance-report-body');
    const loader = document.getElementById('loader');
    const applyFilterBtn = document.getElementById('applyFilterBtn');
    const resetFilterBtn = document.getElementById('resetFilterBtn');
    const subjectFilter = document.getElementById('subjectFilter');
    
    let allAttendanceData = []; 

    // --- FIX 2: JWT পেলোড থেকে স্টুডেন্ট তথ্য নিরাপদে নিষ্কাশন করা ---
    function getStudentInfoFromToken(jwtToken) {
        try {
            const base64Url = jwtToken.split('.')[1];
            // বেস ৬৪ URL সেফ থেকে সাধারণ বেস ৬৪ এ রূপান্তর
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            // জাভাস্ক্রিপ্টে atob() ব্যবহার করে ডিকোড করা
            const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));

            const payload = JSON.parse(jsonPayload);
            
            // ত্রুটি মেসেজের কারণ: নিশ্চিত করুন 'role' ও 'reference_id' JWT-এ সঠিক আছে।
            if (payload.role !== 'student' || !payload.reference_id) {
                console.error("JWT পেলোডে ত্রুটি:", payload);
                alert(`লগইন ব্যর্থ। আপনার ভূমিকা ('${payload.role}') স্টুডেন্ট নয় বা স্টুডেন্ট আইডি অনুপস্থিত।`);
                return null;
            }
            return { studentId: payload.reference_id, role: payload.role };
        } catch (e) {
            console.error("টোকেন ডিকোড করার সময় বা পেলোড পার্স করার সময় ত্রুটি:", e);
            alert('টোকেন অবৈধ। অনুগ্রহ করে আবার লগইন করুন।');
            return null;
        }
    }

    const studentInfo = getStudentInfoFromToken(token);
    if (!studentInfo) {
        // যদি টোকেন অবৈধ হয় তবে আবার লগইন করার জন্য রিডাইরেক্ট করা
        window.location.href = '/login.html';
        return;
    }
    const studentId = studentInfo.studentId;


    // ১. বিষয় ড্রপডাউন লোড করা (API কল)
    // *** গুরুত্বপূর্ণ: যেহেতু academicswithfees.js ব্রাউজারে লোড করা যাচ্ছে না, তাই এই ফাংশনটি এখন সরাসরি API কল করবে। ***
    async function loadSubjectsForFilter() {
        try {
            // ধরে নেওয়া হচ্ছে যে এই API স্টুডেন্ট আইডি দিয়ে কল করলে তার বিষয়গুলো দেবে।
            const response = await fetch(`/api/academics/student/${studentId}/subjects`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (!response.ok) {
                throw new Error('বিষয় লোড করা ব্যর্থ হয়েছে।');
            }
            
            const subjects = await response.json();
            
            // সমস্ত বিষয় (All Subjects) অপশনটি যোগ করা
            let html = '<option value="">সমস্ত বিষয়</option>';
            subjects.forEach(subject => {
                // আমরা ধরে নিচ্ছি API থেকে subject_name এবং subject_id পাচ্ছি
                html += `<option value="${subject.subject_name}">${subject.subject_name}</option>`;
            });
            subjectFilter.innerHTML = html;

        } catch (error) {
            console.error('Subjects Load Error:', error.message);
            // ত্রুটি হলেও রিপোর্ট লোড হতে থাকবে
        }
    }

    // ২. অ্যাটেনডেন্স রিপোর্ট ডেটা লোড করা
    async function fetchAttendanceReport(filters = {}) {
        loader.style.display = 'block';
        reportBody.innerHTML = '';
        
        // API কল করার লজিক অপরিবর্তিত রাখা হলো
        const queryParams = new URLSearchParams({
            user_id: studentId, // টোকেন থেকে পাওয়া আইডি
            start_date: filters.startDate || '',
            end_date: filters.endDate || '',
            subject_name: filters.subject || '', 
        }).toString();
        
        try {
            const response = await fetch(`/api/attendance/report/student?${queryParams}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.status === 401) {
                 alert('অধিবেশনের মেয়াদ উত্তীর্ণ হয়েছে। আবার লগইন করুন।');
                 window.location.href = '/login.html';
                 return;
            }

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'অ্যাটেনডেন্স রিপোর্ট লোড করা ব্যর্থ হয়েছে।');
            }

            allAttendanceData = await response.json();
            renderReport(allAttendanceData);

        } catch (error) {
            console.error('Attendance Report Fetch Error:', error);
            reportBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: red;">${error.message}</td></tr>`;
            updateSummary(0, 0); 
        } finally {
            loader.style.display = 'none';
        }
    }

    // ৩. ডেটা রেন্ডার এবং সারাংশ আপডেট করা (অপরিবর্তিত)
    function renderReport(data) {
        reportBody.innerHTML = ''; 
        
        if (!data || data.length === 0) {
            reportBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">কোনো অ্যাটেনডেন্স রেকর্ড পাওয়া যায়নি।</td></tr>';
            updateSummary(0, 0);
            return;
        }

        let presentCount = 0;
        let absentCount = 0;
        let totalCount = data.length;

        data.forEach(record => {
            // স্ট্যাটাসকে একীভূত করা
            const status = record.status ? record.status.toUpperCase() : 'N/A';
            if (status === 'PRESENT' || status === 'P') {
                presentCount++;
            } else if (status === 'ABSENT' || status === 'A') {
                absentCount++;
            }

            const row = reportBody.insertRow();
            const date = new Date(record.attendance_date).toLocaleDateString('bn-BD', { day: '2-digit', month: '2-digit', year: 'numeric' });
            
            row.insertCell().textContent = date;
            row.insertCell().textContent = record.subject_name || 'N/A'; 
            row.insertCell().innerHTML = `<span class="status-${status[0]}">${status}</span>`;
            row.insertCell().textContent = record.batch_name || 'N/A'; 
            row.insertCell().textContent = record.remarks || '';
        });

        updateSummary(totalCount, presentCount);
    }

    // ৪. সারাংশ কার্ড আপডেট করা (অপরিবর্তিত)
    function updateSummary(total, present) {
        const absent = total - present;
        const percentage = total > 0 ? ((present / total) * 100).toFixed(2) : '0.00';
        
        document.getElementById('total-classes-count').textContent = total;
        document.getElementById('present-count').textContent = present;
        document.getElementById('absent-count').textContent = absent;
        document.getElementById('attendance-percentage').textContent = `${percentage}%`;
    }

    // ৫. ইভেন্ট লিসেনার সেট করা (অপরিবর্তিত)
    applyFilterBtn.addEventListener('click', () => {
        const filters = {
            startDate: document.getElementById('startDate').value,
            endDate: document.getElementById('endDate').value,
            subject: subjectFilter.value,
        };
        fetchAttendanceReport(filters);
    });
    
    resetFilterBtn.addEventListener('click', () => {
        document.getElementById('startDate').value = '';
        document.getElementById('endDate').value = '';
        subjectFilter.value = '';
        fetchAttendanceReport({}); 
    });
    
    // ৬. পেজ লোডের সময় প্রাথমিক ডেটা লোড করা
    await loadSubjectsForFilter(); 
    fetchAttendanceReport({}); 

});

// টেবিল সর্টিং ফাংশন (অপরিবর্তিত)
document.querySelectorAll('.report-table th').forEach(header => {
    header.addEventListener('click', function() {
        const table = header.closest('table');
        const tbody = table.querySelector('tbody');
        const columnIndex = Array.from(header.parentNode.children).indexOf(header);
        const direction = header.dataset.sortOrder === 'asc' ? 'desc' : 'asc';
        
        document.querySelectorAll('.report-table th i').forEach(icon => icon.classList.remove('fa-sort-up', 'fa-sort-down'));
        header.querySelector('i').classList.add(direction === 'asc' ? 'fa-sort-up' : 'fa-sort-down');
        header.dataset.sortOrder = direction;

        const rows = Array.from(tbody.querySelectorAll('tr'));
        const sortedRows = rows.sort((a, b) => {
            const aText = a.children[columnIndex].textContent.trim();
            const bText = b.children[columnIndex].textContent.trim();
            
            if (columnIndex === 0) { 
                const aDate = new Date(aText.split('-').reverse().join('-'));
                const bDate = new Date(bText.split('-').reverse().join('-'));
                return direction === 'asc' ? aDate - bDate : bDate - aDate;
            }
            
            return direction === 'asc' ? aText.localeCompare(bText) : bText.localeCompare(aText);
        });

        tbody.innerHTML = '';
        sortedRows.forEach(row => tbody.appendChild(row));
    });
});