/**
 * js/calendar-manager-client.js
 * -----------------------------
 * Manages the logic for the School Academic Calendar page.
 * Fetches academic events, dynamically builds the calendar grid,
 * handles month navigation, and implements CLIENT-SIDE FILTERING.
 */

// --- Global State Management ---
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

// --- DOM Elements Registry ---
const dom = {
    grid: document.getElementById('calendar-grid-container'),
    monthTitle: document.getElementById('currentMonthYear'),
    prevBtn: document.getElementById('prevMonth'),
    nextBtn: document.getElementById('nextMonth'),
    upcomingList: document.getElementById('monthly-events-ul'),
    addEventForm: document.getElementById('add-event-form'),
    filterCheckboxes: document.querySelectorAll('.filter-checkbox')
};

// --- System Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // 1. Initial Core Load
    initCalendar();
    
    // 2. Setup Sidebar Filter Logic
    setupFilters();

    // 3. Setup Navigation Controls
    setupNavigation();

    // 4. Setup Event Management Form
    setupAddEventForm();
});

// =========================================================
// 1. CORE CALENDAR ENGINE
// =========================================================

/**
 * Orchestrates the full calendar rendering sequence
 */
async function initCalendar() {
    renderGridStructure(); // Render empty grid architecture first
    await fetchAndMergeEvents(); // Fetch data from server/local
    renderEvents(); // Inject event badges into cells
    renderUpcomingSidebar(); // Populate sidebar agenda
}

/**
 * Generates the month grid structure and handles date logic
 */
function renderGridStructure() {
    if (!dom.grid || !dom.monthTitle) return;

    dom.grid.innerHTML = '';

    // Update Calendar Header Title
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    dom.monthTitle.innerText = `${monthNames[currentMonth]} ${currentYear}`;

    // Calendar Calculations
    const firstDay = new Date(currentYear, currentMonth, 1).getDay();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const today = new Date();

    // Render Empty Leading Placeholder Cells
    for (let i = 0; i < firstDay; i++) {
        const empty = document.createElement('div');
        empty.classList.add('day-cell', 'empty');
        empty.style.backgroundColor = 'transparent'; 
        empty.style.border = 'none';
        dom.grid.appendChild(empty);
    }

    // Render Functional Day Cells
    for (let day = 1; day <= daysInMonth; day++) {
        const cell = document.createElement('div');
        cell.classList.add('day-cell');
        
        // Highlight Current System Date
        if (day === today.getDate() && currentMonth === today.getMonth() && currentYear === today.getFullYear()) {
            cell.classList.add('today');
        }

        const numSpan = document.createElement('span');
        numSpan.classList.add('day-number');
        numSpan.innerText = day;
        cell.appendChild(numSpan);

        // Container for dynamic event injection
        const eventContainer = document.createElement('div');
        eventContainer.id = `day-${currentYear}-${currentMonth}-${day}`; 
        cell.appendChild(eventContainer);

        dom.grid.appendChild(cell);
    }
}

// =========================================================
// 2. DATA SYNCHRONIZATION
// =========================================================

/**
 * Returns a static list of official institution holidays
 */
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

/**
 * Fetches events from API and merges them with official holidays
 */
async function fetchAndMergeEvents() {
    let dbEvents = [];
    try {
        // 
        const response = await window.authFetch('/api/calendar/events');
        if (response.ok) {
            dbEvents = await response.json();
        }
    } catch (e) {
        console.warn("Server unavailable. Operating in offline/local mode.");
    }

    const officialHolidays = getOfficialHolidays(currentYear);
    
    // Merge, Normalize, and Cache
    allEventsCache = [...officialHolidays, ...dbEvents].map(e => ({
        ...e,
        // Standardize date to ISO split to prevent timezone shifting
        start_date: e.start_date.split('T')[0] 
    }));
}

// =========================================================
// 3. RENDERING ENGINE
// =========================================================

/**
 * Injects event badges into the grid based on active filters
 */
function renderEvents() {
    // Cleanup previous render cycles
    document.querySelectorAll('.event-pill').forEach(el => el.remove());

    allEventsCache.forEach(event => {
        // Filter Normalization
        let typeKey = event.type.toLowerCase();
        if(typeKey === 'general_event') typeKey = 'general'; 
        
        if (!activeFilters[typeKey]) return; // Skip if user filtered out this type

        const [eYear, eMonth, eDay] = event.start_date.split('-').map(Number);

        // Validation: Ensure event belongs to the current month/year view
        if (eYear === currentYear && (eMonth - 1) === currentMonth) {
            const container = document.getElementById(`day-${currentYear}-${currentMonth}-${eDay}`);
            
            if (container) {
                const pill = document.createElement('span');
                
                // Type-based CSS mapping
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

/**
 * Populates the 'Upcoming Agenda' sidebar with future events
 */
function renderUpcomingSidebar() {
    if (!dom.upcomingList) return;
    dom.upcomingList.innerHTML = ''; 

    // Date logic for future-only events
    const todayStr = new Date().toISOString().split('T')[0];
    
    const upcoming = allEventsCache
        .filter(e => e.start_date >= todayStr)
        .sort((a, b) => a.start_date.localeCompare(b.start_date))
        .slice(0, 6); // Display top 6 upcoming items

    if (upcoming.length === 0) {
        dom.upcomingList.innerHTML = '<li class="text-center text-muted py-4 small">No upcoming events found in registry</li>';
        return;
    }

    upcoming.forEach(e => {
        const dateObj = new Date(e.start_date);
        const day = dateObj.getDate();
        const monthShort = dateObj.toLocaleString('default', { month: 'short' });
        
        // Dynamic Branding Colors
        let color = '#0A84FF'; // Default General
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
// 4. INTERACTION HANDLERS
// =========================================================

/**
 * Attaches month navigation listeners
 */
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

/**
 * Configures client-side sidebar filters
 */
function setupFilters() {
    const filterItems = document.querySelectorAll('.filter-item');
    const keys = ['exam', 'holiday', 'meeting', 'general'];

    filterItems.forEach((item, index) => {
        const checkbox = item.querySelector('.filter-checkbox');
        const key = keys[index];

        item.addEventListener('click', () => {
            // Toggle Logic State
            activeFilters[key] = !activeFilters[key];
            
            // Sync UI toggle visualization
            if (activeFilters[key]) {
                checkbox.style.backgroundColor = checkbox.style.borderColor; 
            } else {
                checkbox.style.backgroundColor = 'transparent'; 
            }
            
            // Trigger visual refresh (no API call needed)
            renderEvents();
        });
    });
}

/**
 * Re-runs full render cycle (called on month navigation)
 */
async function reRender() {
    renderGridStructure();
    // Only fetch if year changes to keep the official holiday list accurate
    await fetchAndMergeEvents(); 
    renderEvents();
}

/**
 * Handles the administrative form for creating new calendar events
 */
function setupAddEventForm() {
    if (!dom.addEventForm) return;

    dom.addEventForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = dom.addEventForm.querySelector('button[type="submit"]');
        const originalText = btn.innerText;
        btn.innerText = 'Synchronizing...';
        btn.disabled = true;

        const inputs = dom.addEventForm.elements;
        const payload = {
            title: inputs[0].value, 
            start_date: inputs[1].value, 
            type: inputs[2].value,
            description: inputs[3] ? inputs[3].value : null // Ensure optional description is handled
        };

        try {
            // 
            const res = await window.authFetch('/api/calendar/events', {
                method: 'POST',
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                // Terminate modal instance
                const modalEl = document.getElementById('addEventModal');
                const modal = bootstrap.Modal.getInstance(modalEl);
                if(modal) modal.hide();
                
                dom.addEventForm.reset();
                await fetchAndMergeEvents(); // Dynamic data refresh
                renderEvents();
                renderUpcomingSidebar();
            } else {
                alert("Authorization error or registry failure. Event was not saved.");
            }
        } catch (err) {
            console.error("Calendar Sync Error:", err);
            alert("Network connection error. Please verify server status.");
        } finally {
            btn.innerText = originalText;
            btn.disabled = false;
        }
    });
}