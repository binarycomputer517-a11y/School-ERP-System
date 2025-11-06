// routes/certificates.js

const express = require('express');
const router = express.Router();
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs').promises; // Use promises version of fs
const path = require('path');
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware'); 
// NOTE: Install and require your PDF library here (e.g., const puppeteer = require('puppeteer');)


// =========================================================
// CRITICAL FIX: HELPER FUNCTION MOVED TO MODULE SCOPE
// =========================================================

/**
 * Helper function to fetch all detailed report data (Header info + Marks details).
 * This function is now accessible by the /detail and /pdf routes.
 */
async function fetchReportDetails(studentId, examId) {
    
    // 1. Fetch Student/Course/Exam header info
    const headerQuery = `
        SELECT 
            s.enrollment_no, s.first_name, s.last_name, 
            c.course_name, b.batch_name, 
            e.exam_name, e.exam_date
        FROM students s
        JOIN courses c ON s.course_id = c.id
        JOIN batches b ON s.batch_id = b.id
        JOIN exams e ON e.id = $2
        WHERE s.id = $1;
    `;
    const headerResult = await pool.query(headerQuery, [studentId, examId]);
    if (headerResult.rows.length === 0) {
        return null; // Student or Exam header not found
    }
    const studentInfo = headerResult.rows[0];

    // 2. Fetch Marks for all subjects in that exam for the student
    const marksDetailQuery = `
        SELECT 
            sub.subject_name, sub.subject_code,
            m.marks_obtained_theory,
            m.marks_obtained_practical,
            m.total_marks_obtained,
            m.grade,
            -- Max Marks for the exam/subject combination
            es.max_marks AS total_max_marks,
            m.is_absent
        FROM marks m
        JOIN subjects sub ON m.subject_id = sub.id
        LEFT JOIN exam_schedules es ON m.exam_id = es.exam_id AND m.subject_id = es.subject_id
        WHERE m.student_id = $1 AND m.exam_id = $2
        ORDER BY sub.subject_code;
    `;
    const marksResult = await pool.query(marksDetailQuery, [studentId, examId]);

    // 3. Aggregate Total Scores
    let grandTotalObtained = 0;
    let grandTotalMax = 0;
    
    marksResult.rows.forEach(row => {
        grandTotalObtained += parseFloat(row.total_marks_obtained || 0);
        grandTotalMax += parseFloat(row.total_max_marks || 0);
    });
    
    // 4. Return consolidated data
    return {
        ...studentInfo,
        exam_id: examId,
        marks_details: marksResult.rows,
        summary: {
            grand_total_obtained: grandTotalObtained.toFixed(2),
            grand_total_max: grandTotalMax.toFixed(2),
            overall_percentage: grandTotalMax > 0 ? ((grandTotalObtained / grandTotalMax) * 100).toFixed(2) : '0.00'
        }
    };
}
// =========================================================


// =========================================================
// 1. CERTIFICATE REQUEST ROUTE 
// =========================================================

/**
 * @route   POST /api/certificates/request/bonafide
 * @desc    Submits a student's request for a Bonafide Certificate.
 * @access  Private (Student)
 */
router.post('/request/bonafide', authenticateToken, authorize('Student'), async (req, res) => {
    // This route's primary function is to insert a record for admin processing.
    const student_id = req.user.id; 
    const { reason_for_request } = req.body; 

    if (!student_id) {
        return res.status(400).json({ message: 'Student ID missing from authentication token.' });
    }

    try {
        // This query requires the 'certificate_requests' table to exist.
        const query = `
            INSERT INTO certificate_requests (
                student_id, 
                certificate_type, 
                status, 
                request_details
            )
            VALUES ($1, 'Bonafide', 'Pending', $2)
            RETURNING id, created_at;
        `;
        
        const result = await pool.query(query, [student_id, reason_for_request || 'General Bonafide request']);

        res.status(201).json({ 
            message: 'Bonafide Certificate request submitted successfully.',
            requestId: result.rows[0].id,
            requestDate: result.rows[0].created_at
        });

    } catch (error) {
        console.error('Error submitting certificate request:', error);
        if (error.code === '23505') {
            return res.status(409).json({ message: 'You already have a pending or recent request for this certificate type.' });
        }
        res.status(500).json({ message: 'Server error while processing certificate request.' });
    }
});


// =========================================================
// 2. DIRECT PDF GENERATION ROUTE (FIXED PERMISSIONS)
// =========================================================

/**
 * @route   POST /api/certificates/generate
 * @desc    Generates and sends the PDF certificate based on provided data.
 * @access  Private (Admin, Teacher, Student) <--- FIXED PERMISSION
 */
router.post('/generate', authenticateToken, authorize(['Admin', 'Teacher', 'Student']), async (req, res) => {
    //                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ THIS IS THE FIX

    console.log("✅ Received request at POST /api/certificates/generate");
    const certificateData = req.body;
    const userId = req.user ? req.user.id : null;

    // Basic validation
    if (!userId) {
        return res.status(403).json({ message: "User not authenticated properly." });
    }
    if (!certificateData.studentName || !certificateData.courseEvent || !certificateData.issueDate || !certificateData.templateId) {
        return res.status(400).json({ message: "Missing required certificate data." });
    }

    try {
        // --- Generate Actual PDF Bytes using the NEW helper function ---
        const pdfBytes = await generateCertificatePDF(certificateData);

        // --- Set Correct Headers for PDF Download ---
        const filename = `Certificate-${certificateData.studentName.replace(/[^a-zA-Z0-9]/g, '_')}-${Date.now()}.pdf`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/pdf');

        // --- Send the PDF data as the response ---
        res.send(Buffer.from(pdfBytes));
        console.log(`✅ Sent PDF certificate for ${certificateData.studentName}`);

    } catch (error) {
        console.error("❌ Error during certificate generation route:", error);
        if (!res.headersSent) {
            res.status(500).json({ message: error.message || "Server error generating certificate." });
        }
    }
});


// =========================================================
// 3. PDF DOWNLOAD ROUTE (Using query token, for report card PDF)
// =========================================================

/**
 * @route   GET /api/report-card/pdf/student/:studentId/exam/:examId
 * @desc    Generates and streams the PDF report card (Requires token via query string).
 * @access  Private (Admin, Teacher, Student)
 */
router.get('/report-card/pdf/student/:studentId/exam/:examId', authenticateToken, authorize(['Admin', 'Teacher', 'Student']), async (req, res) => {
    const { studentId, examId } = req.params;

    try {
        // --- STEP 1: Fetch all data needed for the PDF ---
        const reportData = await fetchReportDetails(studentId, examId);

        if (!reportData) {
            return res.status(404).json({ message: 'Report data not found for PDF generation.' });
        }
        
        // ------------------------------------------------------------------------
        // --- STEP 2: PDF GENERATION LOGIC GOES HERE ---
        // ------------------------------------------------------------------------

        /* // 1. You must implement a function to convert the reportData into a beautiful HTML string.
        const htmlContent = generateReportHtml(reportData); 
        
        // 2. Use a library like Puppeteer/PDFKit to generate the buffer.
        const pdfBuffer = await generatePdfFromHtml(htmlContent); // e.g., using Puppeteer
        */

        // --- MOCK RESPONSE: MUST BE REPLACED WITH REAL PDF LOGIC ---
        const mockContent = `
            <html><body style="padding: 30px;">
                <h2 style="color: #003366;">Report Card - ${reportData.exam_name}</h2>
                <p>Student: ${reportData.first_name} ${reportData.last_name} (Enrollment: ${reportData.enrollment_no})</p>
                <p>Course: ${reportData.course_name} (${reportData.batch_name})</p>
                <p>Overall Percentage: ${reportData.summary.overall_percentage}%</p>
                <p style="color: red;">ACTION REQUIRED: Implement Puppeteer/PDFKit logic here to fix PDF failure.</p>
            </body></html>
        `;
        const pdfBuffer = Buffer.from(mockContent, 'utf-8'); 

        // ------------------------------------------------------------------------
        
        // --- STEP 3: Send the PDF to the client ---
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="ReportCard_${reportData.enrollment_no}_${examId}.pdf"`);
        res.send(pdfBuffer);

    } catch (error) {
        console.error('PDF Generation Error:', error);
        res.status(500).json({ message: 'Failed to generate PDF report due to internal server error.' });
    }
});


// --- HELPER: generateCertificatePDF (using pdf-lib) ---
// NOTE: This helper is defined correctly above this section in the actual module file structure.
async function generateCertificatePDF(data) {
    // ... (logic omitted for brevity, but it remains the same as provided)
    try {
        const pdfDoc = await PDFDocument.create();
        // ... (PDF drawing logic)
        const pdfBytes = await pdfDoc.save();
        return pdfBytes;
    } catch (error) {
         console.error("Error within generateCertificatePDF function:", error);
         throw new Error("Failed to generate Classic Elegance PDF document internally.");
    }
}


// --- THIS MUST BE THE LAST LINE ---
module.exports = router;