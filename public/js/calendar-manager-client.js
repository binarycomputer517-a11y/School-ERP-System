/**
 * js/calendar-manager-client.js
 * -----------------------------
 * Manages the logic for the School Academic Calendar page.
 * Fetches academic events, dynamically builds the calendar grid,
 * handles month navigation, and implements ROLE-BASED FILTERING.
 */

// --- Global Constants ---
const CALENDAR_API_URL = '/api/calendar/events';

// --- DOM Elements ---
const currentMonthYear = document.getElementById('currentMonthYear');
const calendarGridContainer = document.getElementById('calendar-grid-container'); 
const prevMonthButton = document.getElementById('prevMonth');
const nextMonthButton = document.getElementById('nextMonth');
const monthlyEventsUl = document.getElementById('monthly-events-ul');

// --- Global State ---
let currentDate = new Date(); // Start with the current date

// =========================================================
// 1. HELPER FUNCTIONS (Authentication and Fetch)
// =========================================================

/**
 * A wrapper for the fetch API that includes the authentication token and session ID.
 * (This is the finalized, working version from previous debugging sessions.)
 */
async function fetchWithAuth(url, options = {}) {
    const token = localStorage.getItem('erp-token');
    if (!token) {
        // Redirect to login if token is missing
        // window.location.href = '/login.html'; 
        throw new Error('Authentication token not found.');
    }
    
    // CRITICAL: Ensure sessionId is retrieved and sent
    const sessionId = localStorage.getItem('active_session_id');
    const authHeaders = { 
        'Authorization': `Bearer ${token}`,
        'X-Session-ID': sessionId || '', // Send empty string if not found to avoid null header
        'Content-Type': 'application/json'
    };

    const headers = { ...authHeaders, ...options.headers };
    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ message: 'Server error.' }));
        console.error(`Fetch error from ${url}:`, errorBody);
        throw new Error(`Failed to fetch: ${errorBody.message}`);
    }

    return response.json();
}

/**
 * Fetches all relevant events (holidays, exams, meetings) from the backend API.
 */
async function fetchCalendarEvents() {
    try {
        // The API now handles the session ID fallback, so this call should succeed (200 OK)
        const events = await fetchWithAuth(CALENDAR_API_URL);
        console.log('Fetched Events:', events);
        return events;
    } catch (error) {
        console.error('Failed to fetch calendar events:', error);
        return [];
    }
}

// =========================================================
// 2. RENDERING LOGIC (With Role Filtering)
// =========================================================

/**
 * Renders the calendar grid and the event list for the current month.
 */
async function renderCalendar() {
    // 1. Get User Role for Filtering (CRITICAL FOR my-school-calendar.html vs school-calendar.html)
    const userRole = localStorage.getItem('erp-user-role'); 
    
    // Define which event types correspond to which user view
    // The backend now returns 'exam' and 'general_event' types.
    const studentEventTypes = ['exam', 'general_event']; // Student typically sees exams and academic/public holidays
    
    // 2. Clear existing content
    const daysContainer = calendarGridContainer;
    // Check if container is found (Should be fixed after HTML updates)
    if (!daysContainer || !monthlyEventsUl) {
        console.error("DOM elements for calendar rendering not found.");
        return; 
    }
    
    // Clear dynamically inserted day cells
    const existingCells = daysContainer.querySelectorAll('.day-cell');
    // Only remove cells *after* the 7 day-name headers (which are the first 7 children)
    Array.from(daysContainer.children).slice(7).forEach(cell => cell.remove());

    monthlyEventsUl.innerHTML = '';

    // 3. Determine Month Parameters
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth(); 
    const monthName = currentDate.toLocaleString('default', { month: 'long' });
    const today = new Date();

    // Set header
    currentMonthYear.textContent = `${monthName} ${year}`;

    const daysInMonth = new Date(year, month + 1, 0).getDate(); 
    const firstDayIndex = new Date(year, month, 1).getDay(); 

    // 4. Fetch All Events
    const allEvents = await fetchCalendarEvents(); 

    // 5. Filter Events Based on Role
    let visibleEvents;
    
    if (userRole === 'Student') {
        // Apply filter for students
        visibleEvents = allEvents.filter(event => studentEventTypes.includes(event.type));
    } else {
        // Admin, Super Admin, Teacher, Coordinator, etc., see all events
        visibleEvents = allEvents; 
    }

    // 6. Map Events to a simple date key for quick lookup
    const eventsByDate = {};
    visibleEvents.forEach(event => { 
        // NOTE: Uses new Date(event.date) to handle potential timestamp/string date formats
        const dateKey = new Date(event.date).toISOString().split('T')[0];
        if (!eventsByDate[dateKey]) {
            eventsByDate[dateKey] = [];
        }
        eventsByDate[dateKey].push(event);
    });

    // 7. Create Empty Leading Cells
    for (let i = 0; i < firstDayIndex; i++) {
        const emptyCell = document.createElement('div');
        emptyCell.classList.add('day-cell', 'empty');
        daysContainer.appendChild(emptyCell);
    }
    
    // 8. Create Day Cells and Inject Events
    let totalEventsForMonth = 0;
    for (let day = 1; day <= daysInMonth; day++) {
        const cell = document.createElement('div');
        cell.classList.add('day-cell');
        
        const dateNumber = document.createElement('span');
        dateNumber.textContent = day;
        cell.appendChild(dateNumber);
        
        // Check if this day is today (only compare date, month, year)
        const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
        if (isToday) {
            cell.classList.add('today-highlight'); // Use CSS class for complex styling
            dateNumber.style.color = '#ff9800';
            dateNumber.style.fontWeight = 'bold';
        }
        
        const dateKey = new Date(year, month, day).toISOString().split('T')[0];
        
        // Inject events for the current day
        if (eventsByDate[dateKey]) {
            eventsByDate[dateKey].forEach(event => {
                const eventElement = document.createElement('div');
                eventElement.classList.add('event', event.type); 
                eventElement.title = event.title;
                eventElement.textContent = event.title;
                cell.appendChild(eventElement);

                // Add to monthly summary list
                const listItem = document.createElement('li');
                listItem.textContent = `${day} ${monthName}: ${eventElement.title} (${event.type.replace('_', ' ')})`;
                monthlyEventsUl.appendChild(listItem);
                totalEventsForMonth++;
            });
        }
        
        daysContainer.appendChild(cell);
    }
    
    if (totalEventsForMonth === 0) {
        monthlyEventsUl.innerHTML = '<li>No major events scheduled this month.</li>';
    }
}

// =========================================================
// 3. EVENT HANDLERS
// =========================================================

/**
 * Changes the current month and re-renders the calendar.
 * @param {number} delta - +1 for next month, -1 for previous month.
 */
function changeMonth(delta) {
    currentDate.setMonth(currentDate.getMonth() + delta);
    renderCalendar();
}

// =========================================================
// 4. INITIALIZATION
// =========================================================

document.addEventListener('DOMContentLoaded', () => {
    // 1. Initial Render
    renderCalendar(); 

    // 2. Set up Navigation Listeners
    if (prevMonthButton) {
        prevMonthButton.addEventListener('click', () => changeMonth(-1));
    }
    if (nextMonthButton) {
        nextMonthButton.addEventListener('click', () => changeMonth(1));
    }
});