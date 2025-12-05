/**
 * @fileoverview Express router for handling ID Card Generation (Individual and Bulk).
 * @module routes/idreports
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');

// --- Database & Constants (Ensure these match your actual setup) ---
const STUDENTS_TABLE = 'students';
const USERS_TABLE = 'users';
const REPORTING_ROLES = ['Super Admin', 'Admin', 'Registrar'];

// --- Helper Functions (Assuming toUUID is available globally or imported) ---
function toUUID(value) {
    if (!value || typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    return value.trim();
}

// =========================================================
// 1. GET: Generate Individual ID Card (/api/reports/generate-id)
// =========================================================

/**
 * @route   GET /generate-id
 * @desc    Generates a PDF/Image ID card for a single student ID provided via query parameter.
 * @access  Private (Admin/Registrar)
 */
router.get('/generate-id', authenticateToken, authorize(REPORTING_ROLES), async (req, res) => {
    const studentId = req.query.studentId;
    const safeStudentId = toUUID(studentId);

    if (!safeStudentId) {
        return res.status(400).json({ success: false, message: 'Invalid or missing student ID.' });
    }

    try {
        // Step 1: Fetch Required Student Data (Joining relevant tables)
        const query = `
            SELECT 
                s.admission_id, s.first_name, s.last_name, s.dob, s.blood_group,
                s.profile_image_path, s.enrollment_no, s.status,
                u.email,
                c.course_name, b.batch_name
            FROM ${STUDENTS_TABLE} s
            LEFT JOIN ${USERS_TABLE} u ON s.user_id = u.id
            LEFT JOIN courses c ON s.course_id = c.id
            LEFT JOIN batches b ON s.batch_id = b.id
            WHERE s.student_id = $1::uuid;
        `;
        const result = await pool.query(query, [safeStudentId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Student record not found.' });
        }
        const student = result.rows[0];

        // --- Step 2: Set Headers for PDF Download ---
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=ID_Card_${student.admission_id || 'UNKNOWN'}.pdf`);

        // --- Step 3: Conceptual PDF Generation Logic (Simulated) ---
        // NOTE: In a real app, this is where a reporting engine (like PDFKit) would render a binary stream.
        
        console.log(`[REPORTING]: Generating individual ID card for ${student.admission_id}...`);
        
        // Simulating the report content based on fetched data
        const mockPdfData = `
            SCHOOL ERP ID CARD
            -----------------------------
            Name: ${student.first_name} ${student.last_name}
            Admission ID: ${student.admission_id}
            Course: ${student.course_name || 'N/A'} / ${student.batch_name || 'N/A'}
            Status: ${student.status || 'N/A'}
            Photo Path: ${student.profile_image_path || 'No Photo'}
            -----------------------------
            (This is a simulated PDF content stream)
        `;

        res.status(200).send(mockPdfData); // Stream the generated content

    } catch (error) {
        console.error('ID Card Generation Error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate ID card due to server error.' });
    }
});

// =========================================================
// 2. GET: Generate Bulk ID Cards (/api/reports/generate-bulk-id)
// =========================================================

/**
 * @route   GET /generate-bulk-id
 * @desc    Generates a single PDF containing multiple student ID cards (via query string array).
 * @access  Private (Admin/Registrar)
 */
router.get('/generate-bulk-id', authenticateToken, authorize(REPORTING_ROLES), async (req, res) => {
    const studentIdsQuery = req.query.studentIds; // Comma-separated list of IDs: 'id1,id2,id3'
    if (!studentIdsQuery) {
        return res.status(400).json({ success: false, message: 'No student IDs provided for bulk generation.' });
    }
    
    // Step 1: Split IDs and sanitize
    const idArray = studentIdsQuery.split(',').map(id => toUUID(id)).filter(Boolean); // Filters out any null/invalid UUIDs
    
    // Step 2: Fetch all students in one query
    const placeholders = idArray.map((_, i) => `$${i + 1}::uuid`).join(',');
    
    try {
        const query = `
            SELECT admission_id, first_name, last_name, course_name, batch_name 
            FROM ${STUDENTS_TABLE} s
            LEFT JOIN courses c ON s.course_id = c.id
            LEFT JOIN batches b ON s.batch_id = b.id
            WHERE s.student_id IN (${placeholders});
        `;
        
        const result = await pool.query(query, idArray);
        const students = result.rows;

        // Step 3: Set Headers and Simulate Bulk Content
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=Bulk_ID_Cards.pdf');
        
        let bulkReportContent = "--- BULK ID CARD REPORT ---\n\n";
        students.forEach(s => {
            bulkReportContent += `ID: ${s.admission_id}, Name: ${s.first_name} ${s.last_name}\n`;
            bulkReportContent += `Course: ${s.course_name || 'N/A'} / Batch: ${s.batch_name || 'N/A'}\n`;
            bulkReportContent += `------------------------------------\n`;
        });

        res.status(200).send(bulkReportContent); // Stream the bulk content

    } catch (error) {
        console.error('Bulk Generation Error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate bulk ID cards.' });
    }
});


module.exports = router;