/**
 * services/emailService.js
 * -----------------------------
 * Centralized Email Dispatch System for School ERP.
 * Handles Financial Receipts, Administrative Provisioning, 
 * Automated Reports, and Student Attendance Alerts.
 */

const nodemailer = require('nodemailer');

// 1. Setup transporter using .env credentials
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: process.env.EMAIL_PORT || 587,
    secure: false, // true for 465, false for other ports
    auth: {
        user: process.env.EMAIL_USER, // e.g., schoolerp995@gmail.com
        pass: process.env.EMAIL_PASS  // Secure App Password
    }
});

/**
 * FEATURE 1: Sends a professional fee payment confirmation email
 * Triggered after successful online/manual payment synchronization.
 */
const sendPaymentEmail = async (to, studentName, amount, txnId) => {
    const mailOptions = {
        from: `"School ERP Finance" <${process.env.EMAIL_USER}>`,
        to: to,
        subject: 'Payment Confirmation - Fee Registry Updated',
        html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px; max-width: 600px;">
                <h2 style="color: #22c55e;">Payment Successful!</h2>
                <p>Dear <b>${studentName}</b>,</p>
                <p>We have successfully synchronized your fee payment of <b>₹${amount}</b> into our registry.</p>
                <p><b>Transaction ID:</b> <span style="color: #4f46e5;">${txnId}</span></p>
                <p>Your student ledger has been updated. You can download your official digital receipt from the student portal.</p>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="font-size: 12px; color: #666;">Regards,<br><b>Accounts Department</b><br>Institutional ERP System</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Payment confirmation broadcasted to: ${to}`);
        return { success: true };
    } catch (error) {
        console.error("❌ Payment Email Dispatch Failure:", error);
        return { success: false, error };
    }
};

/**
 * FEATURE 2: Sends an email with an attachment (Excel/PDF)
 * Used by Daily Report Automation & PDF Receipt Generation System.
 */
const sendEmailWithAttachment = async ({ to, subject, html, attachments }) => {
    const mailOptions = {
        from: `"School ERP Reports" <${process.env.EMAIL_USER}>`,
        to: to,
        subject: subject,
        html: html,
        attachments: attachments // Format: [{ filename: 'report.pdf', content: buffer }]
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Attachment-based report dispatched to: ${to}`);
        return { success: true };
    } catch (error) {
        console.error("❌ Attachment Dispatch Error:", error);
        return { success: false, error };
    }
};

/**
 * FEATURE 3: Sends a Welcome Email to Branch Managers
 * Triggered after institutional node provisioning.
 */
const sendManagerProvisionEmail = async (to, managerName, targetId, nodeCode) => {
    const portalUrl = process.env.PORTAL_URL || 'https://portal.bcsm.org.in';
    const downloadLink = `${portalUrl}/manager-id-card.html?id=${targetId}`;

    const mailOptions = {
        from: `"Institutional Master Registry" <${process.env.EMAIL_USER}>`,
        to: to,
        subject: `Institutional Access Provisioned - Digital ID [Node: ${nodeCode}]`,
        html: `
            <div style="font-family: 'Poppins', Arial, sans-serif; padding: 30px; border: 1px solid #e2e8f0; border-radius: 15px; max-width: 600px; color: #0f172a;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <h2 style="color: #1476B2; margin: 0; text-transform: uppercase; letter-spacing: 2px;">Authority Provisioning</h2>
                    <p style="font-size: 10px; color: #94a3b8; letter-spacing: 1px;">MASTER REGISTRY 2026</p>
                </div>

                <p>Dear <b>${managerName}</b>,</p>
                <p>Your branch has been successfully synchronized with our central network. Your <b>Digital Administrative Identity</b> is now active.</p>
                
                <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #1476B2; margin: 25px 0;">
                    <p style="margin: 0; font-size: 13px;"><b>Assigned Node:</b> ${nodeCode}</p>
                    <p style="margin: 0; font-size: 13px;"><b>Security Level:</b> Administrative Tier 1</p>
                </div>

                <div style="text-align: center; margin: 35px 0;">
                    <a href="${downloadLink}" 
                       style="background: #0f172a; color: #ffffff; padding: 14px 35px; text-decoration: none; border-radius: 50px; font-weight: 800; font-size: 12px; letter-spacing: 1px; box-shadow: 0 10px 20px rgba(15, 23, 42, 0.3);">
                       GENERATE & DOWNLOAD ID CARD
                    </a>
                </div>

                <p style="font-size: 11px; color: #64748b; line-height: 1.6;">
                    <b>Security Protocol:</b> Keep this link confidential. Your digital ID contains an encrypted QR code for institutional verification.
                </p>

                <hr style="border: 0; border-top: 1px dashed #cbd5e1; margin: 30px 0;">
                <p style="font-size: 10px; color: #94a3b8; text-align: center;">
                    Automated Secure Transmission. Please do not reply.
                </p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Node Provision Email sent to: ${to}`);
        return { success: true };
    } catch (error) {
        console.error("❌ Node Provisioning Email Error:", error);
        return { success: false, error };
    }
};

/**
 * NEW FEATURE 4: Automated Absence Alert (Neural Link Sync)
 * Triggered via attendance.js when a student is marked 'Absent'
 */
const sendAbsentEmail = async (to, studentName, date) => {
    const mailOptions = {
        from: `"Institutional Guardian Portal" <${process.env.EMAIL_USER}>`,
        to: to,
        subject: `Neural Link Alert: Absence Recorded [${date}]`,
        html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; padding: 25px; background: #f0f2f5; border-radius: 20px; max-width: 600px; color: #333;">
                <div style="background: linear-gradient(135deg, #6a1b9a 0%, #4a148c 100%); padding: 20px; border-radius: 15px 15px 0 0; color: white; text-align: center;">
                    <h3 style="margin: 0; letter-spacing: 1px;">TELEMETRY NOTIFICATION</h3>
                    <p style="font-size: 10px; opacity: 0.8; margin: 5px 0 0 0;">SECURE GUARDIAN HUD</p>
                </div>
                
                <div style="background: white; padding: 25px; border-radius: 0 0 15px 15px; box-shadow: 0 10px 20px rgba(0,0,0,0.05);">
                    <p>Dear Guardian,</p>
                    <p>Our real-time attendance tracking system has recorded an <b>Absence</b> for student <b>${studentName}</b> on <b>${date}</b>.</p>
                    
                    <div style="background: #fff1f2; border: 1px solid #fecaca; padding: 15px; border-radius: 10px; margin: 20px 0;">
                        <p style="margin: 0; color: #b91c1c; font-size: 14px; font-weight: bold;">
                            Status: Absent (Not in Campus)
                        </p>
                    </div>

                    <p style="font-size: 13px; color: #64748b;">
                        If this absence was not planned, please check your Parent App's HUD Hub for more details or contact the administration office.
                    </p>

                    <div style="text-align: center; margin-top: 30px;">
                        <a href="https://portal.bcsm.org.in/parent-dashboard.html" 
                           style="background: #6a1b9a; color: white; padding: 12px 25px; text-decoration: none; border-radius: 50px; font-size: 12px; font-weight: bold;">
                           VIEW HUD DASHBOARD
                        </a>
                    </div>
                </div>
                
                <p style="font-size: 10px; color: #94a3b8; text-align: center; margin-top: 20px;">
                    This is an automated neural link transmission. Authentication ID: ${Date.now()}
                </p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Absence telemetry alert sent to: ${to}`);
        return { success: true };
    } catch (error) {
        console.error("❌ Absence Alert Dispatch Failure:", error);
        return { success: false, error };
    }
};

module.exports = { 
    sendPaymentEmail, 
    sendEmailWithAttachment,
    sendManagerProvisionEmail,
    sendAbsentEmail
};