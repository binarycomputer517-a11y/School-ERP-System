/**
 * js/calendar-manager-client.js
 * -----------------------------
 * Manages the logic for the School Academic Calendar page.
 * Fetches academic events, dynamically builds the calendar grid,
 * handles month navigation, and implements CLIENT-SIDE FILTERING.
 */

// --- Global State ---
let currentDate = new Date();
let currentMonth = currentDate.getMonth();
let currentYear = currentDate.getFullYear();
let allEventsCache = []; // Stores all fetched events + generated holidays
let activeFilters = {
    exam: true,
    holiday: true,
    meeting: true,
    general: true
};

// --- DOM Elements ---
const dom = {
    grid: document.getElementById('calendar-grid-container'),
    monthTitle: document.getElementById('currentMonthYear'),
    prevBtn: document.getElementById('prevMonth'),
    nextBtn: document.getElementById('nextMonth'),
    upcomingList: document.getElementById('monthly-events-ul'),
    addEventForm: document.getElementById('add-event-form'),
    filterCheckboxes: document.querySelectorAll('.filter-checkbox')
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // 1. Initial Load
    initCalendar();
    
    // 2. Setup Sidebar Filters
    setupFilters();

    // 3. Setup Navigation
    setupNavigation();

    // 4. Setup Form
    setupAddEventForm();
});

// =========================================================
// 1. CORE LOGIC
// =========================================================

async function initCalendar() {
    renderGridStructure(); // Render empty grid first
    await fetchAndMergeEvents(); // Fetch data
    renderEvents(); // Populate data
    renderUpcomingSidebar(); // Populate sidebar
}

function renderGridStructure() {
    if (!dom.grid || !dom.monthTitle) return;

    dom.grid.innerHTML = '';

    // Update Header
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    dom.monthTitle.innerText = `${monthNames[currentMonth]} ${currentYear}`;

    // Calendar Math
    const firstDay = new Date(currentYear, currentMonth, 1).getDay();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const today = new Date();

    // Render Empty Leading Cells
    for (let i = 0; i < firstDay; i++) {
        const empty = document.createElement('div');
        empty.classList.add('day-cell', 'empty');
        empty.style.backgroundColor = 'transparent'; // Visual cleanup
        empty.style.border = 'none';
        dom.grid.appendChild(empty);
    }

    // Render Actual Days
    for (let day = 1; day <= daysInMonth; day++) {
        const cell = document.createElement('div');
        cell.classList.add('day-cell');
        
        // Highlight Today
        if (day === today.getDate() && currentMonth === today.getMonth() && currentYear === today.getFullYear()) {
            cell.classList.add('today');
        }

        const numSpan = document.createElement('span');
        numSpan.classList.add('day-number');
        numSpan.innerText = day;
        cell.appendChild(numSpan);

        // Container for events
        const eventContainer = document.createElement('div');
        eventContainer.id = `day-${currentYear}-${currentMonth}-${day}`; // Unique ID for injection
        cell.appendChild(eventContainer);

        dom.grid.appendChild(cell);
    }
}

// =========================================================
// 2. DATA FETCHING & MERGING
// =========================================================

function getOfficialHolidays(year) {
    return [
        { title: "New Year's Day", start_date: `${year}-01-01`, type: "holiday" },
        { title: "Republic Day", start_date: `${year}-01-26`, type: "holiday" },
        { title: "Netaji's Birthday", start_date: `${year}-01-23`, type: "holiday" },
        { title: "May Day", start_date: `${year}-05-01`, type: "holiday" },
        { title: "Independence Day", start_date: `${year}-08-15`, type: "holiday" },
        { title: "Gandhi Jayanti", start_date: `${year}-10-02`, type: "holiday" },
        { title: "Christmas", start_date: `${year}-12-25`, type: "holiday" }
    ];
}

async function fetchAndMergeEvents() {
    let dbEvents = [];
    try {
        const response = await window.authFetch('/api/calendar/events');
        if (response.ok) {
            dbEvents = await response.json();
        }
    } catch (e) {
        console.warn("Using offline/local mode for events.");
    }

    const officialHolidays = getOfficialHolidays(currentYear);
    
    // Merge and normalize dates
    allEventsCache = [...officialHolidays, ...dbEvents].map(e => ({
        ...e,
        // Ensure date is treated locally (fix timezone issues)
        start_date: e.start_date.split('T')[0] 
    }));
}

// =========================================================
// 3. RENDERING EVENTS
// =========================================================

function renderEvents() {
    // Clear previously rendered pills
    document.querySelectorAll('.event-pill').forEach(el => el.remove());

    allEventsCache.forEach(event => {
        // Filter Check
        let typeKey = event.type.toLowerCase();
        if(typeKey === 'general_event') typeKey = 'general'; // Normalize
        
        if (!activeFilters[typeKey]) return; // Skip if filter unchecked

        const [eYear, eMonth, eDay] = event.start_date.split('-').map(Number);

        // Check if event belongs to current view (Month is 0-indexed in JS, 1-indexed in Date string usually)
        // Adjusting: eMonth is 1-12, currentMonth is 0-11
        if (eYear === currentYear && (eMonth - 1) === currentMonth) {
            const container = document.getElementById(`day-${currentYear}-${currentMonth}-${eDay}`);
            
            if (container) {
                const pill = document.createElement('span');
                
                // Map types to CSS classes
                let cssClass = 'event-general';
                if(typeKey === 'exam') cssClass = 'event-exam';
                if(typeKey === 'holiday') cssClass = 'event-holiday';
                if(typeKey === 'meeting') cssClass = 'event-meeting';

                pill.className = `event-pill ${cssClass}`;
                pill.innerText = event.title;
                pill.title = event.title;
                
                container.appendChild(pill);
            }
        }
    });
}

function renderUpcomingSidebar() {
    if (!dom.upcomingList) return;
    dom.upcomingList.innerHTML = ''; // Clear

    // Filter logic: Only future events
    const todayStr = new Date().toISOString().split('T')[0];
    
    const upcoming = allEventsCache
        .filter(e => e.start_date >= todayStr)
        .sort((a, b) => a.start_date.localeCompare(b.start_date))
        .slice(0, 6); // Top 6

    if (upcoming.length === 0) {
        dom.upcomingList.innerHTML = '<li class="text-center text-muted py-4 small">No upcoming events found</li>';
        return;
    }

    upcoming.forEach(e => {
        const dateObj = new Date(e.start_date);
        const day = dateObj.getDate();
        const monthShort = dateObj.toLocaleString('default', { month: 'short' });
        
        // Colors
        let color = '#0A84FF'; // Blue
        if(e.type === 'exam') color = '#FF453A';
        if(e.type === 'holiday') color = '#BF5AF2';
        if(e.type === 'meeting') color = '#FF9F0A';

        const li = document.createElement('li');
        li.className = "event-list-item";
        li.style.cursor = 'default';
        li.innerHTML = `
            <div class="event-date-box" style="border-left: 3px solid ${color}">
                <span class="month-mini">${monthShort}</span>
                <span class="date-mini">${day}</span>
            </div>
            <div style="flex:1; min-width:0;">
                <div class="fw-bold text-truncate" style="font-size:0.9rem; color:var(--text-primary)">${e.title}</div>
                <div class="small text-secondary" style="text-transform:capitalize;">${e.type.replace('_', ' ')}</div>
            </div>
        `;
        dom.upcomingList.appendChild(li);
    });
}

// =========================================================
// 4. EVENT LISTENERS
// =========================================================

function setupNavigation() {
    if(dom.prevBtn) {
        dom.prevBtn.addEventListener('click', () => {
            currentMonth--;
            if (currentMonth < 0) { currentMonth = 11; currentYear--; }
            reRender();
        });
    }

    if(dom.nextBtn) {
        dom.nextBtn.addEventListener('click', () => {
            currentMonth++;
            if (currentMonth > 11) { currentMonth = 0; currentYear++; }
            reRender();
        });
    }
}

function setupFilters() {
    // Map sidebar text to filter keys manually since structure is custom
    const filterItems = document.querySelectorAll('.filter-item');
    
    // Order matches HTML: Exam, Holiday, Meeting, General
    const keys = ['exam', 'holiday', 'meeting', 'general'];

    filterItems.forEach((item, index) => {
        const checkbox = item.querySelector('.filter-checkbox');
        const key = keys[index];

        item.addEventListener('click', () => {
            // Toggle State
            activeFilters[key] = !activeFilters[key];
            
            // Visual Toggle
            if (activeFilters[key]) {
                checkbox.style.backgroundColor = checkbox.style.borderColor; // Fill
            } else {
                checkbox.style.backgroundColor = 'transparent'; // Outline
            }
            
            // Re-render Events only (no fetch needed)
            renderEvents();
        });
    });
}

async function reRender() {
    renderGridStructure();
    // Re-fetch only if year changed (to get dynamic holidays)
    await fetchAndMergeEvents(); 
    renderEvents();
}

function setupAddEventForm() {
    if (!dom.addEventForm) return;

    dom.addEventForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = dom.addEventForm.querySelector('button[type="submit"]');
        const originalText = btn.innerText;
        btn.innerText = 'Saving...';
        btn.disabled = true;

        const inputs = dom.addEventForm.elements;
        const payload = {
            title: inputs[0].value, // Title input
            start_date: inputs[1].value, // Date input
            type: inputs[2].value // Select input
        };

        try {
            const res = await window.authFetch('/api/calendar/events', {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                // Hide Modal
                const modalEl = document.getElementById('addEventModal');
                const modal = bootstrap.Modal.getInstance(modalEl);
                modal.hide();
                
                dom.addEventForm.reset();
                await fetchAndMergeEvents(); // Reload data
                renderEvents();
                renderUpcomingSidebar();
            } else {
                alert("Failed to save event.");
            }
        } catch (err) {
            console.error(err);
            alert("Error connecting to server.");
        } finally {
            btn.innerText = originalText;
            btn.disabled = false;
        }
    });
}