// js/dashboard.js

// --- 1. Initial Setup & Authentication ---
const token = localStorage.getItem('erp-token');
const userRole = localStorage.getItem('user-role');

if (!token || userRole !== 'Student') {
    window.location.href = '/login.html'; // Redirect to login if not authenticated
}

const authHeaders = { 'Authorization': `Bearer ${token}` };

// --- 2. Configuration Object for Dashboard Cards ---
// This object drives the rendering of each card, making the code clean and easy to extend.
const cardRenderers = {
    fees: (card, data) => {
        card.innerHTML = `<h2><i class="fas fa-rupee-sign"></i>Fees Summary</h2>
            <div class="details-grid">
                <span>Total Due:</span><span>₹${data.summary.total_due || 0}</span>
                <span>Total Paid:</span><span>₹${data.summary.total_paid || 0}</span>
                <span class="balance">Balance:</span><span class="balance">₹${data.summary.balance_due || 0}</span>
            </div>`;
    },
    attendance: (card, data) => {
        const color = data.overall_percentage > 75 ? 'green' : 'orange';
        card.innerHTML = `<h2><i class="fas fa-chart-pie"></i>Attendance Summary</h2>
            <div class="details-grid">
                <span>Overall:</span><span style="font-size:1.5em; font-weight:700; color:${color};">${data.overall_percentage}%</span>
            </div>`;
    },
    timetable: (card, data) => {
        let content;
        if (data.length > 0) {
            const rows = data.map(slot => `<tr><td>${slot.time}</td><td>${slot.subject}</td><td>${slot.teacher_name}</td></tr>`).join('');
            content = `<div class="timetable"><table><tr><th>Time</th><th>Subject</th><th>Teacher</th></tr>${rows}</table></div>`;
        } else {
            content = `<p>No classes scheduled for today. Enjoy your day!</p>`;
        }
        card.innerHTML = `<h2><i class="fas fa-calendar-alt"></i>Today's Class Timetable</h2>` + content;
    },
    // Generic List Renderers
    library: {
        title: "Library Summary", icon: "fas fa-book-reader",
        formatter: (item) => {
            const dueDate = new Date(item.due_date);
            const isOverdue = dueDate < new Date();
            return `<span>${item.title}</span> <span class="${isOverdue ? 'overdue' : ''}">Due: ${dueDate.toLocaleDateString()}</span>`;
        }
    },
    exams: {
        title: "Exam Schedule", icon: "fas fa-pen-nib",
        formatter: (item) => `<span>${item.subject}</span> <span>${new Date(item.exam_date).toLocaleDateString()} at ${item.start_time}</span>`
    },
    notices: {
        title: "Notice Board", icon: "fas fa-bullhorn",
        formatter: (item) => `<span>${item.title}</span> <a href="${item.link}" class="button" target="_blank">View</a>`
    },
    assignments: {
        title: "Assignments", icon: "fas fa-tasks",
        formatter: (item) => `<span>${item.title} (${item.subject})</span> <span>Due: ${new Date(item.due_date).toLocaleDateString()}</span>`
    },
    downloads: {
        title: "Downloads", icon: "fas fa-cloud-download-alt",
        formatter: (item) => `<span>${item.name}</span> <a href="${item.url}" class="button" target="_blank">Download</a>`
    },
    events: {
        title: "Upcoming Events", icon: "fas fa-glass-cheers",
        formatter: (item) => `<span>${item.name}</span> <span>${new Date(item.date).toLocaleDateString()}</span>`
    }
};

// --- 3. Rendering Logic ---

/**
 * Renders a list of items into a container using a specific formatting function.
 * @param {HTMLElement} container - The element to render the list into.
 * @param {Array} items - The array of data items.
 * @param {Function} formatter - A function that takes an item and returns an HTML string.
 */
function renderList(container, items, formatter) {
    if (!items || items.length === 0) {
        container.innerHTML = `<p>No information available.</p>`;
        return;
    }
    const listHTML = items.map(item => `<li>${formatter(item)}</li>`).join('');
    container.innerHTML = `<ul>${listHTML}</ul>`;
}

/**
 * Handles the response from an API call and updates the corresponding dashboard card.
 * @param {string} key - The identifier for the data type (e.g., 'profile', 'fees').
 * @param {object} data - The data payload from the API.
 */
function handleApiResponse(key, data) {
    // The 'profile' key is special as it updates multiple elements across the page.
    if (key === 'profile') {
        document.getElementById('welcome-header').textContent = `Welcome, ${data.first_name}! 🧑‍🎓`;
        const profileCard = document.getElementById('profile-card');
        if (profileCard) {
            profileCard.innerHTML = `
                <img src="${data.profile_photo_path ? `/${data.profile_photo_path}` : '/images/default-avatar.png'}" alt="Profile Photo" class="profile-photo">
                <div class="profile-card-details">
                    <h2><i class="fas fa-user-circle"></i>Profile</h2>
                    <div class="profile-grid">
                        <span>Name:</span><span>${data.first_name} ${data.last_name || ''}</span>
                        <span>Class:</span><span>${data.class_name || 'N/A'}</span>
                    </div>
                </div>`;
        }
        document.getElementById('services-card').innerHTML = `<h2><i class="fas fa-concierge-bell"></i>Services Availed</h2><div class="profile-grid"><span>Transport:</span> <span>${data.transport_required ? 'Yes' : 'No'}</span><span>Hostel:</span> <span>${data.hostel_required ? 'Yes' : 'No'}</span></div>`;
        document.getElementById('id-card-btn-container').innerHTML = `<a href="/id-card.html?id=${data.id}" class="button">View ID Card</a>`;
        return;
    }

    // For all other cards, use the configuration object.
    const renderer = cardRenderers[key];
    const cardElement = document.getElementById(`${key}-card`);
    if (renderer && cardElement) {
        if (typeof renderer === 'function') {
            // It's a custom renderer function (e.g., for fees, attendance, timetable).
            renderer(cardElement, data);
        } else {
            // It's a generic list-based renderer.
            cardElement.innerHTML = `<h2><i class="${renderer.icon}"></i>${renderer.title}</h2><div id="${key}-list-container"></div>`;
            const container = document.getElementById(`${key}-list-container`);
            renderList(container, data, renderer.formatter);
        }
    }
}

// --- 4. API Calls ---

/**
 * Fetches all necessary data for the dashboard in parallel.
 */
function fetchDashboardData() {
    const apiEndpoints = {
        profile: '/api/students/me',
        fees: '/api/fees/me',
        library: '/api/library/me/issued',
        attendance: '/api/attendance/me/summary',
        timetable: '/api/timetable/my-class',
        exams: '/api/exams/my-schedule',
        notices: '/api/notices/',
        assignments: '/api/academics/assignments',
        downloads: '/api/students/me/downloads',
        events: '/api/events'
    };

    const requests = Object.entries(apiEndpoints).map(([key, url]) =>
        fetch(url, { headers: authHeaders })
            .then(res => {
                if (!res.ok) return Promise.reject({ key, status: res.status });
                return res.json();
            })
            .then(data => ({ key, status: 'fulfilled', data }))
            .catch(error => ({ key: error.key || key, status: 'rejected', reason: error }))
    );

    Promise.allSettled(requests).then(results => {
        results.forEach(result => {
            if (result.value.status === 'fulfilled') {
                handleApiResponse(result.value.key, result.value.data);
            } else {
                console.error(`Error fetching ${result.value.key}:`, result.value.reason);
                const card = document.getElementById(`${result.value.key}-card`);
                if (card) {
                    card.innerHTML = `<p class="error-message">Could not load data.</p>`;
                }
            }
        });
    });
}

// --- 5. Event Handlers & Initial Load ---

/**
 * Logs the user out by clearing local storage and redirecting.
 */
function logout() {
    localStorage.removeItem('erp-token');
    localStorage.removeItem('user-role');
    window.location.href = '/login.html';
}

// Initial data load when the page is opened.
document.addEventListener('DOMContentLoaded', fetchDashboardData);

// Event listener for the refresh button.
document.getElementById('refresh-btn').addEventListener('click', (e) => {
    e.preventDefault();
    const allCards = document.querySelectorAll('.card');
    allCards.forEach(card => {
        // More robustly find the content area to apply skeleton
        const contentArea = card.querySelector('div:not(.profile-card-details)') || card.querySelector('p');
        if (contentArea && !card.id.includes('profile')) { // Don't blank the whole profile card
            contentArea.innerHTML = `<div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text"></div>`;
        }
    });
    fetchDashboardData();
});