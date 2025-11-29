const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware'); 

// --- Helper: Validate UUID ---
const isValidUUID = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

// =========================================================
// 1. LOOKUP & UTILITY ROUTES
// =========================================================

router.get('/lookup/teachers', authenticateToken, async (req, res) => {
    try {
        const query = `SELECT id, username, role FROM users WHERE role::text IN ('Teacher', 'Admin', 'Super Admin', 'Staff', 'Counsellor', 'HR') ORDER BY username ASC`;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ message: 'Error loading staff.' }); }
});

router.get('/lookup/students', authenticateToken, async (req, res) => {
    try {
        const query = `SELECT student_id, first_name, last_name, roll_number FROM students WHERE status IN ('Active', 'Enrolled') ORDER BY first_name ASC`;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ message: 'Error loading students.' }); }
});

router.get('/stats/:teacherId', authenticateToken, async (req, res) => {
    if (!isValidUUID(req.params.teacherId)) return res.json({ open_slots: 0, scheduled: 0, completed: 0 });
    try {
        const result = await pool.query(`
            SELECT 
                COUNT(*) FILTER (WHERE status = 'Open') as open_slots,
                COUNT(*) FILTER (WHERE status = 'Scheduled') as scheduled,
                COUNT(*) FILTER (WHERE status = 'Completed') as completed
            FROM ptm_schedule WHERE teacher_id = $1::uuid`, [req.params.teacherId]);
        res.json(result.rows[0]);
    } catch (error) { res.json({ open_slots: 0, scheduled: 0, completed: 0 }); }
});

// [FEATURE] Export Schedule to CSV
router.get('/export/csv/:teacherId', async (req, res) => {
    if (!isValidUUID(req.params.teacherId)) return res.status(400).send("Invalid ID");
    try {
        const result = await pool.query(`
            SELECT p.meeting_time, p.duration_minutes, p.meeting_type, p.status, 
                   COALESCE(s.first_name || ' ' || s.last_name, 'Open Slot') as student_name
            FROM ptm_schedule p
            LEFT JOIN students s ON p.student_id = s.student_id
            WHERE p.teacher_id = $1::uuid ORDER BY p.meeting_time ASC
        `, [req.params.teacherId]);

        let csv = "Date,Time,Duration,Type,Student,Status\n";
        result.rows.forEach(r => {
            const d = new Date(r.meeting_time);
            csv += `${d.toLocaleDateString()},${d.toLocaleTimeString()},${r.duration_minutes},${r.meeting_type},${r.student_name},${r.status}\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="ptm_schedule.csv"');
        res.send(csv);
    } catch (error) { res.status(500).send("Export failed"); }
});

// [EXISTING] ICS Calendar Export
router.get('/ics/:id', async (req, res) => {
    if (!isValidUUID(req.params.id)) return res.status(400).send("Invalid ID");
    try {
        const result = await pool.query(`
            SELECT p.*, COALESCE(s.first_name || ' ' || s.last_name, 'Open Slot') as student_name, u.username as teacher_name
            FROM ptm_schedule p
            LEFT JOIN students s ON p.student_id = s.student_id
            JOIN users u ON p.teacher_id = u.id
            WHERE p.id = $1::uuid
        `, [req.params.id]);

        if (result.rows.length === 0) return res.status(404).send('Meeting not found');
        const m = result.rows[0];
        const formatDate = (date) => date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        const start = new Date(m.meeting_time);
        const end = new Date(start.getTime() + m.duration_minutes * 60000);

        const icsContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//SchoolERP//PTM//EN
BEGIN:VEVENT
UID:${m.id}
DTSTAMP:${formatDate(new Date())}
DTSTART:${formatDate(start)}
DTEND:${formatDate(end)}
SUMMARY:PTM: ${m.teacher_name} & ${m.student_name}
DESCRIPTION:Type: ${m.meeting_type}\\nLink: ${m.meeting_link || 'N/A'}
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;

        res.setHeader('Content-Type', 'text/calendar');
        res.setHeader('Content-Disposition', `attachment; filename=meeting-${m.id.slice(0,8)}.ics`);
        res.send(icsContent);
    } catch (error) { res.status(500).send('Error generating calendar file'); }
});

// =========================================================
// 2. CORE ROUTES
// =========================================================

// Bulk Generate Open Slots (With Crash Fix)
router.post('/generate-slots', authenticateToken, async (req, res) => {
    const { teacher_id, date, start_time, end_time, duration, type, link } = req.body;
    
    // FIX: Validate ID immediately to prevent crash
    if (!isValidUUID(teacher_id)) return res.status(400).json({ message: 'Invalid Teacher ID. Please reload.' });

    try {
        const slots = [];
        let current = new Date(`${date}T${start_time}`);
        const end = new Date(`${date}T${end_time}`);
        const durationMs = duration * 60000;

        while (current < end) {
            slots.push([teacher_id, new Date(current), duration, type, link, 'Open']);
            current = new Date(current.getTime() + durationMs);
        }

        for (const slot of slots) {
            await pool.query(
                `INSERT INTO ptm_schedule (teacher_id, meeting_time, duration_minutes, meeting_type, meeting_link, status) VALUES ($1, $2, $3, $4, $5, $6)`, 
                slot
            );
        }
        res.status(201).json({ message: `Successfully generated ${slots.length} open slots.` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Generation failed.' });
    }
});

// Student Books an Open Slot (With Notifications)
router.post('/book/:id', authenticateToken, async (req, res) => {
    const { student_id, agenda } = req.body;
    if (!isValidUUID(student_id)) return res.status(400).json({ message: 'Invalid Student ID' });

    try {
        const result = await pool.query(
            `UPDATE ptm_schedule SET status = 'Scheduled', student_id = $1, agenda = $2 WHERE id = $3 AND status = 'Open' RETURNING id`,
            [student_id, agenda, req.params.id]
        );
        if (result.rowCount === 0) return res.status(400).json({ message: 'Slot already booked or invalid.' });
        
        // [FEATURE] Simulated Notification
        console.log(`🔔 SMS SENT: Student ${student_id} booked slot ${req.params.id}. Agenda: ${agenda}`);

        res.json({ message: 'Slot booked successfully!' });
    } catch (error) { res.status(500).json({ message: 'Booking failed.' }); }
});

router.get('/teacher/:teacherId/open', authenticateToken, async (req, res) => {
    if (!isValidUUID(req.params.teacherId)) return res.json([]); // Return empty list instead of crashing
    try {
        const result = await pool.query(`
            SELECT id, meeting_time, duration_minutes, meeting_type, meeting_link 
            FROM ptm_schedule 
            WHERE teacher_id = $1::uuid AND status = 'Open' AND meeting_time > NOW() 
            ORDER BY meeting_time ASC`, 
            [req.params.teacherId]);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ message: 'Error fetching open slots' }); }
});

// Manual Schedule
router.post('/schedule', authenticateToken, async (req, res) => {
    const { teacher_id, student_id, meeting_time, duration_minutes, meeting_type, meeting_link, agenda } = req.body;
    if (!isValidUUID(teacher_id) || !isValidUUID(student_id)) return res.status(400).json({ message: 'Invalid IDs.' });

    try {
        await pool.query(`INSERT INTO ptm_schedule (teacher_id, student_id, meeting_time, duration_minutes, meeting_type, meeting_link, agenda, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Scheduled')`, 
            [teacher_id, student_id, meeting_time, duration_minutes, meeting_type, meeting_link, agenda]);
        res.status(201).json({ message: 'Meeting scheduled manually.' });
    } catch (error) { res.status(500).json({ message: error.message }); }
});

router.post('/cancel/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query(`UPDATE ptm_schedule SET status = 'Canceled', cancel_reason = $1 WHERE id = $2`, [req.body.reason, req.params.id]);
        res.json({ message: 'Meeting canceled.' });
    } catch (error) { res.status(500).json({ message: 'Error cancelling meeting.' }); }
});

router.get('/teacher/:teacherId/slots', authenticateToken, async (req, res) => {
    if (!isValidUUID(req.params.teacherId)) return res.json([]);
    try {
        const query = `
            SELECT p.id, p.meeting_time, p.duration_minutes, p.status, p.meeting_type, p.meeting_link, p.agenda, p.cancel_reason,
            (s.first_name || ' ' || s.last_name) AS student_name,
            EXISTS(SELECT 1 FROM ptm_feedback f WHERE f.schedule_id = p.id) as has_feedback
            FROM ptm_schedule p LEFT JOIN students s ON p.student_id = s.student_id
            WHERE p.teacher_id = $1::uuid ORDER BY p.meeting_time ASC;
        `;
        const result = await pool.query(query, [req.params.teacherId]);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ message: 'Failed to load schedule.' }); }
});

router.post('/feedback/:scheduleId', authenticateToken, async (req, res) => {
    const { meeting_status, academic_score, behavior_score, goals_discussed, parent_comments } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO ptm_feedback (schedule_id, academic_score, behavior_score, goals_discussed, parent_comments) VALUES ($1, $2, $3, $4, $5)`, 
            [req.params.scheduleId, academic_score, behavior_score, goals_discussed, parent_comments]);
        await client.query(`UPDATE ptm_schedule SET status = $1 WHERE id = $2`, [meeting_status, req.params.scheduleId]);
        await client.query('COMMIT');
        res.status(201).json({ message: 'Feedback submitted.' });
    } catch (error) { await client.query('ROLLBACK'); res.status(500).json({ message: 'Failed to submit feedback.' }); } finally { client.release(); }
});

router.get('/student/:studentId/report', authenticateToken, async (req, res) => {
    if (!isValidUUID(req.params.studentId)) return res.json([]);
    try {
        const query = `
            SELECT p.meeting_time, p.status, p.meeting_type, p.meeting_link, p.agenda, p.cancel_reason,
            u.username AS teacher_name, f.academic_score, f.behavior_score, f.goals_discussed, f.parent_comments, f.created_at AS submitted_at,
            (CASE WHEN f.id IS NOT NULL THEN true ELSE false END) as has_feedback
            FROM ptm_schedule p JOIN users u ON p.teacher_id = u.id LEFT JOIN ptm_feedback f ON p.id = f.schedule_id
            WHERE p.student_id = $1::uuid ORDER BY p.meeting_time DESC;
        `;
        const result = await pool.query(query, [req.params.studentId]);
        res.json(result.rows);
    } catch (error) { res.status(500).json({ message: 'Failed to generate report.' }); }
});

module.exports = router;