const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

const ALLOWED_STAFF = ['Admin', 'Super Admin'];

// --- Multer Storage Configuration ---
// Note: We use 'transport' to match the UPLOAD_DIRS in your server.js
const uploadDir = 'uploads/transport';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|pdf/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        if (extname) return cb(null, true);
        cb(new Error('Only images and PDFs are allowed'));
    }
});

// =================================================================
// 1. GET ALL VEHICLES
// =================================================================
router.get('/vehicles', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT v.*, 
            (SELECT COUNT(*) FROM student_transport_assignments WHERE vehicle_id = v.id AND is_active = TRUE) as occupied_seats,
            (v.insurance_expiry < CURRENT_DATE) as is_ins_expired,
            (v.fitness_expiry < CURRENT_DATE) as is_fit_expired,
            (v.license_expiry < CURRENT_DATE) as is_license_expired,
            (v.pollution_expiry < CURRENT_DATE) as is_pollution_expired
            FROM transport_vehicles v ORDER BY v.vehicle_no ASC;
        `;
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (err) {
        console.error('Fetch Error:', err.message);
        res.status(500).json({ error: 'Database error', details: err.message });
    }
});

// =================================================================
// 2. POST: REGISTER NEW VEHICLE
// =================================================================
router.post('/vehicles', authenticateToken, authorize(ALLOWED_STAFF), 
    upload.fields([
        { name: 'permit_file', maxCount: 1 },
        { name: 'doc_file', maxCount: 1 } // Matches 'doc_file' in your frontend FormData
    ]), 
    async (req, res) => {
        const { 
            vehicle_no, model, seating_capacity, 
            insurance_expiry, fitness_expiry, pollution_expiry,
            license_expiry, driver_phone 
        } = req.body;

        // Save paths relative to the 'uploads' folder for the frontend to pick up
        const permit_path = req.files['permit_file'] ? `transport/${req.files['permit_file'][0].filename}` : null;
        const doc_path = req.files['doc_file'] ? `transport/${req.files['doc_file'][0].filename}` : null;

        try {
            const insertQuery = `
                INSERT INTO transport_vehicles 
                (vehicle_no, model, seating_capacity, insurance_expiry, fitness_expiry, 
                 pollution_expiry, license_expiry, driver_phone, permit_path, 
                 doc_path, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'available') 
                RETURNING *;
            `;
            const { rows } = await pool.query(insertQuery, [
                vehicle_no, model, seating_capacity, 
                insurance_expiry || null, 
                fitness_expiry || null, 
                pollution_expiry || null, 
                license_expiry || null, 
                driver_phone, permit_path, doc_path
            ]);
            res.status(201).json(rows[0]);
        } catch (err) {
            console.error('Insert Error:', err.message);
            res.status(500).json({ error: 'Registration failed', detail: err.message });
        }
    }
);

// =================================================================
// 3. PUT: UPDATE VEHICLE
// =================================================================
router.put('/vehicles/:id', authenticateToken, authorize(ALLOWED_STAFF), 
    upload.fields([
        { name: 'permit_file', maxCount: 1 },
        { name: 'doc_file', maxCount: 1 }
    ]),
    async (req, res) => {
        const { id } = req.params;
        const { 
            model, seating_capacity, insurance_expiry, fitness_expiry, 
            pollution_expiry, license_expiry, driver_phone, status 
        } = req.body;

        try {
            const existing = await pool.query('SELECT permit_path, doc_path FROM transport_vehicles WHERE id = $1', [id]);
            if (existing.rows.length === 0) return res.status(404).json({ error: 'Vehicle not found' });

            // If a new file is uploaded, use it. Otherwise, keep the old one.
            const permit_path = req.files['permit_file'] ? `transport/${req.files['permit_file'][0].filename}` : existing.rows[0].permit_path;
            const doc_path = req.files['doc_file'] ? `transport/${req.files['doc_file'][0].filename}` : existing.rows[0].doc_path;
            
            const normalizedStatus = status ? status.toLowerCase() : 'available';

            const updateQuery = `
                UPDATE transport_vehicles 
                SET model=$1, seating_capacity=$2, insurance_expiry=$3, fitness_expiry=$4, 
                    pollution_expiry=$5, license_expiry=$6, driver_phone=$7, status=$8,
                    permit_path=$9, doc_path=$10
                WHERE id = $11 RETURNING *;
            `;
            const { rows } = await pool.query(updateQuery, [
                model, seating_capacity, insurance_expiry, fitness_expiry, 
                pollution_expiry, license_expiry, driver_phone, normalizedStatus,
                permit_path, doc_path, id
            ]);
            
            res.json({ message: 'Vehicle updated successfully', vehicle: rows[0] });
        } catch (err) {
            console.error('Update Error:', err.message);
            res.status(500).json({ error: 'Update failed', details: err.message });
        }
    }
);

// =================================================================
// 4. DELETE: REMOVE VEHICLE
// =================================================================
router.delete('/vehicles/:id', authenticateToken, authorize(ALLOWED_STAFF), async (req, res) => {
    try {
        const checkQuery = `SELECT COUNT(*) FROM student_transport_assignments WHERE vehicle_id = $1 AND is_active = TRUE`;
        const { rows } = await pool.query(checkQuery, [req.params.id]);
        
        if (parseInt(rows[0].count) > 0) {
            return res.status(400).json({ 
                error: 'Action denied: Active students are still assigned to this bus.' 
            });
        }

        const fileQuery = `SELECT permit_path, doc_path FROM transport_vehicles WHERE id = $1`;
        const fileData = await pool.query(fileQuery, [req.params.id]);

        if (fileData.rows.length > 0) {
            const { permit_path, doc_path } = fileData.rows[0];
            [permit_path, doc_path].forEach(filePath => {
                if (filePath) {
                    const fullPath = path.join(__dirname, '..', 'uploads', filePath);
                    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
                }
            });
        }

        await pool.query('DELETE FROM transport_vehicles WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: 'Vehicle and documents deleted successfully.' });

    } catch (err) {
        console.error('Delete Error:', err.message);
        res.status(500).json({ error: 'Deletion failed' });
    }
});

// =================================================================
// 5. GET STATS: SUMMARY
// =================================================================
router.get('/stats-summary', authenticateToken, async (req, res) => {
    try {
        const statsQuery = `
            SELECT 
                COUNT(*) as total_buses,
                COUNT(*) FILTER (WHERE status = 'available') as available,
                COUNT(*) FILTER (WHERE status = 'maintenance') as maintenance,
                COUNT(*) FILTER (WHERE status = 'on_trip') as on_trip,
                COUNT(*) FILTER (
                    WHERE insurance_expiry < CURRENT_DATE 
                    OR fitness_expiry < CURRENT_DATE 
                    OR pollution_expiry < CURRENT_DATE
                    OR license_expiry < CURRENT_DATE
                ) as compliance_alerts
            FROM transport_vehicles;
        `;
        const { rows } = await pool.query(statsQuery);
        res.json(rows[0]);
    } catch (err) {
        console.error('Stats Error:', err.message);
        res.status(500).json({ error: 'Stats fetch failed' });
    }
});

// GET: Search students for the Assignment Dropdown
router.get('/search-students', authenticateToken, async (req, res) => {
    const { term } = req.query;
    
    // ২ অক্ষরের কম সার্চ করলে রেজাল্ট দিবে না (পারফরম্যান্সের জন্য ভালো)
    if (!term || term.length < 2) {
        return res.json([]);
    }

    try {
        const query = `
            SELECT 
                s.student_id, 
                COALESCE(NULLIF(u.full_name, ''), s.first_name || ' ' || s.last_name) AS full_name, 
                s.roll_number, 
                u.username AS admission_no
            FROM students s
            JOIN users u ON s.user_id = u.id
            WHERE (
                u.full_name ILIKE $1 OR 
                s.first_name ILIKE $1 OR 
                s.last_name ILIKE $1 OR 
                s.roll_number ILIKE $1 OR 
                u.username ILIKE $1
            )
            AND s.status = 'Enrolled'
            AND u.is_active = true
            LIMIT 10;
        `;
        
        const searchTerm = `%${term}%`;
        const { rows } = await pool.query(query, [searchTerm]);
        res.json(rows);
    } catch (err) {
        console.error("Search API Error:", err.message);
        res.status(500).json({ error: "Search failed due to server error" });
    }
});

// POST: Save Transport Assignment
router.post('/assign', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { student_id, vehicle_id, bus_route_id, pickup_time } = req.body;

    try {
        // We use the 'student_transport_assignments' table we saw in your \d command earlier
        const query = `
            INSERT INTO student_transport_assignments 
            (student_id, vehicle_id, bus_route_id, pickup_time, is_active)
            VALUES ($1, $2, $3, $4, true)
            ON CONFLICT (student_id) 
            DO UPDATE SET 
                vehicle_id = EXCLUDED.vehicle_id, 
                bus_route_id = EXCLUDED.bus_route_id,
                pickup_time = EXCLUDED.pickup_time
            RETURNING *;
        `;
        const result = await pool.query(query, [student_id, vehicle_id, bus_route_id, pickup_time]);
        res.json({ success: true, message: "Transport assigned successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error during assignment" });
    }
});

// =================================================================
// 6. GET: ROSTER (FETCH STUDENTS ASSIGNED TO A SPECIFIC VEHICLE)
// =================================================================
router.get('/assignments/:vehicleId', authenticateToken, async (req, res) => {
    const { vehicleId } = req.params;
    try {
        const query = `
            SELECT 
                sta.id, 
                sta.student_id,
                sta.is_boarded,        -- Added to track if already in bus
                sta.is_missed,         -- Added for "Missed" state
                sta.is_waiting,        -- Added to highlight "I am here" students
                s.location_coords,
                COALESCE(NULLIF(u.full_name, ''), s.first_name || ' ' || s.last_name) AS full_name, 
                s.roll_number, 
                sta.pickup_time
            FROM student_transport_assignments sta
            JOIN students s ON sta.student_id = s.student_id
            JOIN users u ON s.user_id = u.id
            WHERE sta.vehicle_id = $1::uuid AND sta.is_active = TRUE
            ORDER BY sta.is_waiting DESC, sta.is_boarded ASC, full_name ASC;
        `;
        const { rows } = await pool.query(query, [vehicleId]);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Roster Fetch Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch roster' });
    }
});
// =================================================================
// 7. DELETE: REMOVE STUDENT FROM TRANSPORT
// =================================================================
router.delete('/assignments/:id', authenticateToken, authorize(ALLOWED_STAFF), async (req, res) => {
    try {
        await pool.query('DELETE FROM student_transport_assignments WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: 'Student removed from transport roster.' });
    } catch (err) {
        res.status(500).json({ error: 'Deletion failed' });
    }
});

// PUT: Update Student Pickup/Drop-off Location Coords
router.put('/student-location/:studentId', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { studentId } = req.params;
    const { coords } = req.body; // প্রত্যাশিত ফরম্যাট: "22.5726, 88.3639" (Lat, Lng)

    try {
        const query = `
            UPDATE students 
            SET location_coords = $1, updated_at = CURRENT_TIMESTAMP
            WHERE student_id = $2
            RETURNING student_id, location_coords;
        `;
        const { rows } = await pool.query(query, [coords, studentId]);

        if (rows.length === 0) {
            return res.status(404).json({ error: "Student not found" });
        }

        res.json({ success: true, message: "Location coordinates updated!", data: rows[0] });
    } catch (err) {
        console.error("Location Update Error:", err.message);
        res.status(500).json({ error: "Failed to update location" });
    }
});

// PUT: Update Bus Live Location (Used by Driver App)
router.put('/bus-location/:vehicleId', authenticateToken, async (req, res) => {
    const { vehicleId } = req.params;
    const { coords } = req.body; // e.g., "22.5726, 88.3639"

    try {
        await pool.query(
            `UPDATE transport_vehicles SET current_coords = $1, last_updated = CURRENT_TIMESTAMP WHERE id = $2`,
            [coords, vehicleId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET: All buses with their live coordinates
router.get('/live-locations', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT id, vehicle_no, model, status, current_coords 
            FROM transport_vehicles 
            WHERE status = 'on_trip' AND current_coords IS NOT NULL;
        `;
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =================================================================
// 8. GET: FETCH ALL STAFF WHO ARE DRIVERS (For Dropdown)
// =================================================================
router.get('/staff/drivers', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT ts.user_id, ts.license_no, u.full_name 
            FROM transport_staff ts
            JOIN users u ON ts.user_id = u.id
            WHERE ts.staff_type = 'driver' AND ts.is_active = true
        `;
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (err) {
        console.error('Fetch Drivers Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch drivers' });
    }
});

// =================================================================
// 9. POST: ASSIGN DRIVER TO A VEHICLE
// =================================================================
router.post('/assign-driver', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { userId, vehicleId } = req.body;

    if (!userId || !vehicleId) {
        return res.status(400).json({ error: "Driver and Vehicle must be selected" });
    }

    try {
        // transport_staff টেবিলে vehicle_id আপডেট করা
        const query = `
            UPDATE transport_staff 
            SET vehicle_id = $1 
            WHERE user_id = $2 AND staff_type = 'driver'
            RETURNING *;
        `;
        const { rows } = await pool.query(query, [vehicleId, userId]);

        if (rows.length === 0) {
            return res.status(404).json({ error: "Driver not found in transport staff" });
        }

        res.json({ success: true, message: "Driver assigned to vehicle successfully!", data: rows[0] });
    } catch (err) {
        console.error('Assign Driver Error:', err.message);
        res.status(500).json({ error: 'Database error during driver assignment' });
    }
});
// =================================================================
// 10. GET: DRIVER STATUS & ASSIGNED VEHICLE
// =================================================================
router.get('/driver/status', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                u.full_name, 
                ts.staff_type, 
                ts.license_no,
                v.id as vehicle_id,
                v.vehicle_no, 
                v.model,
                v.status as vehicle_status
            FROM users u
            JOIN transport_staff ts ON u.id = ts.user_id
            LEFT JOIN transport_vehicles v ON ts.vehicle_id = v.id
            WHERE u.id = $1::uuid AND ts.staff_type = 'driver'
        `;
        const { rows } = await pool.query(query, [req.user.id]);

        if (rows.length === 0) {
            return res.status(404).json({ error: "Driver profile not found" });
        }

        res.json(rows[0]);
    } catch (err) {
        console.error('Driver Status Error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =================================================================
// 11. GET: DRIVER'S VEHICLE COMPLIANCE & HEALTH
// =================================================================
router.get('/my-vehicle-health', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                v.vehicle_no,
                v.insurance_expiry,
                v.fitness_expiry,
                v.pollution_expiry,
                v.status,
                (v.insurance_expiry < CURRENT_DATE) as is_ins_expired,
                (v.fitness_expiry < CURRENT_DATE) as is_fit_expired,
                (v.pollution_expiry < CURRENT_DATE) as is_puc_expired
            FROM transport_vehicles v
            JOIN transport_staff ts ON v.id = ts.vehicle_id
            WHERE ts.user_id = $1
        `;
        const { rows } = await pool.query(query, [req.user.id]);

        if (rows.length === 0) {
            return res.status(404).json({ error: "No vehicle assigned to this driver." });
        }

        res.json(rows[0]);
    } catch (err) {
        console.error('Vehicle Health Error:', err.message);
        res.status(500).json({ error: 'Server error fetching vehicle health' });
    }
});

// =================================================================
// 12. POST: UPDATE LIVE LOCATION (Smart Auto-Detection)
// =================================================================
router.post('/update-location', authenticateToken, async (req, res) => {
    let { vehicle_id, latitude, longitude, coords, speed } = req.body;
    const userId = req.user.id; // JWT টোকেন থেকে পাওয়া ড্রাইভার আইডি

    try {
        // ১. যদি ফ্রন্টএন্ড থেকে vehicle_id না আসে, তবে ডাটাবেস থেকে ড্রাইভারের বাস খুঁজে বের করা
        if (!vehicle_id) {
            const driverInfo = await pool.query(
                'SELECT vehicle_id FROM transport_staff WHERE user_id = $1 AND staff_type = $2',
                [userId, 'driver']
            );
            vehicle_id = driverInfo.rows[0]?.vehicle_id;
        }

        // ২. কোঅর্ডিনেট ফরম্যাট করা
        let finalCoords = coords || (latitude && longitude ? `${latitude}, ${longitude}` : null);

        // ৩. ভ্যালিডেশন চেক (ড্রাইভারের সাথে বাস লিঙ্ক আছে কিনা এবং লোকেশন ডেটা আছে কিনা)
        if (!vehicle_id || !finalCoords) {
            console.error(`❌ Sync Failed - DriverID: ${userId}, VehicleID: ${vehicle_id}, Coords: ${finalCoords}`);
            return res.status(400).json({ 
                error: "Vehicle ID and Coordinates are required",
                reason: !vehicle_id ? "No vehicle assigned to this driver in database." : "GPS signal missing."
            });
        }

        // ৪. ডাটাবেস আপডেট (Location, Speed, and Status)
        const updateQuery = `
            UPDATE transport_vehicles 
            SET current_coords = $1, 
                last_updated = CURRENT_TIMESTAMP,
                status = 'on_trip'
            WHERE id = $2
            RETURNING vehicle_no;
        `;
        
        const { rows } = await pool.query(updateQuery, [finalCoords, vehicle_id]);

        if (rows.length === 0) {
            return res.status(404).json({ error: "Vehicle not found in vehicles table" });
        }

        // ৫. সাকসেস রেসপন্স
        res.json({ 
            success: true, 
            vehicle: rows[0].vehicle_no, 
            updated_at: new Date().toLocaleTimeString() 
        });

    } catch (err) {
        console.error('GPS Update Internal Error:', err.message);
        res.status(500).json({ error: 'Database update failed', details: err.message });
    }
});

// 13. GET: SPECIFIC BUS FOR STUDENT (Fixed Table Name: transport_routes)
router.get('/my-bus', authenticateToken, async (req, res) => {
    try {
        const userUuid = req.user.id; 
        const query = `
            SELECT 
                v.vehicle_no, 
                v.status,
                v.current_coords as live_coords,
                v.driver_phone,
                sta.pickup_time,
                r.route_name
            FROM student_transport_assignments sta
            JOIN students s ON sta.student_id = s.student_id
            JOIN transport_vehicles v ON sta.vehicle_id = v.id
            LEFT JOIN transport_routes r ON sta.bus_route_id = r.id
            WHERE s.user_id = $1::uuid AND sta.is_active = true`;

        const { rows } = await pool.query(query, [userUuid]);
        if (rows.length === 0) return res.status(404).json({ message: "No active bus assignment found." });

        const data = rows[0];
        let lat = 22.5726, lng = 88.3639; 
        if (data.live_coords && data.live_coords.includes(',')) {
            const split = data.live_coords.split(',');
            lat = parseFloat(split[0]); lng = parseFloat(split[1]);
        }

        res.json({
            route_name: data.route_name || `Bus ${data.vehicle_no}`,
            route_schedule: data.pickup_time || "Not Scheduled",
            vehicle_number: data.vehicle_no,
            driver_name: `Driver (Ph: ${data.driver_phone || 'N/A'})`,
            liveLocation: { lat, lng },
            status: data.status
        });
    } catch (err) {
        console.error('My Bus Fetch Error:', err.message);
        res.status(500).json({ error: 'Database error', detail: err.message });
    }
});

// =================================================================
// 14. STUDENT: NOTIFY DRIVER "I AM HERE"
// =================================================================
router.post('/student/signal-ready', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id; // UUID from JWT

        // Update the assignment based on the user's student profile
        const query = `
            UPDATE student_transport_assignments 
            SET is_waiting = true, 
                waiting_since = CURRENT_TIMESTAMP 
            WHERE student_id = (SELECT student_id FROM students WHERE user_id = $1::uuid)
            RETURNING id;
        `;
        
        const { rows } = await pool.query(query, [userId]);

        if (rows.length === 0) {
            return res.status(404).json({ error: "No transport assignment found for this student." });
        }

        res.json({ success: true, message: "Driver has been notified!" });
    } catch (err) {
        console.error('Signal Presence Error:', err.message);
        res.status(500).json({ error: 'Failed to notify driver' });
    }
});

// =================================================================
// 15. DRIVER: GET WAITING LIST (POLLING ENDPOINT)
// =================================================================
router.get('/driver/waiting-list', authenticateToken, async (req, res) => {
    try {
        const driverId = req.user.id;

        // Query to find students assigned to the driver's bus who are currently waiting
        const query = `
            SELECT 
                u.full_name, 
                sta.waiting_since
            FROM student_transport_assignments sta
            JOIN students s ON sta.student_id = s.student_id
            JOIN users u ON s.user_id = u.id
            JOIN transport_staff ts ON sta.vehicle_id = ts.vehicle_id
            WHERE ts.user_id = $1::uuid 
              AND sta.is_waiting = true
            ORDER BY sta.waiting_since DESC;
        `;

        const { rows } = await pool.query(query, [driverId]);

        res.json({
            count: rows.length,
            latest_name: rows.length > 0 ? rows[0].full_name : "",
            students: rows // Optional: detailed list for the "Pickup List" page
        });
    } catch (err) {
        console.error('Waiting List Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch waiting list' });
    }
});

// =================================================================
// 16. DRIVER: MARK STUDENT AS BOARDED
// =================================================================
router.post('/driver/mark-boarded', authenticateToken, async (req, res) => {
    const { student_id } = req.body;
    try {
        await pool.query(
            `UPDATE student_transport_assignments 
             SET is_boarded = true, 
                 is_waiting = false, 
                 is_missed = false,
                 boarded_at = CURRENT_TIMESTAMP 
             WHERE student_id = $1::uuid`, // Added UUID cast
            [student_id]
        );
        res.json({ success: true, message: "Student marked as boarded" });
    } catch (err) {
        console.error("Boarding error:", err.message);
        res.status(500).json({ error: "Failed to update boarding status" });
    }
});

// =================================================================
// 17. DRIVER: MARK STUDENT AS MISSED
// =================================================================
router.post('/driver/mark-missed', authenticateToken, async (req, res) => {
    const { student_id } = req.body;
    try {
        await pool.query(
            `UPDATE student_transport_assignments 
             SET is_missed = true, 
                 is_waiting = false, 
                 is_boarded = false 
             WHERE student_id = $1::uuid`, // Added UUID cast
            [student_id]
        );
        res.json({ success: true, message: "Student marked as missed" });
    } catch (err) {
        console.error("Missed error:", err.message);
        res.status(500).json({ error: "Failed to update missed status" });
    }
});

// =================================================================
// 18. ADMIN: GET ALL ACTIVE BUSES FOR GLOBAL MONITOR
// =================================================================
router.get('/admin/fleet-status', authenticateToken, authorize(ALLOWED_STAFF), async (req, res) => {
    try {
        const query = `
            SELECT 
                v.id as vehicle_id, 
                v.vehicle_no as vehicle_number, 
                v.status,
                v.model,
                v.current_coords,
                u.full_name as driver_name,
                (SELECT COUNT(*) 
                 FROM student_transport_assignments 
                 WHERE vehicle_id = v.id AND is_boarded = true AND is_active = true) as boarded_count
            FROM transport_vehicles v
            LEFT JOIN transport_staff ts ON v.id = ts.vehicle_id
            LEFT JOIN users u ON ts.user_id = u.id
            WHERE v.status IN ('on_trip', 'available');
        `;
        
        const { rows } = await pool.query(query);

        // ম্যাপের জন্য কোঅর্ডিনেট ফরম্যাট করা
        const fleetData = rows.map(bus => {
            let lat = 22.5726, lng = 88.3639; // ডিফল্ট লোকেশন
            if (bus.current_coords && bus.current_coords.includes(',')) {
                const parts = bus.current_coords.split(',');
                lat = parseFloat(parts[0]);
                lng = parseFloat(parts[1]);
            }
            return {
                vehicle_id: bus.vehicle_id,
                vehicle_number: bus.vehicle_number,
                status: bus.status,
                driver_name: bus.driver_name || 'Not Assigned',
                boarded_count: parseInt(bus.boarded_count) || 0,
                lat: lat,
                lng: lng
            };
        });

        res.json(fleetData);
    } catch (err) {
        console.error('Fleet Status API Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch fleet status' });
    }
});

// =================================================================
// 19. FUEL: GET LAST ENTRY FOR DRIVER (Fixes 404 in logs)
// =================================================================
router.get('/fuel/last-entry', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT f.*, v.vehicle_no 
            FROM transport_fuel_logs f
            JOIN transport_vehicles v ON f.vehicle_id = v.id
            WHERE f.driver_id = $1::uuid
            ORDER BY f.created_at DESC LIMIT 1;
        `;
        const { rows } = await pool.query(query, [req.user.id]);
        res.json(rows[0] || null);
    } catch (err) {
        console.error('Fuel Last Entry Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch last fuel entry' });
    }
});

// =================================================================
// 20. FUEL: POST NEW LOG ENTRY
// =================================================================
router.post('/fuel/add', authenticateToken, async (req, res) => {
    const { vehicle_id, fuel_quantity, fuel_price, odometer_reading, fuel_station_name } = req.body;

    if (!vehicle_id || !fuel_quantity || !fuel_price || !odometer_reading) {
        return res.status(400).json({ error: "All fields are required" });
    }

    try {
        const query = `
            INSERT INTO transport_fuel_logs 
            (vehicle_id, driver_id, fuel_quantity, fuel_price, odometer_reading, fuel_station_name)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
            RETURNING *;
        `;
        const { rows } = await pool.query(query, [
            vehicle_id, 
            req.user.id, 
            fuel_quantity, 
            fuel_price, 
            odometer_reading, 
            fuel_station_name || 'N/A'
        ]);

        res.status(201).json({ success: true, message: "Fuel log saved successfully!", data: rows[0] });
    } catch (err) {
        console.error('Fuel Add Error:', err.message);
        res.status(500).json({ error: 'Failed to save fuel log' });
    }
});

// =================================================================
// 21. FUEL: GET FUEL HISTORY (Fixes 404 in logs)
// =================================================================
router.get('/fuel/history', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT f.*, v.vehicle_no 
            FROM transport_fuel_logs f
            JOIN transport_vehicles v ON f.vehicle_id = v.id
            WHERE f.driver_id = $1::uuid
            ORDER BY f.created_at DESC;
        `;
        const { rows } = await pool.query(query, [req.user.id]);
        res.json(rows);
    } catch (err) {
        console.error('Fuel History Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch fuel history' });
    }
});

// =================================================================
// 22. ADMIN: FUEL ANALYTICS (For Fleet Hub)
// =================================================================
router.get('/admin/fuel-stats', authenticateToken, authorize(ALLOWED_STAFF), async (req, res) => {
    try {
        const query = `
            SELECT 
                v.vehicle_no,
                SUM(f.total_cost) as total_spent,
                AVG(f.fuel_price) as avg_price,
                MAX(f.odometer_reading) - MIN(f.odometer_reading) as total_distance
            FROM transport_fuel_logs f
            JOIN transport_vehicles v ON f.vehicle_id = v.id
            WHERE f.created_at > NOW() - INTERVAL '30 days'
            GROUP BY v.vehicle_no;
        `;
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch fuel stats' });
    }
});

// =================================================================
// 21. POST: ADD NEW DRIVER (Creates User + Staff Profile)
// =================================================================
router.post('/staff/add-driver', authenticateToken, authorize(ALLOWED_STAFF), async (req, res) => {
    const { username, password, full_name, email, phone_number, license_no, license_expiry } = req.body;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ১. পাসওয়ার্ড হ্যাস করা (Security-র জন্য বাধ্যতামূলক)
        // যদি আপনার সিস্টেমে অলরেডি হ্যাস করা থাকে তবে এই অংশটি এড়িয়ে যেতে পারেন
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // ২. Create User Account 
        // আপনার ডাটাবেস অনুযায়ী কলামের নাম password_hash এবং branch_id (যদি দরকার হয়)
        const userRes = await client.query(
            `INSERT INTO users (username, password_hash, full_name, email, phone_number, role, is_active) 
             VALUES ($1, $2, $3, $4, $5, 'Driver', true) RETURNING id`,
            [username, hashedPassword, full_name, email, phone_number]
        );
        const userId = userRes.rows[0].id;

        // ৩. Create Transport Staff Profile
        await client.query(
            `INSERT INTO transport_staff (user_id, license_no, license_expiry, staff_type, is_active) 
             VALUES ($1, $2, $3, 'driver', true)`,
            [userId, license_no, license_expiry || null] // তারিখ না থাকলে null যাবে
        );

        await client.query('COMMIT');
        res.status(201).json({ success: true, message: "Driver created successfully" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("DB Error:", err.message);
        
        // ডুপ্লিকেট ইউজার বা ইমেইল চেক করার জন্য
        if (err.code === '23505') {
            return res.status(400).json({ error: "Username, Email, or License Number already exists." });
        }
        res.status(500).json({ error: "Failed to create driver.", detail: err.message });
    } finally {
        client.release();
    }
});

// =================================================================
// 22. GET: FETCH ALL DRIVERS (Detailed List for Management)
// =================================================================
router.get('/staff/drivers-list', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                u.id, u.full_name, u.username, u.email, u.phone_number, 
                ts.license_no, ts.license_expiry, ts.is_active
            FROM users u
            JOIN transport_staff ts ON u.id = ts.user_id
            WHERE ts.staff_type = 'driver'
            ORDER BY u.full_name ASC;
        `;
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Failed to fetch driver list" });
    }
});

// =================================================================
// 23. PUT: UPDATE DRIVER DETAILS
// =================================================================
router.put('/staff/update/:id', authenticateToken, authorize(ALLOWED_STAFF), async (req, res) => {
    const { id } = req.params;
    const { full_name, phone_number, license_expiry, is_active } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Users টেবিল আপডেট
        await client.query(
            'UPDATE users SET full_name = $1, phone_number = $2 WHERE id = $3',
            [full_name, phone_number, id]
        );

        // Transport Staff টেবিল আপডেট
        await client.query(
            'UPDATE transport_staff SET license_expiry = $1, is_active = $2 WHERE user_id = $3',
            [license_expiry, is_active, id]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: "Driver updated successfully" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: "Update failed" });
    } finally {
        client.release();
    }
});

// ... আগের সব কোড এখানে থাকবে (Multer, Register Vehicle, Add Driver ইত্যাদি)

// =================================================================
// 24. DRIVER: FINISH TRIP (New Route to fix 404)
// =================================================================
router.post('/driver/finish-trip', authenticateToken, async (req, res) => {
    const userId = req.user.id;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ১. ড্রাইভারের সাথে যুক্ত বাসের আইডি খুঁজে বের করা
        const driverInfo = await client.query(
            'SELECT vehicle_id FROM transport_staff WHERE user_id = $1 AND staff_type = $2',
            [userId, 'driver']
        );
        const vehicleId = driverInfo.rows[0]?.vehicle_id;

        if (!vehicleId) {
            return res.status(404).json({ error: "No vehicle assigned to this driver." });
        }

        // ২. বাসের স্ট্যাটাস 'available' করা এবং কোঅর্ডিনেট রিসেট করা
        await client.query(
            `UPDATE transport_vehicles 
             SET status = 'available', current_coords = NULL, last_updated = CURRENT_TIMESTAMP 
             WHERE id = $1`,
            [vehicleId]
        );

        // ৩. এই বাসের সব স্টুডেন্টের ট্রিপ স্ট্যাটাস রিসেট করা (পরবর্তী ট্রিপের জন্য)
        await client.query(
            `UPDATE student_transport_assignments 
             SET is_boarded = false, is_waiting = false, is_missed = false, 
                 boarded_at = NULL, waiting_since = NULL 
             WHERE vehicle_id = $1`,
            [vehicleId]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: "Trip finished. Bus is now available." });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Finish Trip Error:', err.message);
        res.status(500).json({ error: 'Failed to finish trip' });
    } finally {
        client.release();
    }
});

// =================================================================
// 25. FUEL: UPDATED ADD LOG (With Total Cost Auto-Calculation)
// =================================================================
router.post('/fuel/add', authenticateToken, async (req, res) => {
    const { vehicle_id, fuel_quantity, fuel_price, odometer_reading, fuel_station_name } = req.body;

    if (!vehicle_id || !fuel_quantity || !fuel_price || !odometer_reading) {
        return res.status(400).json({ error: "Required fields missing" });
    }

    try {
        // টোটাল কস্ট ক্যালকুলেশন
        const total_cost = parseFloat(fuel_quantity) * parseFloat(fuel_price);

        const query = `
            INSERT INTO transport_fuel_logs 
            (vehicle_id, driver_id, fuel_quantity, fuel_price, total_cost, odometer_reading, fuel_station_name)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
            RETURNING *;
        `;
        const { rows } = await pool.query(query, [
            vehicle_id, req.user.id, fuel_quantity, fuel_price, total_cost, odometer_reading, fuel_station_name || 'N/A'
        ]);

        res.status(201).json({ success: true, message: "Fuel log saved!", data: rows[0] });
    } catch (err) {
        console.error('Fuel Add Error:', err.message);
        res.status(500).json({ error: 'Database update failed' });
    }
});

// =================================================================
// 26. ADMIN: GET ALL DRIVERS (Quick Summary for UI)
// =================================================================
router.get('/staff/drivers-summary', authenticateToken, authorize(ALLOWED_STAFF), async (req, res) => {
    try {
        const query = `
            SELECT 
                u.full_name, 
                v.vehicle_no, 
                ts.is_active,
                v.status as bus_status
            FROM transport_staff ts
            JOIN users u ON ts.user_id = u.id
            LEFT JOIN transport_vehicles v ON ts.vehicle_id = v.id
            WHERE ts.staff_type = 'driver';
        `;
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch drivers" });
    }
});

module.exports = router;