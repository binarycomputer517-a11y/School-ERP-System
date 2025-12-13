// routes/reportCard.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken, authorize } = require('../authMiddleware');
const puppeteer = require('puppeteer'); 


// =========================================================
// HELPER FUNCTION: FETCH FULL REPORT DATA
// =========================================================

/**
 * Helper function to fetch all detailed report data (Header info + Marks details).
 */
async function fetchReportDetails(studentId, examId) {
    
    // 1. Fetch Student/Course/Exam header info
    const headerQuery = `
        SELECT 
            s.enrollment_no, s.first_name, s.last_name, 
            c.course_name, b.batch_name, 
            e.exam_name, e.exam_date
        FROM students s
        LEFT JOIN courses c ON s.course_id = c.id
        LEFT JOIN batches b ON s.batch_id = b.id
        LEFT JOIN exams e ON e.id = $2::uuid
        WHERE s.student_id = $1::uuid; 
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
        LEFT JOIN subjects sub ON m.subject_id = sub.id
        LEFT JOIN exam_schedules es ON m.exam_id = es.exam_id AND m.subject_id = es.subject_id
        WHERE m.student_id = $1::uuid AND m.exam_id = $2::uuid
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
// 1. REPORT CARD AVAILABLE EXAMS (Dropdown Data)
// =========================================================

/**
 * @route   GET /api/report-card/exams/student/:studentId
 * @desc    Fetches the list of completed exams for a specific student to generate a report.
 * @access  Private (Admin, Teacher, Student)
 */
router.get('/exams/student/:studentId', authenticateToken, authorize(['Admin', 'Teacher', 'Student']), async (req, res) => {
    const { studentId } = req.params;
    
    try {
        const query = `
            SELECT DISTINCT 
                e.id AS exam_id, 
                e.exam_name, 
                e.exam_date,
                c.course_name,
                b.batch_name
            FROM marks m
            LEFT JOIN exams e ON m.exam_id = e.id
            LEFT JOIN students s ON m.student_id = s.student_id 
            LEFT JOIN courses c ON s.course_id = c.id
            LEFT JOIN batches b ON s.batch_id = b.id
            WHERE m.student_id = $1::uuid 
            ORDER BY e.exam_date DESC;
        `;
        
        const result = await pool.query(query, [studentId]);
        
        res.json(result.rows);
    } catch (error) {
        console.error('SQL Error fetching available exams for report card:', error);
        res.status(500).json({ message: 'Failed to retrieve available exams for report card.' });
    }
});


// =========================================================
// 2. REPORT CARD DETAILED DATA FETCH (Frontend View)
// =========================================================

/**
 * @route   GET /api/report-card/detail/student/:studentId/exam/:examId
 * @desc    Fetches detailed marks, totals, and grades for a specific student and exam.
 * @access  Private (Admin, Teacher, Student)
 */
router.get('/detail/student/:studentId/exam/:examId', authenticateToken, authorize(['Admin', 'Teacher', 'Student']), async (req, res) => {
    const { studentId, examId } = req.params;

    try {
        const reportData = await fetchReportDetails(studentId, examId);

        if (!reportData) {
            return res.status(404).json({ message: 'Student or Exam not found.' });
        }

        res.status(200).json(reportData);

    } catch (error) {
        console.error('Error fetching detailed report card:', error);
        res.status(500).json({ message: 'Failed to retrieve detailed report card data.' });
    }
});


// =========================================================
// 3. PDF GENERATION ROUTE (PUPPETEER RELIABILITY FIX)
// =========================================================

/**
 * @route   GET /api/report-card/pdf/student/:studentId/exam/:examId
 * @desc    Generates and streams the PDF report card (Requires token via query string).
 * @access  Private (Admin, Teacher, Student)
 */
router.get('/pdf/student/:studentId/exam/:examId', authenticateToken, authorize(['Admin', 'Teacher', 'Student']), async (req, res) => {
    const { studentId, examId } = req.params;

    // --- Placeholder HTML Template Function ---
    const generateReportHtml = (data) => {
         // In a real app, you would use a template engine (Handlebars, EJS) here.
         return `
             <html><head><style>
                 @page { size: A4; margin: 1cm; }
                 body { font-family: Arial, sans-serif; margin: 0; padding: 0; font-size: 10pt; }
                 .report-container { width: 100%; max-width: 700px; margin: auto; }
                 .header { background-color: #005A9C; color: white; padding: 15px; text-align: center; border-bottom: 5px solid #C0392B; }
                 .details { margin-top: 20px; margin-bottom: 20px; border: 1px solid #ccc; padding: 10px; }
                 .marks-table { width: 100%; border-collapse: collapse; margin-top: 15px; }
                 .marks-table th { background-color: #f0f0f0; border: 1px solid #ccc; padding: 8px; text-align: left; }
                 .marks-table td { border: 1px solid #ccc; padding: 8px; text-align: left; }
                 .summary-box { margin-top: 20px; border-top: 2px solid #000; padding-top: 10px; font-weight: bold; }
             </style></head><body>
                 <div class="report-container">
                     <div class="header">
                         <h1>Academic Report Card</h1>
                         <p>${data.exam_name} - Date: ${new Date(data.exam_date).toLocaleDateString()}</p>
                     </div>
                     <div class="details">
                         <p><strong>Name:</strong> ${data.first_name} ${data.last_name}</p>
                         <p><strong>Enrollment No:</strong> ${data.enrollment_no}</p>
                         <p><strong>Course/Batch:</strong> ${data.course_name} (${data.batch_name})</p>
                     </div>
                     <table class="marks-table">
                         <thead><tr><th>Subject</th><th>Theory</th><th>Practical</th><th>Obtained</th><th>Max Marks</th><th>Grade</th></tr></thead>
                         <tbody>
                             ${data.marks_details.map(m => `
                                 <tr>
                                     <td>${m.subject_name}</td>
                                     <td>${m.marks_obtained_theory || 'N/A'}</td>
                                     <td>${m.marks_obtained_practical || 'N/A'}</td>
                                     <td>${m.total_marks_obtained}</td>
                                     <td>${m.total_max_marks}</td>
                                     <td>${m.grade || 'N/A'}</td>
                                 </tr>
                             `).join('')}
                         </tbody>
                     </table>
                     <div class="summary-box">
                         <p><strong>Grand Total Obtained:</strong> ${data.summary.grand_total_obtained} / ${data.summary.grand_total_max}</p>
                         <p><strong>Overall Percentage:</strong> ${data.summary.overall_percentage}%</p>
                     </div>
                 </div>
             </body></html>
         `;
    };


    try {
        // --- STEP 1: Fetch all data needed for the PDF ---
        const reportData = await fetchReportDetails(studentId, examId);

        if (!reportData) {
            return res.status(404).json({ message: 'Report data not found for PDF generation.' });
        }
        
        // --- STEP 2: PDF GENERATION LOGIC ---
        
        const htmlContent = generateReportHtml(reportData);
        
        let pdfBuffer;
        let browser;

        // CRITICAL FIX: Use try...finally to prevent the "Frame Detached" error and resource leaks.
        try {
            // Use 'headless: "new"' for stability and essential server arguments
            // Fallback for local launch if it fails with default args
            
            // Check if running in a potentially restrictive environment (e.g., local Mac without full Chrome path or cloud)
            const isLocalMac = process.platform === 'darwin' && !process.env.NODE_ENV;
            
            browser = await puppeteer.launch({ 
                headless: "new",
                // Conditional args for cloud/non-local environments
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox', 
                    '--disable-dev-shm-usage',
                    '--single-process',
                    '--no-zygote'
                ],
                // On local, try to use system Chrome if standard Puppeteer fails
                // You might need to uncomment and adjust the executablePath if local launch fails
                // executablePath: isLocalMac ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
                timeout: 60000 
            }); 
            const page = await browser.newPage();
            
            // Set longer timeout for page loading content
            await page.setContent(htmlContent, { 
                waitUntil: ['domcontentloaded', 'load'], 
                timeout: 60000 
            });
            
            pdfBuffer = await page.pdf({ 
                format: 'A4', 
                printBackground: true,
                margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' }
            });

        } catch (launchError) {
            console.error('Puppeteer Launch/PDF Error:', launchError);
            // If Puppeteer fails entirely, send a fallback message instead of crashing the process
            res.status(500).json({ message: 'PDF Generation failed. Check server logs for Puppeteer dependency issues.' });
            return;
        } finally {
            // Ensure the browser instance is closed regardless of success/failure
            if (browser) {
                await browser.close();
            }
        }
        
        // --- STEP 3: Send the generated buffer ---
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="ReportCard_${reportData.enrollment_no}_${examId}.pdf"`);
        res.send(pdfBuffer);


    } catch (error) {
        // Log the external error for server diagnosis
        console.error('Report Card Route Error:', error); 
        res.status(500).json({ message: 'Failed to retrieve report data due to an internal server error.' });
    }
});


module.exports = router;