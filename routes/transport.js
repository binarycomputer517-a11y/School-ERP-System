const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// =========================================================
// DATABASE TABLE CONSTANTS
// =========================================================
const DRIVERS_TABLE = 'transport_drivers';
const VEHICLES_TABLE = 'transport_vehicles';
const ROUTES_TABLE = 'transport_routes';
const STOPS_TABLE = 'route_stops';
const ASSIGNMENTS_TABLE = 'student_transport_assignments';
const USERS_TABLE = 'users';
const STUDENTS_TABLE = 'students'; 
const MAINTENANCE_TABLE = 'vehicle_maintenance';
const DOCUMENTS_TABLE = 'vehicle_documents';
const ATTENDANCE_TABLE = 'transport_attendance'; 

// =========================================================
// FILE UPLOAD CONFIGURATION
// =========================================================
const TRANSPORT_UPLOAD_BASE_PATH = '/uploads/transport'; 
const DOCUMENT_UPLOAD_BASE_PATH = '/uploads/documents';  

// --- FILE UPLOAD HELPER ---
function executeUpload(req, res, fieldName, baseUploadPath, successCallback) {
    const uploadInstance = req.app.get('upload');
    if (!uploadInstance || typeof uploadInstance.single !== 'function') {
        console.error("Multer 'upload' instance is missing or misconfigured in server.js.");
        return res.status(500).json({ message: "File upload service is unavailable." });
    }

    const uploadMiddleware = uploadInstance.single(fieldName);

    uploadMiddleware(req, res, async (err) => {
        if (err) {
            console.error(`Multer Upload Error for field '${fieldName}':`, err);
            return res.status(500).json({ message: `File upload failed: ${err.message}` });
        }
        if (!req.file) {
            return res.status(400).json({ message: `No file uploaded. Ensure field name is "${fieldName}".` });
        }
        try {
            const fileUrl = `${baseUploadPath}/${req.file.filename}`;
            await successCallback(fileUrl);
            res.status(200).json({ message: 'File uploaded successfully.', file_url: fileUrl });
        } catch (error) {
            console.error('Database Error after successful upload:', error);
            res.status(500).json({ message: 'Database failed to record file URL.' });
        }
    });
}

// =========================================================
// 1. VEHICLE MANAGEMENT
// =========================================================

router.get('/vehicles', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const query = `
            SELECT 
                v.id, v.vehicle_number, v.model, v.capacity, v.photo_url, v.assigned_driver_id,
                d.full_name AS driver_name
            FROM ${VEHICLES_TABLE} v
            LEFT JOIN ${DRIVERS_TABLE} d ON v.assigned_driver_id = d.id
            ORDER BY v.vehicle_number;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching vehicles:', error);
        res.status(500).json({ message: 'Failed to retrieve vehicles.' });
    }
});

router.post('/vehicles', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { vehicle_number, model, capacity } = req.body;
    try {
        const query = `
            INSERT INTO ${VEHICLES_TABLE} (vehicle_number, model, capacity)
            VALUES ($1, $2, $3)
            RETURNING id;
        `;
        const result = await pool.query(query, [vehicle_number, model, capacity]);
        res.status(201).json({ message: 'Vehicle added successfully.', id: result.rows[0].id });
    } catch (error) {
        console.error('Error adding vehicle:', error);
        res.status(500).json({ message: 'Failed to add vehicle.' });
    }
});

router.put('/vehicles/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    const { model, capacity } = req.body;
    try {
        const query = `UPDATE ${VEHICLES_TABLE} SET model = $1, capacity = $2 WHERE id = $3;`;
        await pool.query(query, [model, capacity, id]);
        res.status(200).json({ message: 'Vehicle updated successfully.' });
    } catch (error) {
        console.error('Error updating vehicle:', error);
        res.status(500).json({ message: 'Failed to update vehicle.' });
    }
});

router.put('/vehicles/:id/assign-driver', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    const { driver_id } = req.body;
    try {
        const query = `UPDATE ${VEHICLES_TABLE} SET assigned_driver_id = $1 WHERE id = $2;`;
        await pool.query(query, [driver_id || null, id]);
        res.status(200).json({ message: 'Driver assignment updated successfully.' });
    } catch (error) {
        console.error('Error assigning driver:', error);
        res.status(500).json({ message: 'Failed to assign driver.' });
    }
});

router.post('/vehicles/:id/photo', authenticateToken, authorize(['Admin', 'Super Admin']), (req, res) => {
    const { id } = req.params;
    executeUpload(req, res, 'photo', TRANSPORT_UPLOAD_BASE_PATH, async (photoUrl) => {
        await pool.query(`UPDATE ${VEHICLES_TABLE} SET photo_url = $1 WHERE id = $2;`, [photoUrl, id]);
    });
});

router.delete('/vehicles/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        const assignmentCheck = await pool.query(`SELECT id FROM ${ROUTES_TABLE} WHERE vehicle_id = $1;`, [id]);
        if (assignmentCheck.rowCount > 0) {
            return res.status(409).json({ message: 'Cannot delete vehicle. It is assigned to a route.' });
        }
        await pool.query(`DELETE FROM ${VEHICLES_TABLE} WHERE id = $1;`, [id]);
        res.status(200).json({ message: 'Vehicle deleted successfully.' });
    } catch (error) {
        console.error('Error deleting vehicle:', error);
        res.status(500).json({ message: 'Failed to delete vehicle.' });
    }
});

// =========================================================
// 2. DRIVER MANAGEMENT
// =========================================================

router.get('/drivers', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM ${DRIVERS_TABLE} ORDER BY full_name;`);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching drivers:', error);
        res.status(500).json({ message: 'Failed to retrieve drivers.' });
    }
});

router.post('/drivers', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { full_name, license_number, phone_number } = req.body;
    try {
        const query = `
            INSERT INTO ${DRIVERS_TABLE} (full_name, license_number, phone_number)
            VALUES ($1, $2, $3) RETURNING id;
        `;
        const result = await pool.query(query, [full_name, license_number, phone_number]);
        res.status(201).json({ message: 'Driver added successfully.', id: result.rows[0].id });
    } catch (error) {
        console.error('Error adding driver:', error);
        res.status(500).json({ message: 'Failed to add driver.' });
    }
});

router.put('/drivers/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    const { full_name, phone_number } = req.body;
    try {
        await pool.query(`UPDATE ${DRIVERS_TABLE} SET full_name = $1, phone_number = $2 WHERE id = $3;`, [full_name, phone_number, id]);
        res.status(200).json({ message: 'Driver updated successfully.' });
    } catch (error) {
        console.error('Error updating driver:', error);
        res.status(500).json({ message: 'Failed to update driver.' });
    }
});

router.post('/drivers/:id/license', authenticateToken, authorize(['Admin', 'Super Admin']), (req, res) => {
    const { id } = req.params;
    executeUpload(req, res, 'license', TRANSPORT_UPLOAD_BASE_PATH, async (url) => {
        await pool.query(`UPDATE ${DRIVERS_TABLE} SET license_photo_url = $1 WHERE id = $2;`, [url, id]);
    });
});

router.delete('/drivers/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query(`DELETE FROM ${DRIVERS_TABLE} WHERE id = $1;`, [id]);
        res.status(200).json({ message: 'Driver deleted successfully.' });
    } catch (error) {
        console.error('Error deleting driver:', error);
        res.status(500).json({ message: 'Failed to delete driver.' });
    }
});

// =========================================================
// 3. ROUTE MANAGEMENT
// =========================================================

router.get('/routes', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const query = `
            SELECT r.id, r.route_name, r.vehicle_id, r.monthly_fee, v.vehicle_number
            FROM ${ROUTES_TABLE} r
            LEFT JOIN ${VEHICLES_TABLE} v ON r.vehicle_id = v.id
            ORDER BY r.route_name;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching routes:', error);
        res.status(500).json({ message: 'Failed to retrieve routes.' });
    }
});

router.post('/routes', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { route_name, vehicle_id, stops, monthly_fee } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const routeRes = await client.query(
            `INSERT INTO ${ROUTES_TABLE} (route_name, vehicle_id, monthly_fee) VALUES ($1, $2, $3) RETURNING id;`,
            [route_name, vehicle_id || null, monthly_fee || 0]
        );
        const routeId = routeRes.rows[0].id;

        if (stops && stops.length > 0) {
            for (let i = 0; i < stops.length; i++) {
                await client.query(
                    `INSERT INTO ${STOPS_TABLE} (route_id, stop_name, stop_sequence) VALUES ($1, $2, $3);`,
                    [routeId, stops[i], i + 1]
                );
            }
        }
        await client.query('COMMIT');
        res.status(201).json({ message: 'Route added successfully.', id: routeId });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding route:', error);
        res.status(500).json({ message: 'Failed to add route.' });
    } finally {
        client.release();
    }
});

router.put('/routes/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    const { route_name, vehicle_id, stops, monthly_fee } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `UPDATE ${ROUTES_TABLE} SET route_name = $1, vehicle_id = $2, monthly_fee = $3 WHERE id = $4;`,
            [route_name, vehicle_id || null, monthly_fee || 0, id]
        );
        await client.query(`DELETE FROM ${STOPS_TABLE} WHERE route_id = $1;`, [id]);
        if (stops && stops.length > 0) {
            for (let i = 0; i < stops.length; i++) {
                await client.query(
                    `INSERT INTO ${STOPS_TABLE} (route_id, stop_name, stop_sequence) VALUES ($1, $2, $3);`,
                    [id, stops[i], i + 1]
                );
            }
        }
        await client.query('COMMIT');
        res.status(200).json({ message: 'Route updated successfully.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating route:', error);
        res.status(500).json({ message: 'Failed to update route.' });
    } finally {
        client.release();
    }
});

router.get('/routes/:id/details', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        const routeQuery = `
            SELECT r.route_name, s.stop_name, s.stop_sequence, 
                   34.0000 + (s.stop_sequence * 0.01) AS latitude,
                   -118.0000 + (s.stop_sequence * 0.01) AS longitude
            FROM ${ROUTES_TABLE} r
            JOIN ${STOPS_TABLE} s ON r.id = s.route_id
            WHERE r.id = $1
            ORDER BY s.stop_sequence ASC;
        `;
        const result = await pool.query(routeQuery, [id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Route not found.' });

        const stops = result.rows;
        const path = stops.map(s => [parseFloat(s.latitude), parseFloat(s.longitude)]);
        res.status(200).json({
            route_name: stops[0].route_name,
            path: path,
            start: path[0],
            end: path[path.length - 1]
        });
    } catch (error) {
        console.error('Error fetching route details:', error);
        res.status(500).json({ message: 'Failed to retrieve detailed route data.' });
    }
});

router.get('/routes/:id/stops', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(`SELECT stop_name FROM ${STOPS_TABLE} WHERE route_id = $1 ORDER BY stop_sequence;`, [id]);
        res.status(200).json(result.rows.map(row => row.stop_name));
    } catch (error) {
        console.error('Error fetching route stops:', error);
        res.status(500).json({ message: 'Failed to retrieve route stops.' });
    }
});

/**
 * @route   GET /api/transport/routes/:id/students
 */
router.get('/routes/:id/students', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT 
                s.first_name || ' ' || s.last_name AS student_name,
                ta.boarding_stop,
                ta.dropping_stop 
            FROM ${ASSIGNMENTS_TABLE} ta
            JOIN ${STUDENTS_TABLE} s ON ta.student_id = s.student_id
            WHERE ta.route_id = $1;
        `;
        const result = await pool.query(query, [id]); 
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching students on route:', error);
        res.status(500).json({ message: `Failed to retrieve students: ${error.message}` });
    }
});

router.delete('/routes/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const check = await client.query(`SELECT student_id FROM ${ASSIGNMENTS_TABLE} WHERE route_id = $1;`, [id]);
        if (check.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'Cannot delete route. Students are assigned to it.' });
        }
        await client.query(`DELETE FROM ${STOPS_TABLE} WHERE route_id = $1;`, [id]);
        await client.query(`DELETE FROM ${ROUTES_TABLE} WHERE id = $1;`, [id]);
        await client.query('COMMIT');
        res.status(200).json({ message: 'Route deleted successfully.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting route:', error);
        res.status(500).json({ message: 'Failed to delete route.' });
    } finally {
        client.release();
    }
});

// =========================================================
// 3.4. HELPER: GET STUDENTS FOR DROPDOWN
// =========================================================
router.get('/candidates', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const query = `
            SELECT student_id, first_name, last_name, roll_number, admission_id
            FROM ${STUDENTS_TABLE} 
            WHERE status = 'Enrolled' 
            ORDER BY first_name;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching student candidates:', error);
        res.status(500).json({ message: 'Failed to retrieve student list.' });
    }
});

// =========================================================
// 3.5. STUDENT ASSIGNMENT
// =========================================================
router.post('/assign', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { student_id, route_id, boarding_stop, dropping_stop } = req.body;
    const monthly_fee = req.body.monthly_fee || 0; 
    
    try {
        const checkQuery = `SELECT student_id FROM ${STUDENTS_TABLE} WHERE student_id = $1;`;
        const checkResult = await pool.query(checkQuery, [student_id]);

        if (checkResult.rowCount === 0) {
            return res.status(404).json({ message: 'Student record not found. Check Student ID.' });
        }

        const assignmentQuery = `
            INSERT INTO ${ASSIGNMENTS_TABLE} (student_id, route_id, boarding_stop, dropping_stop, monthly_fee)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (student_id) DO UPDATE 
            SET route_id = $2, boarding_stop = $3, dropping_stop = $4, monthly_fee = $5;
        `;
        
        await pool.query(assignmentQuery, [student_id, route_id, boarding_stop, dropping_stop, monthly_fee]);
        
        res.status(201).json({ message: 'Student assigned to route successfully.' });
    } catch (error) {
        console.error('Error assigning student:', error);
        if (error.code === '23503') { 
             return res.status(400).json({ message: 'Invalid Route ID or Student ID.' });
        }
        res.status(500).json({ message: 'Failed to assign transport.' });
    }
});

// =========================================================
// 4. LIVE STATUS & MOCK
// =========================================================

router.get('/routes/:id/status', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        const stopsRes = await pool.query(`SELECT stop_name FROM ${STOPS_TABLE} WHERE route_id = $1 ORDER BY stop_sequence;`, [id]);
        const stops = stopsRes.rows.map(row => row.stop_name);
        
        res.status(200).json({
            pickupLocation: stops.length > 0 ? stops[0] : 'N/A',
            dropLocation: stops.length > 1 ? stops[stops.length - 1] : 'N/A',
            liveLocation: { lat: '34.0522', lng: '-118.2437' },
            status: 'In Transit'
        });
    } catch (error) { 
        console.error('Error fetching route status:', error);
        res.status(500).json({ message: 'Failed to retrieve status.' });
    }
});

// =========================================================
// 5. REPORTING ENDPOINTS
// =========================================================

router.get('/reports/summary', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const query = `
            SELECT 
                (SELECT COUNT(id) FROM ${VEHICLES_TABLE}) AS total_vehicles,
                (SELECT COUNT(id) FROM ${DRIVERS_TABLE}) AS total_drivers,
                (SELECT COUNT(id) FROM ${ROUTES_TABLE}) AS total_routes,
                (SELECT COUNT(DISTINCT student_id) FROM ${ASSIGNMENTS_TABLE}) AS students_assigned;
        `;
        const result = await pool.query(query);
        const data = result.rows[0];
        res.status(200).json({
            total_vehicles: parseInt(data.total_vehicles || 0),
            total_drivers: parseInt(data.total_drivers || 0),
            total_routes: parseInt(data.total_routes || 0),
            students_assigned: parseInt(data.students_assigned || 0)
        });
    } catch (error) { 
        console.error('Error fetching summary:', error);
        res.status(500).json({ message: 'Failed to retrieve summary.' });
    }
});

router.get('/reports/students-per-route', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const query = `
            SELECT r.route_name, COUNT(ta.student_id) AS student_count
            FROM ${ROUTES_TABLE} r
            LEFT JOIN ${ASSIGNMENTS_TABLE} ta ON r.id = ta.route_id
            GROUP BY r.route_name
            ORDER BY student_count DESC;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows.map(row => ({
            route_name: row.route_name,
            student_count: parseInt(row.student_count)
        })));
    } catch (error) { 
        console.error('Error fetching students per route:', error);
        res.status(500).json({ message: 'Failed to retrieve data.' });
    }
});

router.get('/reports/fee-summary', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    res.status(200).json({ paid: 85, unpaid: 15 });
});

// =========================================================
// 6. LOCATION TRACKING
// =========================================================

router.get('/vehicles/locations', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const query = `
            SELECT 
                v.id, v.vehicle_number, v.model, v.assigned_driver_id,
                d.full_name AS driver_name, d.license_photo_url AS driver_photo_url,
                r.id AS route_id, '34.0522' AS last_lat, '-118.2437' AS last_lng, NOW() AS last_updated_at 
            FROM ${VEHICLES_TABLE} v
            LEFT JOIN ${DRIVERS_TABLE} d ON v.assigned_driver_id = d.id
            LEFT JOIN ${ROUTES_TABLE} r ON v.id = r.vehicle_id
            ORDER BY v.vehicle_number;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) { 
        console.error('Error fetching locations:', error);
        res.status(500).json({ message: 'Failed to retrieve locations.' });
    }
});

// =========================================================
// 7. VEHICLE DETAILS
// =========================================================

router.get('/vehicles/:id/details', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        const detailsRes = await client.query(`SELECT * FROM ${VEHICLES_TABLE} WHERE id = $1;`, [id]);
        if (detailsRes.rowCount === 0) return res.status(404).json({ message: 'Vehicle not found.' });

        const maintRes = await client.query(`SELECT * FROM ${MAINTENANCE_TABLE} WHERE vehicle_id = $1 ORDER BY service_date DESC;`, [id]);
        const docsRes = await client.query(`SELECT * FROM ${DOCUMENTS_TABLE} WHERE vehicle_id = $1 ORDER BY expiry_date ASC;`, [id]);

        res.status(200).json({
            details: detailsRes.rows[0],
            maintenance: maintRes.rows,
            documents: docsRes.rows
        });
    } catch (error) { 
        console.error('Error fetching vehicle details:', error);
        res.status(500).json({ message: 'Failed to retrieve details.' });
    } finally {
        client.release();
    }
});

router.post('/maintenance', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { vehicle_id, service_date, odometer_reading, details, cost } = req.body;
    try {
        await pool.query(
            `INSERT INTO ${MAINTENANCE_TABLE} (vehicle_id, service_date, odometer_reading, details, cost) VALUES ($1, $2, $3, $4, $5);`,
            [vehicle_id, service_date, odometer_reading || null, details, cost || 0]
        );
        res.status(201).json({ message: 'Maintenance record logged.' });
    } catch (error) { 
        console.error('Error logging maintenance:', error);
        res.status(500).json({ message: 'Failed to log maintenance.' });
    }
});

router.post('/documents', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { vehicle_id, document_type, issue_date, expiry_date } = req.body;
    try {
        const resDb = await pool.query(
            `INSERT INTO ${DOCUMENTS_TABLE} (vehicle_id, document_type, issue_date, expiry_date) VALUES ($1, $2, $3, $4) RETURNING id;`,
            [vehicle_id, document_type, issue_date || null, expiry_date]
        );
        res.status(201).json({ message: 'Document created.', id: resDb.rows[0].id });
    } catch (error) { 
        console.error('Error creating document:', error);
        res.status(500).json({ message: 'Failed to create document.' });
    }
});

router.post('/documents/:id/upload', authenticateToken, authorize(['Admin', 'Super Admin']), (req, res) => {
    const { id } = req.params;
    executeUpload(req, res, 'document', DOCUMENT_UPLOAD_BASE_PATH, async (url) => {
        await pool.query(`UPDATE ${DOCUMENTS_TABLE} SET document_url = $1 WHERE id = $2;`, [url, id]);
    });
});

// =========================================================
// 8. ATTENDANCE MANAGEMENT (FIXED FOR USER ID MISMATCH)
// =========================================================

/**
 * @route   GET /api/transport/routes/:id/attendance-sheet
 * @desc    Joins matching students.user_id to attendance.student_id (because DB expects User ID)
 */
router.get('/routes/:id/attendance-sheet', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT 
                s.student_id,
                s.first_name || ' ' || s.last_name AS student_name,
                s.roll_number,
                att.status AS current_status
            FROM ${ASSIGNMENTS_TABLE} ta
            JOIN ${STUDENTS_TABLE} s ON ta.student_id = s.student_id
            LEFT JOIN (
                SELECT DISTINCT ON (student_id) student_id, status 
                FROM ${ATTENDANCE_TABLE}
                WHERE route_id = $1
                ORDER BY student_id, created_at DESC
            ) att ON s.user_id = att.student_id
            WHERE ta.route_id = $1;
        `;
        const result = await pool.query(query, [id]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error loading attendance sheet:', error);
        res.status(500).json({ message: 'Failed to retrieve attendance sheet.' });
    }
});

/**
 * @route   POST /api/transport/attendance
 * @desc    Marks student boarding status. Accessible by Drivers and Admins.
 */
router.post('/attendance', authenticateToken, authorize(['driver', 'admin', 'super admin']), async (req, res) => {
    const { student_id, route_id, status } = req.body; 

    // --- NEW VALIDATION GUARD ---
    // This stops the "undefined" UUID error from crashing the request
    if (!student_id || student_id === 'undefined' || !route_id || route_id === 'undefined') {
        console.error("Missing or malformed IDs in attendance request:", { student_id, route_id });
        return res.status(400).json({ message: 'Invalid Student or Route ID provided.' });
    }
    
    try {
        // 1. Verify student is actually assigned to this route
        const checkAssignment = await pool.query(
            `SELECT 1 FROM ${ASSIGNMENTS_TABLE} WHERE student_id = $1 AND route_id = $2`, 
            [student_id, route_id]
        );
        
        if (checkAssignment.rowCount === 0) {
            return res.status(403).json({ message: 'Student is not assigned to this route.' });
        }

        // 2. Get the User ID (Required for Foreign Key in attendance table)
        const userLookup = await pool.query(
            `SELECT user_id FROM ${STUDENTS_TABLE} WHERE student_id = $1`, 
            [student_id]
        );
        
        if (userLookup.rowCount === 0 || !userLookup.rows[0].user_id) {
             return res.status(400).json({ message: 'Student record is missing a valid User ID.' });
        }
        
        const userIdToSave = userLookup.rows[0].user_id;

        // 3. Prevent duplicate attendance for the same student on the same day
        // Using timezone-safe CURRENT_DATE comparison
        const duplicateCheck = await pool.query(
            `SELECT id FROM ${ATTENDANCE_TABLE} 
             WHERE student_id = $1 AND route_id = $2 AND created_at::date = CURRENT_DATE`,
            [userIdToSave, route_id]
        );

        if (duplicateCheck.rowCount > 0) {
            await pool.query(
                `UPDATE ${ATTENDANCE_TABLE} SET status = $1, created_at = NOW() 
                 WHERE student_id = $2 AND route_id = $3 AND created_at::date = CURRENT_DATE`,
                [status, userIdToSave, route_id]
            );
            return res.status(200).json({ message: 'Attendance updated successfully.' });
        }

        // 4. Insert new attendance record
        await pool.query(
            `INSERT INTO ${ATTENDANCE_TABLE} (student_id, route_id, status) VALUES ($1, $2, $3)`,
            [userIdToSave, route_id, status]
        );
        
        res.status(200).json({ message: 'Attendance marked successfully.' });
    } catch (error) {
        console.error('Error marking attendance:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// =========================================================
// 9. STUDENT/USER VIEW ROUTES (FIX FOR my-bus.html)
// =========================================================

/**
 * @route   GET /api/transport/my-bus
 * @desc    Fetch the current transport assignment for the logged-in student.
 * @access  Private (Student, Super Admin)
 */
router.get('/my-bus', authenticateToken, authorize(['Student', 'Super Admin']), async (req, res) => {
    const userId = req.user.id; // Logged-in User ID
    
    // IMPORTANT: Ensure your transport table constants are correctly defined at the top of transport.js
    const STUDENTS_TABLE = 'students'; 
    const ASSIGNMENTS_TABLE = 'student_transport_assignments'; 
    const ROUTES_TABLE = 'transport_routes';
    const VEHICLES_TABLE = 'transport_vehicles';
    const DRIVERS_TABLE = 'transport_drivers';

    try {
        // 1. Get the student_id linked to the logged-in user_id
        const studentRes = await pool.query(`SELECT student_id FROM ${STUDENTS_TABLE} WHERE user_id = $1::uuid`, [userId]);
        const studentProfileId = studentRes.rows[0]?.student_id; 

        if (!studentProfileId) {
            return res.status(404).json({ message: 'Student profile not found or not linked.' });
        }

        // 2. Fetch the current active assignment details
        const query = `
            SELECT
                a.id AS assignment_id, a.boarding_stop, a.dropping_stop,
                r.route_name, v.vehicle_number, d.full_name AS driver_name,
                r.route_schedule, r.monthly_fee
            FROM ${ASSIGNMENTS_TABLE} a
            JOIN ${ROUTES_TABLE} r ON a.route_id = r.id
            JOIN ${VEHICLES_TABLE} v ON r.vehicle_id = v.id
            LEFT JOIN ${DRIVERS_TABLE} d ON v.assigned_driver_id = d.id
            WHERE a.student_id = $1::uuid AND a.is_active = TRUE;
        `;
        
        const { rows } = await pool.query(query, [studentProfileId]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'No active bus assignment found for this student.' });
        }
        
        // Add mock live location for demonstration
        const responseData = {
            ...rows[0],
            liveLocation: { 
                lat: 34.0522 + Math.random() * 0.05, 
                lng: -118.2437 + Math.random() * 0.05 
            },
            status: 'In Transit'
        };

        res.status(200).json(responseData);

    } catch (err) {
        console.error('Error fetching student bus details:', err);
        // If the error is 'column does not exist' (as seen in logs), the 500 error remains.
        res.status(500).json({ error: 'Failed to retrieve transport details.', details: err.message });
    }
});

/**
 * @route   GET /api/transport/driver/status
 * @desc    Fetch driver assignment details
 */
router.get('/driver/status', authenticateToken, authorize(['Driver', 'Admin']), async (req, res) => {
    try {
        const query = `
            SELECT 
                d.id AS driver_id,
                d.full_name, 
                d.license_number,
                v.id AS vehicle_id,
                v.vehicle_number, 
                v.model AS bus_model,
                r.route_name,
                r.id AS route_id,
                (SELECT COUNT(*) 
                 FROM student_transport_assignments 
                 WHERE route_id = r.id AND is_active = true) as student_count
            FROM transport_drivers d
            JOIN transport_vehicles v ON v.assigned_driver_id = d.id
            JOIN transport_routes r ON r.vehicle_id = v.id
            WHERE d.user_id = $1;
        `;
            
        const result = await pool.query(query, [req.user.id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "No driver profile linked to this account." });
        }
        
        res.json(result.rows[0]);
    } catch (err) {
        console.error("Driver Status API Error:", err.message);
        res.status(500).json({ message: "Internal Server Error" });
    }
});
/**
 * @route   GET /api/transport/route/:routeId/students
 * @desc    Fetch students for a specific route (Fixed to include student_id)
 */
router.get('/route/:routeId/students', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                s.student_id,           -- CRITICAL: Added this so frontend has the ID
                u.full_name, 
                s.enrollment_no,        -- Changed roll_number to enrollment_no to match standard schema
                u.phone_number,         -- Added for the 'Call Parent' feature
                COALESCE(rs.stop_name, 'Not Assigned') as stop_name
            FROM student_transport_assignments sta
            JOIN students s ON sta.student_id = s.student_id
            JOIN users u ON s.user_id = u.id
            LEFT JOIN route_stops rs ON sta.stop_id = rs.id
            WHERE sta.route_id = $1 AND sta.is_active = true
            ORDER BY u.full_name ASC;
        `;
        const result = await pool.query(query, [req.params.routeId]);
        
        console.log(`Fetched ${result.rowCount} students for route ${req.params.routeId}`);
        res.json(result.rows);
    } catch (err) {
        console.error("Fetch students error:", err.message);
        res.status(500).json({ message: "Error fetching student list" });
    }
});
/**
 * @route   POST /api/transport/maintenance
 * @desc    Logs maintenance. Use lowercase roles to match authMiddleware normalization.
 */
router.post('/maintenance', authenticateToken, authorize(['driver', 'admin']), async (req, res) => {
    const { vehicle_id, service_date, odometer_reading, details, cost } = req.body;
    try {
        const query = `
            INSERT INTO vehicle_maintenance (vehicle_id, service_date, odometer_reading, details, cost)
            VALUES ($1, $2, $3, $4, $5)
        `;
        await pool.query(query, [vehicle_id, service_date, odometer_reading, details, cost || 0]);
        res.status(201).json({ message: 'Maintenance record logged successfully.' });
    } catch (error) {
        console.error('Maintenance Log Error:', error.message);
        res.status(500).json({ message: 'Failed to log maintenance record.' });
    }
});

/**
 * @route   POST /api/transport/update-location
 * @desc    Updates bus coordinates. Access: driver
 */
router.post('/update-location', authenticateToken, authorize(['driver']), async (req, res) => {
    const { lat, lon } = req.body;
    const userId = req.user.id; // Correctly uses req.user.id from middleware

    try {
        const query = `
            UPDATE transport_vehicles 
            SET last_lat = $1, last_lon = $2, last_updated = NOW() 
            WHERE assigned_driver_id = (SELECT id FROM transport_drivers WHERE user_id = $3)
        `;
        const result = await pool.query(query, [lat, lon, userId]);
        res.status(200).json({ success: true });
    } catch (err) {
        console.error("GPS Tracking Error:", err.message);
        res.status(500).json({ message: "Internal server error" });
    }
});

/**
 * @route   POST /api/transport/fuel-logs
 */
router.post('/fuel-logs', authenticateToken, authorize(['Driver', 'Admin']), async (req, res) => {
    const { vehicle_id, odometer, quantity, total_cost, log_date } = req.body;
    try {
        const query = `
            INSERT INTO fuel_logs (vehicle_id, odometer, quantity, total_cost, log_date)
            VALUES ($1, $2, $3, $4, $5)
        `;
        await pool.query(query, [vehicle_id, odometer, quantity, total_cost, log_date]);
        res.status(201).json({ message: 'Fuel log recorded successfully.' });
    } catch (error) {
        console.error('Fuel Log Error:', error.message);
        res.status(500).json({ message: 'Internal server error recording fuel log.' });
    }
});

/**
 * @route   POST /api/transport/sos
 */
router.post('/sos', authenticateToken, authorize(['Driver']), async (req, res) => {
    const { type, lat, lon } = req.body;
    const userId = req.user.id;

    try {
        const logQuery = `
            INSERT INTO transport_emergencies (driver_id, vehicle_id, emergency_type, latitude, longitude, status)
            SELECT d.id, v.id, $1, $2, $3, 'Active'
            FROM transport_drivers d
            JOIN transport_vehicles v ON v.assigned_driver_id = d.id
            WHERE d.user_id = $4
            RETURNING id;
        `;
        const result = await pool.query(logQuery, [type, lat, lon, userId]);
        console.log(`🚨 SOS ALERT: ${type} reported at ${lat}, ${lon}`);
        res.status(200).json({ message: 'Emergency services alerted.' });
    } catch (err) {
        console.error("SOS Error:", err.message);
        res.status(500).json({ message: 'Failed to process SOS signal.' });
    }
});

/**
 * @route   GET /api/transport/admin/trip-history
 * @desc    Fetch all fuel logs and vehicle status for Admin reporting
 */
router.get('/admin/trip-history', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    try {
        const query = `
            SELECT 
                fl.log_date,
                v.vehicle_number,
                d.full_name AS driver_name,
                fl.odometer,
                fl.quantity,
                fl.total_cost,
                v.last_lat,
                v.last_lon,
                v.last_updated
            FROM fuel_logs fl
            JOIN transport_vehicles v ON fl.vehicle_id = v.id
            JOIN transport_drivers d ON v.assigned_driver_id = d.id
            ORDER BY fl.log_date DESC;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Trip History Error:", err.message);
        res.status(500).json({ message: "Failed to retrieve history" });
    }
});

/**
 * @route   GET /api/transport/admin/vehicle-health
 * @desc    Calculates mileage and maintenance status for the fleet
 */
router.get('/admin/vehicle-health', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    try {
        const query = `
            WITH mileage_calc AS (
                SELECT 
                    vehicle_id,
                    odometer,
                    quantity,
                    log_date,
                    LAG(odometer) OVER (PARTITION BY vehicle_id ORDER BY log_date ASC) as prev_odometer
                FROM fuel_logs
            )
            SELECT 
                v.vehicle_number,
                v.model,
                MAX(m.odometer) as current_km,
                ROUND(AVG((m.odometer - m.prev_odometer) / NULLIF(m.quantity, 0)), 2) as avg_kmpl,
                (SELECT status FROM transport_emergencies WHERE vehicle_id = v.id ORDER BY created_at DESC LIMIT 1) as last_sos_status
            FROM transport_vehicles v
            LEFT JOIN mileage_calc m ON v.id = m.vehicle_id
            GROUP BY v.id, v.vehicle_number, v.model;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Health Dashboard Error:", err.message);
        res.status(500).json({ message: "Failed to calculate health metrics" });
    }
});

/**
 * @route   GET /api/transport/my-vehicle-health
 * @desc    Authorized check for a driver's specific vehicle maintenance status
 */
router.get('/my-vehicle-health', authenticateToken, authorize(['driver']), async (req, res) => {
    try {
        const query = `
            SELECT 
                v.vehicle_number,
                MAX(fl.odometer) as current_km,
                COALESCE(MAX(vm.odometer_reading), 0) as last_service_km
            FROM transport_vehicles v
            LEFT JOIN fuel_logs fl ON v.id = fl.vehicle_id
            LEFT JOIN vehicle_maintenance vm ON v.id = vm.vehicle_id
            WHERE v.assigned_driver_id = (SELECT id FROM transport_drivers WHERE user_id = $1)
            GROUP BY v.vehicle_number;
        `;
        const result = await pool.query(query, [req.user.id]);
        if (result.rows.length === 0) return res.status(404).json({ message: "No assigned vehicle found." });
        res.json(result.rows[0]);
    } catch (err) {
        console.error("My Vehicle Health Error:", err.message);
        res.status(500).json({ message: "Error fetching maintenance status" });
    }
});

/**
 * @route   GET /api/transport/admin/document-alerts
 * @desc    Fetch documents expiring within 30 days
 */
router.get('/admin/document-alerts', authenticateToken, authorize(['admin', 'super admin']), async (req, res) => {
    try {
        const query = `
            SELECT 
                v.vehicle_number,
                d.document_type,
                d.expiry_date,
                (d.expiry_date - CURRENT_DATE) AS days_remaining
            FROM vehicle_documents d
            JOIN transport_vehicles v ON d.vehicle_id = v.id
            WHERE d.expiry_date <= (CURRENT_DATE + INTERVAL '30 days')
            ORDER BY d.expiry_date ASC;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Document Alert Error:", err.message);
        res.status(500).json({ message: "Failed to fetch document alerts." });
    }
});
/**
 * @route   GET /api/transport/fuel/last-entry
 * @desc    Fetch last odometer using the correct driver-to-vehicle mapping
 */
router.get('/fuel/last-entry', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT fl.odometer 
            FROM fuel_logs fl
            JOIN transport_vehicles v ON fl.vehicle_id = v.id
            JOIN transport_drivers d ON v.assigned_driver_id = d.id
            WHERE d.user_id = $1
            ORDER BY fl.created_at DESC LIMIT 1;
        `;
        const result = await pool.query(query, [req.user.id]);
        res.json(result.rows[0] || { odometer: 0 });
    } catch (err) {
        console.error("Last entry error:", err.message);
        res.status(500).json({ message: "Database mapping error" });
    }
});

/**
 * @route   GET /api/transport/fuel/history
 */
router.get('/fuel/history', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT fl.* FROM fuel_logs fl
            JOIN transport_vehicles v ON fl.vehicle_id = v.id
            JOIN transport_drivers d ON v.assigned_driver_id = d.id
            WHERE d.user_id = $1
            ORDER BY fl.log_date DESC, fl.created_at DESC;
        `;
        const result = await pool.query(query, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        console.error("History error:", err.message);
        res.status(500).json({ message: "Failed to load history" });
    }
});

/**
 * @route   POST /api/transport/fuel/log
 * @desc    Submit a new fuel log and update vehicle odometer
 */
router.post('/fuel/log', authenticateToken, async (req, res) => {
    const { odometer, quantity, total_cost, prev_odometer } = req.body;
    
    try {
        // 1. Identify the vehicle assigned to this driver
        const vehicleQuery = await pool.query(
            `SELECT v.id FROM transport_vehicles v 
             JOIN transport_drivers d ON v.assigned_driver_id = d.id 
             WHERE d.user_id = $1`, 
            [req.user.id]
        );

        if (vehicleQuery.rowCount === 0) {
            return res.status(404).json({ message: "No vehicle assigned to your profile." });
        }

        const vehicleId = vehicleQuery.rows[0].id;

        // 2. Calculate Final KMPL
        let kmpl = null;
        if (prev_odometer > 0 && odometer > prev_odometer) {
            kmpl = (parseFloat(odometer) - parseFloat(prev_odometer)) / parseFloat(quantity);
        }

        // 3. Insert into fuel_logs
        await pool.query(
            `INSERT INTO fuel_logs (
                vehicle_id, odometer, quantity, total_cost, kmpl, prev_odometer, log_date
            ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE)`,
            [vehicleId, odometer, quantity, total_cost, kmpl, prev_odometer]
        );

        // 4. Update the vehicle's current odometer in the master table
        await pool.query(
            `UPDATE transport_vehicles SET last_updated = NOW() WHERE id = $1`,
            [vehicleId]
        );

        res.status(200).json({ message: "Fuel log saved successfully!" });
    } catch (err) {
        console.error("POST Fuel Log Error:", err.message);
        res.status(500).json({ message: "Internal Server Error" });
    }
});

module.exports = router;