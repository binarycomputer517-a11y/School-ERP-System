const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const crypto = require('crypto');

// Define Admin roles for authorization across the module
const HOSTEL_ADMIN_ROLES = ['Admin', 'Super Admin']; 

// =================================================================
// --- Hostel & Room Management ---
// =================================================================

// POST /api/hostel/hostels
router.post('/hostels', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    const { hostel_name, type } = req.body;
    if (!hostel_name || !type || !['Boys', 'Girls'].includes(type)) {
        return res.status(400).json({ message: 'Valid hostel_name and type (Boys/Girls) are required.' });
    }
    try {
        const result = await pool.query("INSERT INTO hostels (hostel_name, type) VALUES ($1, $2) RETURNING *", [hostel_name, type]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("Error creating hostel:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

// GET /api/hostel/hostels
router.get('/hostels', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM hostels ORDER BY hostel_name');
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Error fetching hostels:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

// DELETE /api/hostel/hostels/:id
router.delete('/hostels/:id', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    const { id } = req.params;
    try {
        const roomCheck = await pool.query("SELECT COUNT(id) FROM rooms WHERE hostel_id = $1", [id]);
        if (roomCheck.rows[0].count > 0) {
            return res.status(400).json({ message: 'Cannot delete hostel. It still contains rooms.' });
        }
        await pool.query("DELETE FROM hostels WHERE id = $1", [id]);
        res.status(200).json({ message: 'Hostel deleted successfully' });
    } catch (err) {
        console.error("Error deleting hostel:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

// POST /api/hostel/rooms
router.post('/rooms', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    const { hostel_id, room_number, capacity } = req.body;
    const capacityInt = parseInt(capacity, 10);
    if (!hostel_id || !room_number || !capacityInt || capacityInt <= 0) {
        return res.status(400).json({ message: 'Valid hostel_id, room_number, and positive capacity are required.' });
    }
    try {
        const result = await pool.query("INSERT INTO rooms (hostel_id, room_number, capacity) VALUES ($1, $2, $3) RETURNING *", [hostel_id, room_number, capacityInt]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("Error adding room:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

// GET /api/hostel/rooms
router.get('/rooms', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT r.id, r.room_number, r.capacity, r.current_occupancy, h.hostel_name 
            FROM rooms r JOIN hostels h ON r.hostel_id = h.id
            ORDER BY h.hostel_name, r.room_number
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Error fetching rooms:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

// PUT /api/hostel/rooms/:id
router.put('/rooms/:id', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    const { id } = req.params;
    const { room_number, capacity } = req.body;
    const capacityInt = parseInt(capacity, 10);
    if (!room_number || !capacityInt || capacityInt <= 0) {
        return res.status(400).json({ message: 'Valid room_number and a positive capacity are required.' });
    }
    try {
        const roomResult = await pool.query("SELECT current_occupancy FROM rooms WHERE id = $1", [id]);
        if (roomResult.rows.length === 0) return res.status(404).json({ message: 'Room not found.' });
        const currentOccupancy = roomResult.rows[0].current_occupancy;
        if (capacityInt < currentOccupancy) {
            return res.status(400).json({ message: `Cannot set capacity to ${capacityInt}. Room has ${currentOccupancy} students.` });
        }
        await pool.query("UPDATE rooms SET room_number = $1, capacity = $2 WHERE id = $3", [room_number, capacityInt, id]);
        res.status(200).json({ message: 'Room updated successfully' });
    } catch (err) {
        console.error("Error updating room:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

// DELETE /api/hostel/rooms/:id
router.delete('/rooms/:id', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    const { id } = req.params;
    try {
        const roomResult = await pool.query("SELECT current_occupancy FROM rooms WHERE id = $1", [id]);
        if (roomResult.rows.length === 0) return res.status(404).json({ message: 'Room not found.' });
        if (roomResult.rows[0].current_occupancy > 0) {
            return res.status(400).json({ message: 'Cannot delete room. It is currently occupied.' });
        }
        await pool.query("DELETE FROM rooms WHERE id = $1", [id]);
        res.status(200).json({ message: 'Room deleted successfully' });
    } catch (err) {
        console.error("Error deleting room:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

// =================================================================
// --- Student Allocation ---
// =================================================================

router.post('/allocate', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    const { student_id, room_id } = req.body;
    
    // --- FINAL HARDENED VALIDATION: Prevents empty string, null, or "undefined" from reaching DB ---
    if (!student_id || student_id === 'undefined' || student_id === '' || !room_id || room_id === 'undefined' || room_id === '') {
        return res.status(400).json({ message: 'Valid Student ID and Room ID are required for allocation.' });
    }
    // ------------------------------------------------------------------------------------------------

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Fetch existing allocation
        const oldAllocationResult = await client.query("SELECT room_id FROM hostel_allocations WHERE student_id = $1", [student_id]);
        const old_room_id = oldAllocationResult.rows.length > 0 ? oldAllocationResult.rows[0].room_id : null;
        
        // Using .toString() to ensure consistent comparison
        if (old_room_id && old_room_id.toString() === room_id.toString()) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Student is already allocated to this room.' });
        }

        // Check new room capacity
        const newRoomResult = await client.query("SELECT capacity, current_occupancy FROM rooms WHERE id = $1 FOR UPDATE", [room_id]);
        if (newRoomResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Room not found.' });
        }
        if (newRoomResult.rows[0].current_occupancy >= newRoomResult.rows[0].capacity) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'New room is full.' });
        }

        // 1. If student was previously allocated, decrement old room's occupancy
        if (old_room_id) {
            await client.query("UPDATE rooms SET current_occupancy = current_occupancy - 1 WHERE id = $1 AND current_occupancy > 0", [old_room_id]);
        }
        
        // 2. Insert or Update the allocation record
        await client.query("INSERT INTO hostel_allocations (student_id, room_id) VALUES ($1, $2) ON CONFLICT (student_id) DO UPDATE SET room_id = EXCLUDED.room_id", [student_id, room_id]);
        
        // 3. Increment the new room's occupancy
        await client.query("UPDATE rooms SET current_occupancy = current_occupancy + 1 WHERE id = $1", [room_id]);
        
        await client.query('COMMIT');
        res.status(200).json({ message: 'Student allocation updated successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Allocation Error:', err);
        
        if (err.code === '23503') { // PostgreSQL Foreign Key violation
            return res.status(400).json({ message: 'Invalid Student ID or Room ID.' });
        }
        res.status(500).json({ message: 'Server error' });
    } finally {
        client.release();
    }
});

router.get('/allocations', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT (s.first_name || ' ' || s.last_name) as student_name, s.id as student_id,
                   h.hostel_name, r.room_number
            FROM hostel_allocations ha
            JOIN students s ON ha.student_id = s.id
            JOIN rooms r ON ha.room_id = r.id
            JOIN hostels h ON r.hostel_id = h.id
            ORDER BY h.hostel_name, r.room_number, student_name;
        `;
        const result = await pool.query(query);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Error fetching hostel allocations:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

// =================================================================
// --- Gate Pass Management ---
// =================================================================

router.post('/gatepass', authenticateToken, authorize('Student'), async (req, res) => {
    const studentId = req.user.reference_id;
    const { reason, expected_out_time, expected_in_time } = req.body;
    if (!reason || !expected_out_time || !expected_in_time) {
        return res.status(400).json({ message: 'Reason and expected times are required.' });
    }
    try {
        const query = `INSERT INTO gate_passes (student_id, reason, expected_out_time, expected_in_time) VALUES ($1, $2, $3, $4) RETURNING *`;
        const result = await pool.query(query, [studentId, reason, expected_out_time, expected_in_time]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("Error creating gate pass:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/me/gatepasses', authenticateToken, authorize('Student'), async (req, res) => {
    const studentId = req.user.reference_id;
    try {
        const result = await pool.query("SELECT * FROM gate_passes WHERE student_id = $1 ORDER BY request_date DESC", [studentId]);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching student gate passes:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/gatepass/pending', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT gp.id, (s.first_name || ' ' || s.last_name) as student_name, s.class_name,
                   gp.reason, gp.expected_out_time, gp.expected_in_time
            FROM gate_passes gp JOIN students s ON gp.student_id = s.id
            WHERE gp.status = 'Pending' ORDER BY gp.request_date ASC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching pending gate passes:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

router.put('/gatepass/:id/approve', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    const { id } = req.params;
    const adminId = req.user.id;
    const qrCodeHash = crypto.randomBytes(20).toString('hex');
    try {
        const result = await pool.query("UPDATE gate_passes SET status = 'Approved', approved_by = $1, qr_code_hash = $2 WHERE id = $3 AND status = 'Pending' RETURNING *", [adminId, qrCodeHash, id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Pending pass not found or already actioned.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error("Error approving gate pass:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

router.put('/gatepass/:id/reject', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    const { id } = req.params;
    const adminId = req.user.id;
    try {
        const result = await pool.query("UPDATE gate_passes SET status = 'Rejected', approved_by = $1 WHERE id = $2 AND status = 'Pending' RETURNING *", [adminId, id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Pending pass not found or already actioned.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error("Error rejecting gate pass:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/gatepass/scan', authenticateToken, authorize(['Admin', 'Security', 'Super Admin']), async (req, res) => {
    const { qr_code_hash } = req.body;
    if (!qr_code_hash) {
        return res.status(400).json({ message: 'QR Code data is required.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const passResult = await client.query("SELECT gp.*, s.first_name, s.last_name FROM gate_passes gp JOIN students s ON gp.student_id = s.id WHERE gp.qr_code_hash = $1 FOR UPDATE", [qr_code_hash]);
        if (passResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Invalid or expired gate pass.' });
        }
        const pass = passResult.rows[0];
        if (pass.status === 'Approved') {
            await client.query("UPDATE gate_passes SET status = 'Out', actual_out_time = NOW() WHERE id = $1", [pass.id]);
            await client.query('COMMIT');
            res.json({ success: true, message: `EXIT: ${pass.first_name} ${pass.last_name} logged out.` });
        } else if (pass.status === 'Out') {
            await client.query("UPDATE gate_passes SET status = 'Completed', actual_in_time = NOW() WHERE id = $1", [pass.id]);
            await client.query('COMMIT');
            res.json({ success: true, message: `ENTRY: ${pass.first_name} ${pass.last_name} logged in.` });
        } else {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: `Pass not active. Status: ${pass.status}.` });
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error processing scan:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    } finally {
        client.release();
    }
});

// =================================================================
// --- Hostel Notice Board ---
// =================================================================

router.post('/notices', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    const { title, content, hostel_id } = req.body;
    const adminId = req.user.id;
    if (!title || !content) {
        return res.status(400).json({ message: 'Title and content are required.' });
    }
    try {
        const query = `INSERT INTO hostel_notices (title, content, posted_by, hostel_id) VALUES ($1, $2, $3, $4) RETURNING *`;
        const result = await pool.query(query, [title, content, adminId, hostel_id || null]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("Error posting notice:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/notices', authenticateToken, authorize('Student'), async (req, res) => {
    const studentId = req.user.reference_id;
    try {
        const allocationResult = await pool.query(`SELECT r.hostel_id FROM hostel_allocations ha JOIN rooms r ON ha.room_id = r.id WHERE ha.student_id = $1`, [studentId]);
        if (allocationResult.rows.length === 0) {
            // Student is not allocated, only fetch general notices
            const generalNotices = await pool.query("SELECT title, content, created_at FROM hostel_notices WHERE hostel_id IS NULL ORDER BY created_at DESC");
            return res.json(generalNotices.rows);
        }
        const hostelId = allocationResult.rows[0].hostel_id;
        const result = await pool.query(`
            SELECT hn.title, hn.content, hn.created_at, u.username as posted_by
            FROM hostel_notices hn JOIN users u ON hn.posted_by = u.id
            WHERE hn.hostel_id = $1 OR hn.hostel_id IS NULL ORDER BY hn.created_at DESC
        `, [hostelId]);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching notices:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

// =================================================================
// --- Hostel Maintenance Requests ---
// =================================================================

router.post('/maintenance', authenticateToken, authorize('Student'), async (req, res) => {
    const studentId = req.user.reference_id;
    const { category, description } = req.body;
    if (!category || !description) {
        return res.status(400).json({ message: 'Category and description are required.' });
    }
    const client = await pool.connect();
    try {
        const allocationResult = await client.query("SELECT room_id FROM hostel_allocations WHERE student_id = $1", [studentId]);
        if (allocationResult.rows.length === 0) {
            return res.status(404).json({ message: 'You are not allocated to a room.' });
        }
        const roomId = allocationResult.rows[0].room_id;
        const query = `INSERT INTO hostel_maintenance_requests (student_id, room_id, category, description) VALUES ($1, $2, $3, $4) RETURNING *`;
        const result = await client.query(query, [studentId, roomId, category, description]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("Error creating maintenance request:", err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        client.release();
    }
});

router.get('/me/maintenance', authenticateToken, authorize('Student'), async (req, res) => {
    const studentId = req.user.reference_id;
    try {
        const result = await pool.query("SELECT category, description, status, created_at FROM hostel_maintenance_requests WHERE student_id = $1 ORDER BY created_at DESC", [studentId]);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching student's maintenance requests:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/maintenance', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    try {
        const query = `
            SELECT req.id, (s.first_name || ' ' || s.last_name) as student_name,
                   h.hostel_name, r.room_number, req.category, req.description,
                   req.status, req.created_at
            FROM hostel_maintenance_requests req
            JOIN students s ON req.student_id = s.id
            JOIN rooms r ON req.room_id = r.id
            JOIN hostels h ON r.hostel_id = h.id
            ORDER BY req.created_at DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching all maintenance requests:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

router.put('/maintenance/:id/status', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ['Pending', 'In Progress', 'Completed', 'Rejected'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: 'Invalid status provided.' });
    }
    try {
        const result = await pool.query("UPDATE hostel_maintenance_requests SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *", [status, id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Request not found.' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error("Error updating maintenance status:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

// =================================================================
// --- Hostel Fee Management ---
// =================================================================

router.post('/fees/structures', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    const { structure_name, amount, frequency } = req.body;
    if (!structure_name || !amount || !frequency) {
        return res.status(400).json({ message: 'Structure name, amount, and frequency are required.' });
    }
    try {
        const result = await pool.query("INSERT INTO hostel_fee_structures (structure_name, amount, frequency) VALUES ($1, $2, $3) RETURNING *", [structure_name, amount, frequency]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("Error creating fee structure:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/fees/structures', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM hostel_fee_structures ORDER BY structure_name");
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching fee structures:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/fees/generate-invoices', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    const { fee_structure_id, due_date } = req.body;
    if (!fee_structure_id || !due_date) {
        return res.status(400).json({ message: 'Fee structure and due date are required.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const structureResult = await client.query("SELECT * FROM hostel_fee_structures WHERE id = $1", [fee_structure_id]);
        if (structureResult.rows.length === 0) {
            return res.status(404).json({ message: 'Fee structure not found.' });
        }
        const structure = structureResult.rows[0];
        const allocatedStudentsResult = await client.query("SELECT student_id FROM hostel_allocations");
        const studentIds = allocatedStudentsResult.rows.map(row => row.student_id);
        let invoicesCreated = 0;
        for (const studentId of studentIds) {
            // Note: amount_paid is initialized to 0.
            await client.query(`INSERT INTO hostel_fee_invoices (student_id, fee_structure_id, due_date, amount_due, amount_paid) VALUES ($1, $2, $3, $4, 0)`, [studentId, fee_structure_id, due_date, structure.amount]);
            invoicesCreated++;
        }
        await client.query('COMMIT');
        res.status(201).json({ message: `${invoicesCreated} invoices generated successfully.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error generating invoices:", err);
        res.status(500).json({ message: 'Server error' });
    } finally {
        client.release();
    }
});

router.get('/fees/invoices', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    try {
        // Ensure overdue status is correctly applied before fetching
        await pool.query("UPDATE hostel_fee_invoices SET status = 'Overdue' WHERE due_date < CURRENT_DATE AND status = 'Due'");
        const result = await pool.query(`
            SELECT i.id, (s.first_name || ' ' || s.last_name) as student_name, fs.structure_name,
                   i.due_date, i.amount_due, i.amount_paid, i.status
            FROM hostel_fee_invoices i
            JOIN students s ON i.student_id = s.id
            JOIN hostel_fee_structures fs ON i.fee_structure_id = fs.id
            ORDER BY i.due_date DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching invoices:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/fees/invoices/:id/record-payment', authenticateToken, authorize(HOSTEL_ADMIN_ROLES), async (req, res) => {
    const { id } = req.params;
    const { amount } = req.body;
    
    // Validate amount before proceeding
    const paymentAmount = parseFloat(amount);
    if (isNaN(paymentAmount) || paymentAmount <= 0) {
        return res.status(400).json({ message: 'A valid payment amount is required.' });
    }

    try {
        const result = await pool.query("UPDATE hostel_fee_invoices SET amount_paid = amount_paid + $1, status = CASE WHEN amount_paid + $1 >= amount_due THEN 'Paid' ELSE 'Partial' END WHERE id = $2 RETURNING *", [paymentAmount, id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Invoice not found.' });
        }

        res.json({ message: 'Payment recorded successfully.' });
    } catch (err) {
        console.error("Error recording payment:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/me/invoices', authenticateToken, authorize('Student'), async (req, res) => {
    const studentId = req.user.reference_id;
    try {
        await pool.query("UPDATE hostel_fee_invoices SET status = 'Overdue' WHERE due_date < CURRENT_DATE AND status = 'Due' AND student_id = $1", [studentId]);
        const result = await pool.query(`
            SELECT i.id, fs.structure_name, i.due_date, i.amount_due, i.amount_paid, i.status
            FROM hostel_fee_invoices i
            JOIN hostel_fee_structures fs ON i.fee_structure_id = fs.id
            WHERE i.student_id = $1
            ORDER BY i.due_date DESC
        `, [studentId]);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching student's fee invoices:", err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;