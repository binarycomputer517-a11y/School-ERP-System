const { pool } = require('./database');

const NOTIFICATION_INTERVAL = 60000; // প্রতি ৬০ সেকেন্ডে একবার চলবে

// দূরত্ব মাপার ফাংশন (Haversine Formula)
function getDistMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's radius in meters
    const p1 = lat1 * Math.PI / 180;
    const p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180;
    const dl = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * ১. প্যারেন্ট অ্যাপে নোটিফিকেশন সেভ করার ফাংশন
 */
async function sendParentAppNotification(student, vehicle_id, vehicle_no, distance) {
    if (distance < 500) {
        try {
            // ২০ মিনিটের মধ্যে ডুপ্লিকেট নোটিফিকেশন চেক
            const checkLog = await pool.query(
                `SELECT id FROM proximity_notifications 
                 WHERE student_id = $1 AND sent_at > NOW() - INTERVAL '20 minutes'`,
                [student.student_uuid]
            );

            if (checkLog.rows.length === 0) {
                const parentUserId = student.parent_user_id; // স্কিমা অনুযায়ী parent_user_id
                
                if (parentUserId) {
                    const title = "Bus Arriving Soon! 🚌";
                    const message = `Bus ${vehicle_no} is within ${Math.round(distance)}m of your location. Please be ready.`;

                    // ক) পোর্টাল নোটিফিকেশন টেবিলে ইনসার্ট
                    await pool.query(
                        `INSERT INTO portal_notifications (user_id, title, message) VALUES ($1, $2, $3)`,
                        [parentUserId, title, message]
                    );

                    // খ) প্রক্সিমিটি লগ আপডেট (যাতে বারবার মেসেজ না যায়)
                    await pool.query(
                        `INSERT INTO proximity_notifications (student_id, vehicle_id) VALUES ($1, $2)`,
                        [student.student_uuid, vehicle_id]
                    );

                    console.log(`✅ [NOTIFIED] Parent of ${student.first_name} for Bus ${vehicle_no}`);
                }
            }
        } catch (err) {
            console.error("Portal Notification Logic Error:", err.message);
        }
    }
}

const checkBusLocationsAndSendAlerts = async () => {
    console.log(`[Worker] Checking bus proximity alerts... ${new Date().toLocaleTimeString()}`); 
    
    try {
        // ১. যে বাসগুলো বর্তমানে ট্রিপে আছে তাদের লোকেশন সহ ফেচ করুন
        const activeBusesQuery = `
            SELECT id, vehicle_no, current_coords, status 
            FROM transport_vehicles 
            WHERE status = 'on_trip' AND current_coords IS NOT NULL;
        `;
        const activeBuses = await pool.query(activeBusesQuery);

        for (const bus of activeBuses.rows) {
            const [bLat, bLng] = bus.current_coords.split(',').map(Number);

            // ২. এই বাসের সাথে যুক্ত স্টুডেন্টদের তথ্য এবং তাদের লোকেশন ফেচ করুন
            const studentsQuery = `
                SELECT 
                    s.student_id AS student_uuid,
                    s.first_name,
                    s.location_coords,
                    s.parent_user_id
                FROM student_transport_assignments sta
                JOIN students s ON sta.student_id = s.student_id
                WHERE sta.vehicle_id = $1 AND sta.is_active = TRUE;
            `;
            const students = await pool.query(studentsQuery, [bus.id]);

            for (const student of students.rows) {
                if (!student.location_coords) continue;

                const [sLat, sLng] = student.location_coords.split(',').map(Number);
                
                // ৩. দূরত্ব হিসেব করুন
                const distance = getDistMeters(bLat, bLng, sLat, sLng);

                // ৪. নোটিফিকেশন পাঠানোর ফাংশন কল করুন
                await sendParentAppNotification(student, bus.id, bus.vehicle_no, distance);
            }
        }

    } catch (error) {
        console.error('CRITICAL ERROR in Notification Service:', error.message);
    }
};

const startNotificationService = () => {
    checkBusLocationsAndSendAlerts(); 
    setInterval(checkBusLocationsAndSendAlerts, NOTIFICATION_INTERVAL);
    console.log("✅ Notification Service: Background monitoring active.");
};

module.exports = { 
    checkBusLocationsAndSendAlerts, 
    startNotificationService 
};