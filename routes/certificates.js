const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const crypto = require('crypto');
const QRCode = require('qrcode');

// Memory storage for uploads
const upload = multer({ storage: multer.memoryStorage() });

// Helper: Format Date
function formatDate(dateString) {
    if (!dateString) return new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// POST /api/certificates/generate
router.post('/generate', authenticateToken, upload.fields([
    { name: 'backgroundImage', maxCount: 1 },
    { name: 'signature1', maxCount: 1 },
    { name: 'signature2', maxCount: 1 }
]), async (req, res) => {

    console.log("📝 Certificate Request Body:", req.body); // Debug log

    const { classId, certTitle, courseEvent, issueDate, certBody, orientation, dataSource } = req.body;

    // Stream Setup
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=certificates.zip');
    archive.pipe(res);

    try {
        let students = [];

        // 1. Fetch Data
        // Logic: If classId is provided, we assume Database mode, regardless of dataSource flag to be safe.
        if (classId && classId !== "undefined" && classId !== "") {
            console.log(`🔍 Fetching students for Class ID: ${classId}`);
            
            // Query with COALESCE to handle nulls gracefully
            const query = `
                SELECT 
                    s.student_id, s.first_name, s.last_name, s.roll_number,
                    COALESCE(c.course_name, '') AS class_name,
                    COALESCE(b.batch_name, '') AS section_name
                FROM students s
                LEFT JOIN batches b ON s.batch_id = b.id
                LEFT JOIN courses c ON b.course_id = c.id
                WHERE s.batch_id = $1
            `;
            const result = await pool.query(query, [classId]);
            students = result.rows;
            console.log(`✅ Found ${students.length} students.`);
        } else {
            console.log("⚠️ No Class ID provided. Using Dummy External Data.");
            // External/CSV Dummy Data (Only happens if no class is selected)
            students = [{ 
                first_name: 'External', 
                last_name: 'Participant', 
                student_id: null, 
                class_name: 'External', 
                section_name: '' 
            }];
        }

        if (students.length === 0) {
            const doc = new PDFDocument();
            archive.append(doc, { name: 'error.pdf' });
            doc.text('No students found in the selected class.');
            doc.end();
        }

        // 2. Generate PDF Loop
        for (const student of students) {
            const studentName = `${student.first_name} ${student.last_name}`.trim();
            
            // Logic to handle Class Name display
            let fullClassName = "";
            if (student.class_name || student.section_name) {
                fullClassName = `${student.class_name} ${student.section_name}`.trim();
            } else {
                fullClassName = "Open Category";
            }
                
            const formattedDate = formatDate(issueDate);
            const uniqueId = `CERT-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

            // Save to DB (if internal student)
            if (student.student_id) {
                // We wrap this in a try-catch so one DB error doesn't stop the whole PDF generation
                try {
                    await pool.query(
                        `INSERT INTO certificates (certificate_uid, student_id, course_name, issue_date) 
                         VALUES ($1, $2, $3, $4)
                         ON CONFLICT (certificate_uid) DO NOTHING`,
                        [uniqueId, student.student_id, courseEvent, issueDate]
                    );
                } catch (dbError) {
                    console.error("Error saving certificate to DB:", dbError);
                }
            }

            // QR Code
            const verifyUrl = `${req.protocol}://${req.get('host')}/verify.html?id=${uniqueId}`;
            const qrBuffer = await QRCode.toBuffer(verifyUrl, { margin: 1, width: 100, color: { dark: '#002b49' } });

            // Initialize PDF
            const doc = new PDFDocument({
                layout: orientation || 'landscape',
                size: 'A4',
                margin: 0
            });

            archive.append(doc, { name: `${studentName.replace(/ /g,'_')}_${uniqueId}.pdf` });

            const w = doc.page.width;
            const h = doc.page.height;
            const centerX = w / 2;

            // --- A. DESIGN ---
            if (req.files.backgroundImage) {
                try {
                    doc.image(req.files.backgroundImage[0].buffer, 0, 0, { width: w, height: h });
                } catch(e) {}
            } else {
                // Default Border
                doc.rect(20, 20, w - 40, h - 40).lineWidth(5).strokeColor('#b88a4d').stroke();
                doc.rect(28, 28, w - 56, h - 56).lineWidth(1).strokeColor('#e5c376').stroke();
            }

            // --- B. TEXT CONTENT ---
            doc.moveDown(2.5);
            
            // Title
            doc.font('Times-Bold').fontSize(42).fillColor('#b88a4d')
               .text(certTitle.toUpperCase(), 0, 80, { align: 'center', characterSpacing: 2 });
            
            doc.moveDown(0.5);
            doc.font('Helvetica').fontSize(10).fillColor('#555')
               .text('IS HEREBY AWARDED TO', { align: 'center', letterSpacing: 4 });

            // Student Name
            doc.moveDown(0.5);
            doc.font('Times-Italic').fontSize(55).fillColor('#b88a4d')
               .text(studentName, { align: 'center' });
            
            // Name Underline (Optional)
            // doc.lineWidth(0.5).strokeColor('#ccc').moveTo(centerX - 150, doc.y).lineTo(centerX + 150, doc.y).stroke();

            // Body Text
            doc.moveDown(1); 
            
            // Global Replacement Logic
            let processedBody = (certBody || "")
                .split('{{StudentName}}').join(studentName)
                .split('{{Class}}').join(fullClassName)
                .split('{{Event}}').join(courseEvent)
                .split('{{Date}}').join(formattedDate);

            doc.font('Times-Roman').fontSize(14).fillColor('#333')
               .text(processedBody, 80, doc.y + 10, { align: 'center', width: w - 160, lineGap: 8 });

            // Date Display
            doc.moveDown(1);
            doc.fontSize(12).fillColor('#555').text(`DATE: ${formattedDate}`, { align: 'center', letterSpacing: 1 });

            // --- C. FOOTER ---
            const footerY = h - 130;

            // Center Seal
            // Outer Circle
            doc.circle(centerX, footerY, 45).lineWidth(2).strokeColor('#b88a4d').stroke();
            // Inner Circle
            doc.circle(centerX, footerY, 40).lineWidth(0.5).strokeColor('#e5c376').stroke();
            // Text inside Seal
            doc.fontSize(7).fillColor('#b88a4d').font('Helvetica-Bold')
               .text('OFFICIAL', centerX - 20, footerY - 10, { align: 'center', width: 40 });
            doc.text('AWARD', centerX - 20, footerY, { align: 'center', width: 40 });

            // Signatures
            const sigY = footerY + 10;

            // Signature 1
            doc.lineWidth(1).strokeColor('#b88a4d').moveTo(100, sigY).lineTo(280, sigY).stroke();
            doc.fontSize(11).fillColor('#002b49').font('Times-Bold')
               .text(req.body.sig1Name || 'Principal', 100, sigY + 10, { width: 180, align: 'center' });
            
            if (req.files.signature1) {
                doc.image(req.files.signature1[0].buffer, 140, sigY - 50, { height: 45 });
            }

            // Signature 2
            doc.lineWidth(1).strokeColor('#b88a4d').moveTo(w - 280, sigY).lineTo(w - 100, sigY).stroke();
            doc.fontSize(11).fillColor('#002b49')
               .text(req.body.sig2Name || 'Director', w - 280, sigY + 10, { width: 180, align: 'center' });

            if (req.files.signature2) {
                doc.image(req.files.signature2[0].buffer, w - 240, sigY - 50, { height: 45 });
            }

            // QR Code (Small, below seal)
            doc.image(qrBuffer, centerX - 20, footerY + 50, { width: 40 });
            doc.fontSize(6).fillColor('#999')
               .text(`ID: ${uniqueId}`, centerX - 50, footerY + 92, { width: 100, align: 'center' });

            doc.end();
        }

        await archive.finalize();

    } catch (error) {
        console.error('Cert Gen Error:', error);
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

module.exports = router;