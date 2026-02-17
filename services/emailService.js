/**
 * services/emailService.js
 * -----------------------------
 * Automated Institutional Student Onboarding Service.
 * Dispatches secure access credentials and synchronizes telemetry with the UUID registry.
 * Version: 2026.Enterprise
 */

const nodemailer = require('nodemailer');
const { pool } = require('../database'); // Database connection for telemetry logging

// 1. Setup secure institutional transporter using environment variables
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: process.env.EMAIL_SECURE === 'true', 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    // Enhanced security protocol for institutional networks
    tls: {
        rejectUnauthorized: false 
    }
});

/**
 * Helper: Logs email dispatch status into the centralized institutional registry.
 */
const logEmailTelemetry = async (email, subject, status, error = null, studentId = null) => {
    try {
        await pool.query(
            `INSERT INTO email_logs (recipient_email, subject, status, error_message, reference_id) 
             VALUES ($1, $2, $3, $4, $5)`,
            [email, subject, status, error, studentId]
        );
    } catch (err) {
        console.error("❌ Registry Telemetry Log Failure:", err.message);
    }
};

/**
 * FEATURE: Dispatches an official enrollment confirmation and credential payload.
 * @param {Object} studentData - Contains email, first_name, admission_id, raw_password, school_name, and student_id (UUID).
 */
const sendWelcomeEmail = async (studentData) => {
    const { email, first_name, admission_id, raw_password, school_name, student_id } = studentData;
    
    // Safety check: Prevent dispatch without a valid destination identifier
    if (!email) return;

    const subject = `Official Notification: Enrollment Confirmed - ${school_name}`;
    const mailOptions = {
        from: `"${school_name}" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: subject,
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    .email-container {
                        max-width: 600px;
                        margin: 0 auto;
                        font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
                        background-color: #ffffff;
                        border: 1px solid #e1e4e8;
                        border-radius: 4px;
                        color: #24292e;
                    }
                    .header {
                        background-color: #003366;
                        padding: 30px;
                        text-align: center;
                        color: #ffffff;
                        border-radius: 4px 4px 0 0;
                    }
                    .content {
                        padding: 40px;
                        line-height: 1.6;
                    }
                    .credentials-box {
                        background-color: #f6f8fa;
                        border: 1px solid #d1d5da;
                        padding: 20px;
                        margin: 25px 0;
                        border-radius: 6px;
                    }
                    .button {
                        display: inline-block;
                        padding: 12px 24px;
                        background-color: #003366;
                        color: #ffffff !important;
                        text-decoration: none;
                        border-radius: 4px;
                        font-weight: bold;
                        margin-top: 10px;
                    }
                    .footer {
                        padding: 20px;
                        font-size: 12px;
                        color: #6a737d;
                        text-align: center;
                        border-top: 1px solid #e1e4e8;
                    }
                </style>
            </head>
            <body style="background-color: #f4f4f4; padding: 20px;">
                <div class="email-container">
                    <div class="header">
                        <h1 style="margin: 0; font-size: 24px; letter-spacing: 1px;">${school_name.toUpperCase()}</h1>
                        <p style="margin: 5px 0 0 0; opacity: 0.8; font-size: 14px;">Official Admissions & Registry Office</p>
                    </div>
                    
                    <div class="content">
                        <p>Dear <strong>${first_name}</strong>,</p>
                        
                        <p>We are pleased to inform you that your registration at <strong>${school_name}</strong> has been successfully processed. You are now formally enrolled within our institutional management system.</p>
                        
                        <p>Your secure access credentials are provided below. Please use these to authenticate into the Academic Portal.</p>
                        
                        <div class="credentials-box">
                            <table role="presentation" width="100%">
                                <tr>
                                    <td style="padding: 5px 0;"><strong>Admission ID:</strong></td>
                                    <td><code>${admission_id}</code></td>
                                </tr>
                                <tr>
                                    <td style="padding: 5px 0;"><strong>Access Username:</strong></td>
                                    <td>${email}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 5px 0;"><strong>Temporary Secret:</strong></td>
                                    <td><strong style="color: #d73a49;">${raw_password}</strong></td>
                                </tr>
                            </table>
                        </div>

                        <p>To finalize your identity setup, please sign in to the portal and update your temporary password immediately for enhanced institutional security.</p>
                        
                        <a href="https://portal.bcsm.org.in/login" class="button">Access Academic HUD</a>

                        <p style="margin-top: 30px;">
                            Regards,<br>
                            <strong>Director of Admissions</strong><br>
                            ${school_name}
                        </p>
                    </div>
                    
                    <div class="footer">
                        &copy; 2026 ${school_name}. All rights reserved.<br>
                        This is an automated institutional notification. Integrity of transmission is monitored by the Telemetry Node.
                    </div>
                </div>
            </body>
            </html>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Institutional Welcome Email successfully dispatched to: ${email}`);
        
        // Synchronize success status to centralized telemetry registry
        await logEmailTelemetry(email, subject, 'Success', null, student_id);
    } catch (error) {
        console.error('❌ Institutional SMTP Synchronization Failure:', error.message);
        
        // Synchronize failure status to centralized telemetry registry for auditing
        await logEmailTelemetry(email, subject, 'Failed', error.message, student_id);
    }
};

// CRITICAL FIX: Exporting transporter so it can be accessed by other modules
module.exports = { 
    sendWelcomeEmail,
    transporter 
};