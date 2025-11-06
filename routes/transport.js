const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// Database Table Constants
const DRIVERS_TABLE = 'transport_drivers';
const VEHICLES_TABLE = 'transport_vehicles';
const ROUTES_TABLE = 'transport_routes';
const STOPS_TABLE = 'route_stops';
const ASSIGNMENTS_TABLE = 'student_transport_assignments';
const USERS_TABLE = 'users';
const STUDENTS_TABLE = 'students'; // Added for the assignment lookup fix

// *** IMPORTANT: CHECK YOUR DB SCHEMA ***
const MAINTENANCE_TABLE = 'vehicle_maintenance';
const DOCUMENTS_TABLE = 'vehicle_documents';      

// --- FILE UPLOAD CONFIGURATION (CRITICAL) ---
const TRANSPORT_UPLOAD_BASE_PATH = '/uploads/transport'; // For vehicle photos and driver licenses
const DOCUMENT_UPLOAD_BASE_PATH = '/uploads/documents';  // For vehicle documents

// --- FILE UPLOAD HELPER ---
/**
 * Executes Multer's single file upload and handles error logging and database updating.
 */
function executeUpload(req, res, fieldName, baseUploadPath, successCallback) {
    const uploadInstance = req.app.get('upload');
    
    // Check if Multer instance is correct and initialized (CRITICAL CHECK)
    if (!uploadInstance || typeof uploadInstance.single !== 'function') {
        console.error("Multer 'upload' instance is missing or misconfigured in server.js.");
        return res.status(500).json({ message: "File upload service is unavailable or misconfigured. Check Multer initialization." });
    }

    const uploadMiddleware = uploadInstance.single(fieldName);

    uploadMiddleware(req, res, async (err) => {
        if (err) {
            console.error(`Multer Upload Error for field '${fieldName}':`, err);
            return res.status(500).json({ message: `File upload failed: ${err.message || 'Check file size/type constraints and server file permissions.'}` });
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

// --------------------------------------------------------------------------------
// =========================================================
// 1. VEHICLE MANAGEMENT (CRUD)
// =========================================================

/**
 * @route   GET /api/transport/vehicles
 */
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

/**
 * @route   POST /api/transport/vehicles
 */
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

/**
 * @route   PUT /api/transport/vehicles/:id
 */
router.put('/vehicles/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    const { model, capacity } = req.body;
    try {
        const query = `
            UPDATE ${VEHICLES_TABLE} SET model = $1, capacity = $2
            WHERE id = $3;
        `;
        await pool.query(query, [model, capacity, id]);
        res.status(200).json({ message: 'Vehicle updated successfully.' });
    } catch (error) {
        console.error('Error updating vehicle:', error);
        res.status(500).json({ message: 'Failed to update vehicle.' });
    }
});

/**
 * @route   PUT /api/transport/vehicles/:id/assign-driver
 */
router.put('/vehicles/:id/assign-driver', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    const { driver_id } = req.body;
    try {
        const query = `
            UPDATE ${VEHICLES_TABLE} SET assigned_driver_id = $1
            WHERE id = $2;
        `;
        await pool.query(query, [driver_id || null, id]);
        res.status(200).json({ message: 'Driver assignment updated successfully.' });
    } catch (error) {
        console.error('Error assigning driver:', error);
        res.status(500).json({ message: 'Failed to assign driver.' });
    }
});

/**
 * @route   POST /api/transport/vehicles/:id/photo
 */
router.post('/vehicles/:id/photo', authenticateToken, authorize(['Admin', 'Super Admin']), (req, res) => {
    const { id } = req.params;

    executeUpload(req, res, 'photo', TRANSPORT_UPLOAD_BASE_PATH, async (photoUrl) => {
        const query = `
            UPDATE ${VEHICLES_TABLE} SET photo_url = $1 WHERE id = $2;
        `;
        await pool.query(query, [photoUrl, id]);
    });
});

/**
 * @route   DELETE /api/transport/vehicles/:id
 * @desc    Deletes a vehicle. Checks if it's assigned to any route first.
 */
router.delete('/vehicles/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        // --- DATA INTEGRITY CHECK ---
        const assignmentCheck = await pool.query(`SELECT id FROM ${ROUTES_TABLE} WHERE vehicle_id = $1;`, [id]);
        if (assignmentCheck.rowCount > 0) {
            return res.status(409).json({ 
                message: 'Cannot delete vehicle. It is currently assigned to one or more routes.',
                route_id: assignmentCheck.rows[0].id
            });
        }
        // --- END CHECK ---

        const query = `DELETE FROM ${VEHICLES_TABLE} WHERE id = $1;`;
        await pool.query(query, [id]);
        res.status(200).json({ message: 'Vehicle deleted successfully.' });
    } catch (error) {
        console.error('Error deleting vehicle:', error);
        res.status(500).json({ message: 'Failed to delete vehicle.' });
    }
});

// --------------------------------------------------------------------------------
// =========================================================
// 2. DRIVER MANAGEMENT (CRUD)
// =========================================================

/**
 * @route   GET /api/transport/drivers
 */
router.get('/drivers', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const query = `SELECT * FROM ${DRIVERS_TABLE} ORDER BY full_name;`;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching drivers:', error);
        res.status(500).json({ message: 'Failed to retrieve drivers.' });
    }
});

/**
 * @route   POST /api/transport/drivers
 */
router.post('/drivers', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { full_name, license_number, phone_number } = req.body;
    try {
        const query = `
            INSERT INTO ${DRIVERS_TABLE} (full_name, license_number, phone_number)
            VALUES ($1, $2, $3)
            RETURNING id;
        `;
        const result = await pool.query(query, [full_name, license_number, phone_number]);
        res.status(201).json({ message: 'Driver added successfully.', id: result.rows[0].id });
    } catch (error) {
        console.error('Error adding driver:', error);
        res.status(500).json({ message: 'Failed to add driver.' });
    }
});

/**
 * @route   PUT /api/transport/drivers/:id
 */
router.put('/drivers/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    const { full_name, phone_number } = req.body;
    try {
        const query = `
            UPDATE ${DRIVERS_TABLE} SET full_name = $1, phone_number = $2
            WHERE id = $3;
        `;
        await pool.query(query, [full_name, phone_number, id]);
        res.status(200).json({ message: 'Driver updated successfully.' });
    } catch (error) {
        console.error('Error updating driver:', error);
        res.status(500).json({ message: 'Failed to update driver.' });
    }
});

/**
 * @route   POST /api/transport/drivers/:id/license
 */
router.post('/drivers/:id/license', authenticateToken, authorize(['Admin', 'Super Admin']), (req, res) => {
    const { id } = req.params;

    executeUpload(req, res, 'license', TRANSPORT_UPLOAD_BASE_PATH, async (licensePhotoUrl) => {
        const query = `
            UPDATE ${DRIVERS_TABLE} SET license_photo_url = $1 WHERE id = $2;
        `;
        await pool.query(query, [licensePhotoUrl, id]);
    });
});

/**
 * @route   DELETE /api/transport/drivers/:id
 */
router.delete('/drivers/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        const query = `DELETE FROM ${DRIVERS_TABLE} WHERE id = $1;`;
        await pool.query(query, [id]);
        res.status(200).json({ message: 'Driver deleted successfully.' });
    } catch (error) {
        console.error('Error deleting driver:', error);
        res.status(500).json({ message: 'Failed to delete driver.' });
    }
});

// --------------------------------------------------------------------------------
// =========================================================
// 3. ROUTE MANAGEMENT (CRUD)
// =========================================================

/**
 * @route   GET /api/transport/routes
 */
router.get('/routes', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const query = `
            SELECT 
                r.id, r.route_name, r.vehicle_id, r.monthly_fee, 
                v.vehicle_number
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

/**
 * @route   POST /api/transport/routes
 */
router.post('/routes', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { route_name, vehicle_id, stops, monthly_fee } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const routeQuery = `
            INSERT INTO ${ROUTES_TABLE} (route_name, vehicle_id, monthly_fee)
            VALUES ($1, $2, $3)
            RETURNING id;
        `;
        const routeResult = await client.query(routeQuery, [route_name, vehicle_id || null, monthly_fee || 0]);
        const routeId = routeResult.rows[0].id;

        if (stops && stops.length > 0) {
            for (let i = 0; i < stops.length; i++) {
                const stopQuery = `
                    INSERT INTO ${STOPS_TABLE} (route_id, stop_name, stop_sequence)
                    VALUES ($1, $2, $3);
                `;
                // Assumes stop_sequence column was added to route_stops table (as fixed previously)
                await client.query(stopQuery, [routeId, stops[i], i + 1]); 
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

/**
 * @route   PUT /api/transport/routes/:id
 */
router.put('/routes/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    const { route_name, vehicle_id, stops, monthly_fee } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const routeQuery = `
            UPDATE ${ROUTES_TABLE} SET route_name = $1, vehicle_id = $2, monthly_fee = $3
            WHERE id = $4;
        `;
        await client.query(routeQuery, [route_name, vehicle_id || null, monthly_fee || 0, id]);

        // Clear existing stops
        await client.query(`DELETE FROM ${STOPS_TABLE} WHERE route_id = $1;`, [id]);

        // Insert new stops
        if (stops && stops.length > 0) {
            for (let i = 0; i < stops.length; i++) {
                const stopQuery = `
                    INSERT INTO ${STOPS_TABLE} (route_id, stop_name, stop_sequence)
                    VALUES ($1, $2, $3);
                `;
                await client.query(stopQuery, [id, stops[i], i + 1]);
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

/**
 * @route   GET /api/transport/routes/:id/details  <-- NEW MISSING ENDPOINT ADDED
 * @desc    Get comprehensive route data for map display (simulated data for path).
 */
router.get('/routes/:id/details', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        // Query to fetch route name and all stops (using mock coordinates as they don't exist in STOPS_TABLE yet)
        const routeQuery = `
            SELECT r.route_name, s.stop_name, s.stop_sequence, 
                   34.0000 + (s.stop_sequence * 0.01) AS latitude, -- Mocking lat/lng based on sequence
                   -118.0000 + (s.stop_sequence * 0.01) AS longitude
            FROM ${ROUTES_TABLE} r
            JOIN ${STOPS_TABLE} s ON r.id = s.route_id
            WHERE r.id = $1
            ORDER BY s.stop_sequence ASC;
        `;
        const result = await pool.query(routeQuery, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Route not found or has no stops.' });
        }

        const stops = result.rows;
        const path = stops.map(stop => [parseFloat(stop.latitude), parseFloat(stop.longitude)]);

        res.status(200).json({
            route_name: stops[0].route_name,
            // path is an array of [lat, lng] arrays for Leaflet Polyline
            path: path,
            // Start and End for markers
            start: path[0],
            end: path[path.length - 1]
        });

    } catch (error) {
        console.error('Error fetching route details for map:', error);
        res.status(500).json({ message: 'Failed to retrieve detailed route data.' });
    }
});


/**
 * @route   GET /api/transport/routes/:id/stops
 */
router.get('/routes/:id/stops', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT stop_name FROM ${STOPS_TABLE}
            WHERE route_id = $1
            ORDER BY stop_sequence;
        `;
        const result = await pool.query(query, [id]);
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
                u.username AS student_name,
                ta.boarding_stop,
                ta.dropping_stop 
            FROM ${ASSIGNMENTS_TABLE} ta
            JOIN ${USERS_TABLE} u ON ta.student_id = u.id
            WHERE ta.route_id = $1;
        `;
        const result = await pool.query(query, [id]); 
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching students on route:', error);
        res.status(500).json({ message: `Failed to retrieve students on route: ${error.message}` });
    }
});

/**
 * @route   DELETE /api/transport/routes/:id
 * @desc    Deletes a route. Checks if students are assigned first.
 */
router.delete('/routes/:id', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // --- DATA INTEGRITY CHECK ---
        const assignmentCheck = await client.query(`SELECT student_id FROM ${ASSIGNMENTS_TABLE} WHERE route_id = $1;`, [id]);
        if (assignmentCheck.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ 
                message: 'Cannot delete route. It is currently assigned to one or more students.',
                student_count: assignmentCheck.rowCount
            });
        }
        // --- END CHECK ---

        // 1. Delete associated stops
        await client.query(`DELETE FROM ${STOPS_TABLE} WHERE route_id = $1;`, [id]);

        // 2. Delete the route itself
        const query = `DELETE FROM ${ROUTES_TABLE} WHERE id = $1;`;
        await client.query(query, [id]);

        await client.query('COMMIT');
        res.status(200).json({ message: 'Route and associated stops deleted successfully.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting route:', error);
        res.status(500).json({ message: 'Failed to delete route.' });
    } finally {
        client.release();
    }
});

// --------------------------------------------------------------------------------
// =========================================================
// 3.5. STUDENT ASSIGNMENT
// =========================================================

/**
 * @route   POST /api/transport/assign
 * @desc    Assign or update a student's transport route. This handles students.id from client 
 * and maps it to users.id for the assignment table (CRITICAL FIX for FK error).
 * @access  Private (Admin, Super Admin)
 */
router.post('/assign', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    // We assume the incoming student_id is the students.id (PK of the student record) 
    const { student_id: studentRecordId, route_id, boarding_stop, dropping_stop } = req.body;
    const monthly_fee = req.body.monthly_fee || 0; 
    
    try {
        // 1. Look up the actual User ID associated with the Student Record ID 
        const userLookupQuery = `
            SELECT user_id FROM ${STUDENTS_TABLE} WHERE id = $1;
        `;
        const userResult = await pool.query(userLookupQuery, [studentRecordId]);

        if (userResult.rowCount === 0) {
            return res.status(404).json({ message: 'Student record not found in the students table.' });
        }
        
        // This is the ID that must exist in the USERS_TABLE due to the FK constraint.
        const userIdToAssign = userResult.rows[0].user_id;

        const assignmentQuery = `
            INSERT INTO ${ASSIGNMENTS_TABLE} (student_id, route_id, boarding_stop, dropping_stop, monthly_fee)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (student_id) DO UPDATE 
            SET route_id = $2, boarding_stop = $3, dropping_stop = $4, monthly_fee = $5;
        `;
        // Pass the correct user ID (userIdToAssign) to the assignment table.
        await pool.query(assignmentQuery, [userIdToAssign, route_id, boarding_stop, dropping_stop, monthly_fee]);
        
        res.status(201).json({ message: 'Student assigned to route successfully.' });
    } catch (error) {
        console.error('Error assigning student to route:', error);
        // Specifically check for FK violation 
        if (error.code === '23503') {
             return res.status(400).json({ 
                message: 'Failed to assign transport. Ensure the Route ID is valid and the User ID exists.',
                error: error.message
            });
        }
        res.status(500).json({ message: 'Failed to assign transport.' });
    }
});

// --------------------------------------------------------------------------------
// =========================================================
// 4. LIVE STATUS & MOCK (GET)
// =========================================================

/**
 * @route   GET /api/transport/routes/:id/status
 */
router.get('/routes/:id/status', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        const stopsRes = await pool.query(`SELECT stop_name FROM ${STOPS_TABLE} WHERE route_id = $1 ORDER BY stop_sequence;`, [id]);
        const stops = stopsRes.rows.map(row => row.stop_name);

        const mockLat = 34.0522 + (Math.random() - 0.5) * 0.1;
        const mockLng = -118.2437 + (Math.random() - 0.5) * 0.1;
        
        res.status(200).json({
            pickupLocation: stops.length > 0 ? stops[0] : 'N/A',
            dropLocation: stops.length > 1 ? stops[stops.length - 1] : 'N/A',
            liveLocation: {
                lat: mockLat.toFixed(5),
                lng: mockLng.toFixed(5)
            },
            status: 'In Transit'
        });
    } catch (error) { 
        console.error('Error fetching route status:', error);
        res.status(500).json({ message: 'Failed to retrieve route status.' });
    }
});

// --------------------------------------------------------------------------------
// =========================================================
// 5. REPORTING ENDPOINTS (Analytics)
// =========================================================

/**
 * @route   GET /api/transport/reports/summary
 * @desc    Get summary statistics for the dashboard cards.
 * @access  Private (Admin, Super Admin)
 */
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
        // Ensure counts are returned as numbers
        const data = result.rows.length > 0 ? result.rows[0] : {};
        res.status(200).json({
            total_vehicles: parseInt(data.total_vehicles || 0),
            total_drivers: parseInt(data.total_drivers || 0),
            total_routes: parseInt(data.total_routes || 0),
            students_assigned: parseInt(data.students_assigned || 0)
        });
    } catch (error) { 
        console.error('Error fetching transport summary:', error);
        res.status(500).json({ message: 'Failed to retrieve transport summary.' });
    }
});

/**
 * @route   GET /api/transport/reports/students-per-route
 * @desc    Get counts of students per route for the bar chart.
 * @access  Private (Admin, Super Admin)
 */
router.get('/reports/students-per-route', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const query = `
            SELECT 
                r.route_name,
                COUNT(ta.student_id) AS student_count
            FROM ${ROUTES_TABLE} r
            LEFT JOIN ${ASSIGNMENTS_TABLE} ta ON r.id = ta.route_id
            GROUP BY r.route_name
            ORDER BY student_count DESC;
        `;
        const result = await pool.query(query);
        // Ensure student_count is converted to a number for the client
        const data = result.rows.map(row => ({
            route_name: row.route_name,
            student_count: parseInt(row.student_count)
        }));
        // CRITICAL: Return an array of objects
        res.status(200).json(data);
    } catch (error) { 
        console.error('Error fetching students per route report:', error);
        res.status(500).json({ message: 'Failed to retrieve students per route data.' });
    }
});

/**
 * @route   GET /api/transport/reports/fee-summary
 * @desc    Get mock/placeholder fee status data for the doughnut chart.
 * @access  Private (Admin, Super Admin)
 */
router.get('/reports/fee-summary', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        // MOCK DATA: 
        res.status(200).json({
            paid: 85, // Mock percentage or count
            unpaid: 15 // Mock percentage or count
        });

    } catch (error) { 
        console.error('Error fetching fee summary:', error);
        res.status(500).json({ message: 'Failed to retrieve transport fee summary.' });
    }
});

// --------------------------------------------------------------------------------
// =========================================================
// 6. LOCATION TRACKING (GET)
// =========================================================

/**
 * @route   GET /api/transport/vehicles/locations
 * @desc    Get the current (mock) location, driver, and route for all vehicles.
 * @access  Private (Admin, Super Admin)
 */
router.get('/vehicles/locations', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    try {
        const query = `
            SELECT 
                v.id, 
                v.vehicle_number, 
                v.model, 
                v.assigned_driver_id,
                d.full_name AS driver_name,
                d.license_photo_url AS driver_photo_url,
                r.id AS route_id,
                '34.0522' AS last_lat, 
                '-118.2437' AS last_lng,
                NOW() AS last_updated_at 
            FROM ${VEHICLES_TABLE} v
            LEFT JOIN ${DRIVERS_TABLE} d ON v.assigned_driver_id = d.id
            LEFT JOIN ${ROUTES_TABLE} r ON v.id = r.vehicle_id
            ORDER BY v.vehicle_number;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (error) { 
        console.error('Error fetching vehicle locations:', error);
        res.status(500).json({ message: 'Failed to retrieve vehicle locations.' });
    }
});


// --------------------------------------------------------------------------------
// =========================================================
// 7. VEHICLE DETAILS, MAINTENANCE & DOCUMENTS
// =========================================================

/**
 * @route   GET /api/transport/vehicles/:id/details
 */
router.get('/vehicles/:id/details', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();
    try {
        const detailsQuery = `
            SELECT id, vehicle_number, model, capacity, assigned_driver_id
            FROM ${VEHICLES_TABLE}
            WHERE id = $1;
        `;
        const detailsRes = await client.query(detailsQuery, [id]);
        if (detailsRes.rowCount === 0) {
            return res.status(404).json({ message: 'Vehicle not found.' });
        }

        const maintenanceQuery = `
            SELECT service_date, odometer_reading, details, cost 
            FROM ${MAINTENANCE_TABLE} 
            WHERE vehicle_id = $1 
            ORDER BY service_date DESC;
        `;
        const maintenanceRes = await client.query(maintenanceQuery, [id]);

        const documentsQuery = `
            SELECT id, document_type, expiry_date, document_url
            FROM ${DOCUMENTS_TABLE} 
            WHERE vehicle_id = $1 
            ORDER BY expiry_date ASC;
        `;
        const documentsRes = await client.query(documentsQuery, [id]);

        res.status(200).json({
            details: detailsRes.rows[0],
            maintenance: maintenanceRes.rows,
            documents: documentsRes.rows
        });
    } catch (error) { 
        console.error('Error fetching vehicle detailed history:', error);
        res.status(500).json({ 
            message: `Failed to retrieve vehicle details. Database error occurred. Please verify database connection and table names.`,
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * @route   POST /api/transport/maintenance
 */
router.post('/maintenance', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { vehicle_id, service_date, odometer_reading, details, cost } = req.body;
    try {
        const query = `
            INSERT INTO ${MAINTENANCE_TABLE} (vehicle_id, service_date, odometer_reading, details, cost)
            VALUES ($1, $2, $3, $4, $5);
        `;
        await pool.query(query, [vehicle_id, service_date, odometer_reading || null, details, cost || 0]);
        res.status(201).json({ message: 'Maintenance record logged.' });
    } catch (error) { 
        console.error('Error logging maintenance:', error);
        res.status(500).json({ message: 'Failed to log maintenance record.' });
    }
});

/**
 * @route   POST /api/transport/documents
 */
router.post('/documents', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { vehicle_id, document_type, issue_date, expiry_date } = req.body;
    try {
        const query = `
            INSERT INTO ${DOCUMENTS_TABLE} (vehicle_id, document_type, issue_date, expiry_date)
            VALUES ($1, $2, $3, $4)
            RETURNING id;
        `;
        const result = await pool.query(query, [vehicle_id, document_type, issue_date || null, expiry_date]);
        res.status(201).json({ message: 'Document record created.', id: result.rows[0].id });
    } catch (error) { 
        console.error('Error creating document record:', error);
        res.status(500).json({ message: 'Failed to create document record.' });
    }
});

/**
 * @route   POST /api/transport/documents/:id/upload
 */
router.post('/documents/:id/upload', authenticateToken, authorize(['Admin', 'Super Admin']), (req, res) => {
    const { id } = req.params;

    executeUpload(req, res, 'document', DOCUMENT_UPLOAD_BASE_PATH, async (documentUrl) => {
        const query = `
            UPDATE ${DOCUMENTS_TABLE} SET document_url = $1 WHERE id = $2;
        `;
        await pool.query(query, [documentUrl, id]);
    });
});


// Add this near your other constants in transport.js
const ATTENDANCE_TABLE = 'transport_attendance'; 

// Add the following routes to your transport.js file:

// --- ATTENDANCE MANAGEMENT (New Section) ---
/**
 * @route   GET /api/transport/routes/:id/attendance-sheet
 * @desc    Retrieves the list of students on a route, including their latest attendance status.
 */
router.get('/routes/:id/attendance-sheet', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT 
                u.id AS student_user_id,
                u.username AS student_name,
                s.first_name,
                s.last_name,
                att.status AS current_status
            FROM ${ASSIGNMENTS_TABLE} ta
            JOIN ${USERS_TABLE} u ON ta.student_id = u.id
            JOIN ${STUDENTS_TABLE} s ON u.id = s.user_id 
            LEFT JOIN (
                SELECT DISTINCT ON (student_id) student_id, status 
                FROM ${ATTENDANCE_TABLE}
                WHERE route_id = $1
                ORDER BY student_id, created_at DESC
            ) att ON u.id = att.student_id
            WHERE ta.route_id = $1;
        `;
        const result = await pool.query(query, [id]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error loading attendance sheet:', error);
        res.status(500).json({ message: 'Failed to retrieve attendance sheet.' });
    }
});

// Find and replace the following block in your transport.js file (it was around line 880 in the last version):

/**
 * @route   POST /api/transport/attendance
 * @desc    Marks a student's attendance status (Boarded/Alighted) for a trip.
 */
router.post('/attendance', authenticateToken, authorize(['Admin', 'Super Admin']), async (req, res) => {
    // student_id here is the USERS.id (UUID)
    const { student_id, route_id, status } = req.body; 
    const client = await pool.connect();

    // NOTE: ATTENDANCE_TABLE must be defined earlier in the file!
    const ATTENDANCE_TABLE = 'transport_attendance'; 

    try {
        // Simple check to ensure student is actually assigned to this route (Optional, for robustness)
        const checkQuery = `
            SELECT 1 FROM ${ASSIGNMENTS_TABLE} 
            WHERE student_id = $1 AND route_id = $2;
        `;
        const checkResult = await client.query(checkQuery, [student_id, route_id]);
        
        if (checkResult.rowCount === 0) {
            return res.status(403).json({ message: 'Student is not assigned to this route.' });
        }

        const insertQuery = `
            INSERT INTO ${ATTENDANCE_TABLE} (student_id, route_id, status)
            VALUES ($1, $2, $3);
        `;
        await client.query(insertQuery, [student_id, route_id, status]);
        
        res.status(200).json({ message: 'Attendance marked successfully.' });
    } catch (error) {
        console.error('Error marking attendance:', error);
        res.status(500).json({ message: 'Failed to mark attendance.' });
    } finally {
        client.release();
    }
});
module.exports = router;