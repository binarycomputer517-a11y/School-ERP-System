/**
 * ফাইল: student-attendance-report.js
 * বিবরণ: স্টুডেন্ট ড্যাশবোর্ডের জন্য ক্লায়েন্ট-সাইড অ্যাটেনডেন্স রিপোর্ট লজিক।
 */

document.addEventListener('DOMContentLoaded', async () => {
    const token = localStorage.getItem('erp-token');
    if (!token) {
        alert('অনুগ্রহ করে লগইন করুন।');
        window.location.href = '/login.html'; // লগইন পেজে রিডাইরেক্ট
        return;
    }

    const reportBody = document.getElementById('attendance-report-body');
    const loader = document.getElementById('loader');
    const applyFilterBtn = document.getElementById('applyFilterBtn');
    const resetFilterBtn = document.getElementById('resetFilterBtn');
    const subjectFilter = document.getElementById('subjectFilter');
    
    let allAttendanceData = []; // সমস্ত অ্যাটেনডেন্স ডেটা ধরে রাখার জন্য

    // টোকেন থেকে স্টুডেন্ট ID বের করার জন্য একটি ফাংশন (প্রয়োজনীয়)
    function getStudentInfoFromToken(jwtToken) {
        try {
            const base64Url = jwtToken.split('.')[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));

            const payload = JSON.parse(jsonPayload);
            // আমরা ধরে নিচ্ছি স্টুডেন্ট ID 'reference_id' এবং ভূমিকা 'role' হিসাবে সংরক্ষিত
            if (payload.role !== 'student' || !payload.reference_id) {
                console.error("ইউজার ভূমিকা স্টুডেন্ট নয় বা রেফারেন্স আইডি অনুপস্থিত।");
                alert('এই পেজটি শুধুমাত্র স্টুডেন্টদের জন্য।');
                return null;
            }
            return { studentId: payload.reference_id, role: payload.role };
        } catch (e) {
            console.error("টোকেন ডিকোড করার সময় ত্রুটি:", e);
            return null;
        }
    }

    const studentInfo = getStudentInfoFromToken(token);
    if (!studentInfo) {
        // টোকেন অবৈধ বা স্টুডেন্ট নয়, তাই লগইন পেজে পাঠানো যেতে পারে।
        // window.location.href = '/login.html'; 
        // এই ক্ষেত্রে, আমরা শুধু ডেটা লোড করা বন্ধ করব।
        return;
    }
    const studentId = studentInfo.studentId;

    // ১. বিষয় ড্রপডাউন লোড করা (আপনার বিদ্যমান ফাইল `academicswithfees.js` থেকে ফাংশন ব্যবহার করে)
    async function loadSubjectsForFilter() {
        // স্টুডেন্টের ব্যাচ/কোর্সের আইডি বের করে সেই কোর্স অনুযায়ী বিষয় লোড করতে হবে।
        // আপাতত সরলতার জন্য, আমরা একটি ডামি বিষয় লোড করছি।
        // বাস্তব ক্ষেত্রে, আপনাকে প্রথমে স্টুডেন্টের কোর্স/ব্যাচ আইডি লোড করতে হবে।
        const dummySubjects = [
            { id: 1, name: 'গণিত' },
            { id: 2, name: 'বিজ্ঞান' },
            { id: 3, name: 'ইংরেজি' }
        ];

        dummySubjects.forEach(subject => {
            const option = document.createElement('option');
            option.value = subject.name;
            option.textContent = subject.name;
            subjectFilter.appendChild(option);
        });
    }

    // ২. অ্যাটেনডেন্স রিপোর্ট ডেটা লোড করা
    async function fetchAttendanceReport(filters = {}) {
        loader.style.display = 'block';
        reportBody.innerHTML = '';
        
        // অ্যাটেনডেন্স API এর জন্য একটি ক্যোয়ারী স্ট্রিং তৈরি করা
        // আমরা ধরে নিচ্ছি একটি এন্ডপয়েন্ট আছে যা স্টুডেন্ট ID দ্বারা ফিল্টার করে।
        const queryParams = new URLSearchParams({
            user_id: studentId,
            start_date: filters.startDate || '',
            end_date: filters.endDate || '',
            subject_name: filters.subject || '', // বিষয় নামের উপর ভিত্তি করে ফিল্টার
            // অন্য কোনো ফিল্টার যেমন batch_id ইত্যাদি এখানে যোগ করা যেতে পারে
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
            // সব ডেটা লোড হওয়ার পর, রেন্ডার ফাংশনকে কল করা
            renderReport(allAttendanceData);

        } catch (error) {
            console.error('Attendance Report Fetch Error:', error);
            reportBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: red;">${error.message}</td></tr>`;
            updateSummary(0, 0); // ত্রুটির ক্ষেত্রে সারাংশ রিসেট
        } finally {
            loader.style.display = 'none';
        }
    }

    // ৩. ডেটা রেন্ডার এবং সারাংশ আপডেট করা
    function renderReport(data) {
        reportBody.innerHTML = ''; // টেবিল খালি করা
        
        if (!data || data.length === 0) {
            reportBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">কোনো অ্যাটেনডেন্স রেকর্ড পাওয়া যায়নি।</td></tr>';
            updateSummary(0, 0);
            return;
        }

        let presentCount = 0;
        let absentCount = 0;
        let totalCount = data.length;

        data.forEach(record => {
            if (record.status.toUpperCase() === 'PRESENT' || record.status.toUpperCase() === 'P') {
                presentCount++;
            } else if (record.status.toUpperCase() === 'ABSENT' || record.status.toUpperCase() === 'A') {
                absentCount++;
            }

            const row = reportBody.insertRow();
            // YYYY-MM-DD ফরম্যাট থেকে DD-MM-YYYY তে পরিবর্তন করা
            const date = new Date(record.attendance_date).toLocaleDateString('bn-BD', { day: '2-digit', month: '2-digit', year: 'numeric' });
            
            row.insertCell().textContent = date;
            row.insertCell().textContent = record.subject_name || 'N/A'; // ডেটাবেস থেকে subject_name আশা করা হচ্ছে
            row.insertCell().innerHTML = `<span class="status-${record.status[0].toUpperCase()}">${record.status}</span>`;
            row.insertCell().textContent = record.batch_name || 'N/A'; // ডেটাবেস থেকে batch_name আশা করা হচ্ছে
            row.insertCell().textContent = record.remarks || '';
        });

        updateSummary(totalCount, presentCount);
    }

    // ৪. সারাংশ কার্ড আপডেট করা
    function updateSummary(total, present) {
        const absent = total - present;
        const percentage = total > 0 ? ((present / total) * 100).toFixed(2) : '0.00';
        
        document.getElementById('total-classes-count').textContent = total;
        document.getElementById('present-count').textContent = present;
        document.getElementById('absent-count').textContent = absent;
        document.getElementById('attendance-percentage').textContent = `${percentage}%`;
    }

    // ৫. ইভেন্ট লিসেনার সেট করা
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
        fetchAttendanceReport({}); // ফিল্টার ছাড়া আবার লোড করা
    });
    
    // ৬. পেজ লোডের সময় প্রাথমিক ডেটা লোড করা
    await loadSubjectsForFilter(); // প্রথমে বিষয় লোড করা
    fetchAttendanceReport({}); // তারপর অ্যাটেনডেন্স রিপোর্ট লোড করা

});

// টেবিল সর্টিং ফাংশন (ঐচ্ছিক কিন্তু ড্যাশবোর্ডের জন্য সহায়ক)
document.querySelectorAll('.report-table th').forEach(header => {
    header.addEventListener('click', function() {
        const table = header.closest('table');
        const tbody = table.querySelector('tbody');
        const columnIndex = Array.from(header.parentNode.children).indexOf(header);
        const direction = header.dataset.sortOrder === 'asc' ? 'desc' : 'asc';
        
        // সর্ট আইকন আপডেট করা
        document.querySelectorAll('.report-table th i').forEach(icon => icon.classList.remove('fa-sort-up', 'fa-sort-down'));
        header.querySelector('i').classList.add(direction === 'asc' ? 'fa-sort-up' : 'fa-sort-down');
        header.dataset.sortOrder = direction;

        // ডেটা সর্ট করা
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const sortedRows = rows.sort((a, b) => {
            const aText = a.children[columnIndex].textContent.trim();
            const bText = b.children[columnIndex].textContent.trim();
            
            // তারিখের জন্য বিশেষ সর্টিং
            if (columnIndex === 0) { // তারিখ কলাম
                const aDate = new Date(aText.split('-').reverse().join('-'));
                const bDate = new Date(bText.split('-').reverse().join('-'));
                return direction === 'asc' ? aDate - bDate : bDate - aDate;
            }
            
            // সাধারণ টেক্সট সর্টিং
            return direction === 'asc' ? aText.localeCompare(bText) : bText.localeCompare(aText);
        });

        tbody.innerHTML = '';
        sortedRows.forEach(row => tbody.appendChild(row));
    });
});