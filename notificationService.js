// notificationService.js

const { pool } = require('./database');

// Configuration 
const NOTIFICATION_INTERVAL = 60000; // 1 minute (60 seconds)
const TIME_WINDOW_MINUTES = 5; // Alert if the bus is within 5 minutes of arrival time

// --- Core Worker Function ---
const checkBusLocationsAndSendAlerts = async () => {
    // This function runs every minute (or similar interval)
    console.log(`Checking bus locations for proximity alerts... ${new Date().toLocaleTimeString()}`); 
    
    try {
        // NOTE: This assumes the failing query logic involves checking assignments based on route/stop IDs.

        // 1. Fetch all unique route/stop combinations that have active students.
        const activeAssignmentsQuery = `
            SELECT DISTINCT 
                sta.route_id, 
                sta.stop_id
            FROM student_transport_assignments sta
            WHERE sta.is_active = TRUE;
        `;
        const activeAlertTargets = await pool.query(activeAssignmentsQuery);

        if (activeAlertTargets.rows.length === 0) {
            console.log('No active transport assignments found to monitor.');
            return;
        }

        // 2. Iterate through each active route/stop combination
        for (const target of activeAlertTargets.rows) {
            
            // 3. Find students linked to this specific route/stop
            const studentsToNotifyQuery = `
                SELECT 
                    s.id AS student_id, 
                    u.id AS user_id, 
                    u.username,
                    s.phone_number
                FROM students s
                JOIN users u ON s.user_id = u.id
                JOIN student_transport_assignments sta ON s.id = sta.student_id
                WHERE 
                    /* 🛑 FIX APPLIED: Explicitly cast parameters to UUID to resolve 'uuid = integer' error. 
                       This ensures the database compares UUID strings against UUID columns. */
                    sta.route_id = $1::uuid AND 
                    sta.stop_id = $2::uuid; 
            `;

            const results = await pool.query(studentsToNotifyQuery, [
                target.route_id, 
                target.stop_id   
            ]);
            
            if (results.rows.length > 0) {
                console.log(`[ALERT] Found ${results.rows.length} students assigned to target stop.`);
                // --- Notification Logic Placeholder ---
            }
        }

    } catch (error) {
        // Log the error detail
        console.error('CRITICAL ERROR in notification service:', error);
    }
};

// --- Execution Starter Function ---
// 🛑 FIX: Define the starter function correctly using const.
const startNotificationService = () => {
    // Start the background task interval
    setInterval(checkBusLocationsAndSendAlerts, NOTIFICATION_INTERVAL);
    console.log("Notification Service initialized and running.");
};


// 🛑 FIX: Export both the worker function and the starter function
module.exports = { 
    checkBusLocationsAndSendAlerts, 
    startNotificationService 
};