const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const { authenticateToken } = require('../authMiddleware');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const crypto = require('crypto');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');

const upload = multer({ storage: multer.memoryStorage() });

// --- EMAIL CONFIG ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'your-email@gmail.com', // REPLACE
        pass: 'your-app-password'     // REPLACE
    }
});

function formatDate(dateString) {
    if (!dateString) return new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

async function sendCertificateEmail(studentEmail, studentName, pdfBuffer, courseName) {
    if (!studentEmail) return;
    try {
        await transporter.sendMail({
            from: '"University Admin" <no-reply@school.com>',
            to: studentEmail,
            subject: `Certificate of Participation - ${courseName}`,
            html: `<p>Dear ${studentName},<br>Please find your certificate attached.</p>`,
            attachments: [{ filename: `${studentName}_Certificate.pdf`, content: pdfBuffer }]
        });
        console.log(`✅ Email sent to ${studentEmail}`);
    } catch (e) { console.error(`❌ Email error: ${e.message}`); }
}

// --- GENERATE ROUTE ---
router.post('/generate', authenticateToken, upload.fields([
    { name: 'backgroundImage', maxCount: 1 },
    { name: 'signature1', maxCount: 1 },
    { name: 'signature2', maxCount: 1 }
]), async (req, res) => {

    const { 
        classId, certTitle, courseEvent, issueDate, certBody, 
        dataSource, sendEmail, sig1Name, sig2Name,
        accentColor, ribbonColor, fontFamily 
    } = req.body;
    
    // Defaults (Gold/Premium Style)
    const primaryColor = accentColor || '#8B0000'; // Maroon
    const secondaryColor = ribbonColor || '#E65100'; // Orange
    const titleText = certTitle || "CERTIFICATE";
    const subTitleText = "OF PARTICIPATION";

    // Fonts
    let titleFont = 'Times-Bold';
    let bodyFont = 'Times-Roman';
    if(fontFamily === 'Courier') { titleFont = 'Courier-Bold'; bodyFont = 'Courier'; }
    if(fontFamily === 'Helvetica') { titleFont = 'Helvetica-Bold'; bodyFont = 'Helvetica'; }

    const archive = archiver('zip', { zlib: { level: 9 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=certificates.zip');
    archive.pipe(res);

    try {
        let students = [];
        if (dataSource === 'database' && classId) {
            const query = `
                SELECT s.student_id, s.first_name, s.last_name, s.email, s.roll_number,
                COALESCE(c.course_name, '') AS class_name, COALESCE(b.batch_name, '') AS section_name
                FROM students s
                LEFT JOIN batches b ON s.batch_id = b.id
                LEFT JOIN courses c ON b.course_id = c.id
                WHERE s.batch_id = $1
            `;
            const result = await pool.query(query, [classId]);
            students = result.rows;
        } else {
            students = [{ first_name: 'External', last_name: 'User', student_id: null, email: null }];
        }

        if (students.length === 0) {
            const doc = new PDFDocument();
            archive.append(doc, { name: 'error.pdf' });
            doc.text('No students found.');
            doc.end();
        }

        for (const student of students) {
            const name = `${student.first_name} ${student.last_name}`.trim();
            const className = (student.class_name || student.section_name) ? `${student.class_name} ${student.section_name}` : '';
            const uid = `CERT-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
            const dateStr = formatDate(issueDate);

            if (student.student_id) {
                await pool.query(
                    `INSERT INTO certificates (certificate_uid, student_id, course_name, issue_date, status) 
                     VALUES ($1, $2, $3, $4, 'Valid') ON CONFLICT (certificate_uid) DO NOTHING`,
                    [uid, student.student_id, courseEvent, issueDate]
                );
            }

            // QR Code (Navy Blue)
            const verifyUrl = `${req.protocol}://${req.get('host')}/verify.html?id=${uid}`;
            const qrBuffer = await QRCode.toBuffer(verifyUrl, { margin: 0, width: 70, color: { dark: '#002b49' } });

            const doc = new PDFDocument({ layout: 'landscape', size: 'A4', margin: 0 });
            let buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', async () => {
                if (String(sendEmail) === 'true' && student.email) {
                    await sendCertificateEmail(student.email, name, Buffer.concat(buffers), courseEvent);
                }
            });

            archive.append(doc, { name: `${name.replace(/ /g,'_')}.pdf` });

            const w = doc.page.width; 
            const h = doc.page.height;

            // --- A. BACKGROUND ---
            if (req.files.backgroundImage) {
                try { doc.image(req.files.backgroundImage[0].buffer, 0, 0, { width: w, height: h }); } catch(e){}
            } else {
                doc.rect(20, 20, w-40, h-40).lineWidth(3).strokeColor(primaryColor).stroke();
            }

            // --- B. TOP HEADER ELEMENTS (QR & ID) ---
            
            // 1. Certificate No (Top Left)
            doc.fontSize(9).fillColor('#333').font('Helvetica-Bold')
               .text(`Certificate No: ${uid}`, 40, 50, { align: 'left' });

            // 2. QR Code (Top Right)
            doc.image(qrBuffer, w - 110, 40, { width: 60 });
            doc.fontSize(7).fillColor('#555')
               .text("Scan to Verify", w - 110, 105, { width: 60, align: 'center' });

            // --- C. MAIN HEADER ---
            doc.moveDown(4); 
            
            doc.font(titleFont).fontSize(50).fillColor(primaryColor)
               .text(titleText.toUpperCase(), 0, 130, { align: 'center', characterSpacing: 2 });

            // Ribbon
            const rw = 320, rh = 30, rx = (w - rw)/2, ry = doc.y + 5;
            doc.rect(rx, ry, rw, rh).fill(secondaryColor);
            doc.fontSize(15).fillColor('white').font('Helvetica-Bold')
               .text(subTitleText, 0, ry + 8, { align: 'center', letterSpacing: 2 });

            // --- D. BODY ---
            doc.moveDown(3);
            doc.fillColor('black').font(bodyFont).fontSize(14).text('This is to certify that', { align: 'center' });
            
            doc.moveDown(0.5);
            doc.font(titleFont).fontSize(32).fillColor(primaryColor)
               .text(name.toUpperCase(), { align: 'center' });

            doc.moveDown(0.8);
            
            let body = (certBody || "Has successfully participated in the event.")
                .replace(/{{StudentName}}/g, name)
                .replace(/{{Class}}/g, className)
                .replace(/{{Event}}/g, courseEvent)
                .replace(/{{Date}}/g, dateStr);

            doc.font(bodyFont).fontSize(13).fillColor('#333')
               .text(body, 80, doc.y, { align: 'center', width: w-160 });

            // --- E. FOOTER SIGNATURES ---
            const fy = h - 120;
            const leftX = 100;
            const rightX = w - 260;
            const cx = w/2;
            
            // Left Sig
            if(req.files.signature1) doc.image(req.files.signature1[0].buffer, leftX+20, fy-40, { height:40 });
            doc.lineWidth(1).strokeColor('#333').moveTo(leftX, fy).lineTo(leftX+160, fy).stroke();
            doc.fontSize(11).fillColor(primaryColor).font(titleFont).text(sig1Name || "Principal", leftX, fy+5, { width: 160, align: 'center' });

            // Gold Seal (Center)
            doc.circle(cx, fy - 10, 45).lineWidth(2).strokeColor('#DAA520').stroke(); 
            doc.circle(cx, fy - 10, 40).lineWidth(0.5).strokeColor('#B8860B').stroke();
            doc.fontSize(7).fillColor('#DAA520').text('OFFICIAL\nAWARD', cx - 20, fy - 15, { align: 'center', width: 40 });

            // Right Sig
            if(req.files.signature2) doc.image(req.files.signature2[0].buffer, rightX+20, fy-40, { height:40 });
            doc.lineWidth(1).strokeColor('#333').moveTo(rightX, fy).lineTo(rightX+160, fy).stroke();
            doc.fontSize(11).fillColor(primaryColor).font(titleFont).text(sig2Name || "Director", rightX, fy+5, { width: 160, align: 'center' });

            // --- F. BOTTOM ELEMENTS (Date & Website) ---
            
            // 1. Published Date (Bottom Left)
            doc.fontSize(9).fillColor('#555').font('Helvetica-Bold')
               .text(`Published Date: ${dateStr}`, 40, h - 40, { align: 'left' });

            // 2. Website (Bottom Right)
            doc.fontSize(9).fillColor('#555').font('Helvetica')
               .text('www.gokuluniversity.ac.in', w - 240, h - 40, { align: 'right', width: 200 });

            doc.end();
        }
        await archive.finalize();
    } catch (e) {
        if(!res.headersSent) res.status(500).json({ error: e.message });
    }
});

module.exports = router;