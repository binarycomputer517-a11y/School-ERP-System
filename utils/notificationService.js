const nodemailer = require('nodemailer');

/**
 * SMTP Transporter Configuration
 */
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT) || 587,
    secure: process.env.EMAIL_SECURE === 'true', 
    auth: {
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS 
    },
    debug: process.env.NODE_ENV === 'development',
    logger: process.env.NODE_ENV === 'development'
});

/**
 * FEATURE 1: Password Reset Email
 */
async function sendPasswordResetEmail(toEmail, resetLink) {
    if (!toEmail) return;
    
    const mailOptions = {
        from: `"BCSM Portal Admin" <${process.env.EMAIL_USER}>`, 
        to: toEmail,
        subject: 'Security Notification: Password Reset Request',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background-color: #003366; color: white; padding: 20px; text-align: center;">
                    <h1 style="margin: 0; font-size: 22px;">BCSM SCHOOL ERP</h1>
                </div>
                <div style="padding: 30px; color: #333;">
                    <h2>Reset Your Password</h2>
                    <p>Click the button below to set a new password. This link expires in 60 minutes.</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${resetLink}" style="background-color: #005A9C; color: white; padding: 14px 25px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Reset My Password</a>
                    </div>
                    <p style="font-size: 12px; color: #666;">If you didn't request this, please ignore this email.</p>
                </div>
            </div>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Reset email sent to: ${toEmail}`);
    } catch (error) {
        console.error(`🚨 Reset Email Error:`, error.message);
    }
}

/**
 * FEATURE 2: Registration Welcome Email
 */
async function sendRegistrationEmail(toEmail, studentName, username, loginUrl) {
    const mailOptions = {
        from: `"BCSM Admissions" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject: 'Welcome to BCSM School ERP - Registration Successful',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 12px; overflow: hidden;">
                <div style="background-color: #003366; color: white; padding: 20px; text-align: center;">
                    <h1 style="margin: 0; font-size: 20px;">Welcome to BCSM!</h1>
                </div>
                <div style="padding: 30px; color: #333;">
                    <h2>Hello ${studentName},</h2>
                    <p>Your registration is successful. Use the credentials below to access your portal.</p>
                    <div style="background-color: #f4f4f4; padding: 15px; border-radius: 8px;">
                        <p><strong>Username:</strong> ${username}</p>
                        <p><strong>Login Portal:</strong> <a href="${loginUrl}">${loginUrl}</a></p>
                    </div>
                    <p>Happy Learning!</p>
                </div>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Welcome email sent to: ${toEmail}`);
    } catch (error) {
        console.error(`🚨 Registration Email Error:`, error.message);
    }
}

/**
 * FEATURE 3: Payment Confirmation Email
 */
async function sendPaymentEmail(toEmail, studentName, amount, txnId) {
    const mailOptions = {
        from: `"BCSM Accounts" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject: 'Fee Payment Received - Confirmation',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 12px;">
                <div style="background-color: #22c55e; color: white; padding: 20px; text-align: center;">
                    <h2 style="margin:0;">Payment Successful</h2>
                </div>
                <div style="padding: 30px;">
                    <p>Dear <strong>${studentName}</strong>,</p>
                    <p>We have received your payment of <strong>₹${amount}</strong>.</p>
                    <p><strong>Transaction ID:</strong> ${txnId}</p>
                    <p>You can download the official receipt from your dashboard.</p>
                </div>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Payment confirmation sent to: ${toEmail}`);
    } catch (error) {
        console.error(`🚨 Payment Email Error:`, error.message);
    }
}

/**
 * FEATURE 4: Reports with Attachments (PDF/Excel)
 */
async function sendEmailWithAttachment({ to, subject, html, attachments }) {
    const mailOptions = {
        from: `"BCSM Reports" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        html,
        attachments // Expects array: [{ filename: 'Report.pdf', path: '/path/to/file' }]
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Report email with attachment sent to: ${to}`);
    } catch (error) {
        console.error(`🚨 Attachment Email Error:`, error.message);
    }
}

/**
 * FEATURE 5: Attendance Absence Alert
 */
async function sendAbsentEmail(toEmail, studentName, attendanceDate) {
    if (!toEmail) return;

    const mailOptions = {
        from: `"BCSM Attendance" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject: `Absence Alert: ${studentName}`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #fee2e2; border-radius: 12px; overflow: hidden;">
                <div style="background-color: #dc2626; color: white; padding: 20px; text-align: center;">
                    <h1 style="margin: 0; font-size: 20px;">Attendance Notification</h1>
                </div>
                <div style="padding: 30px; color: #333; line-height: 1.6;">
                    <h2>Dear Parent,</h2>
                    <p>This is an automated alert to inform you that your child, <strong>${studentName}</strong>, has been marked <span style="color: #dc2626; font-weight: bold;">ABSENT</span> today.</p>
                    
                    <div style="background-color: #f9fafb; padding: 15px; border-radius: 8px; border: 1px solid #e5e7eb; margin: 20px 0;">
                        <p style="margin: 0;"><strong>Date:</strong> ${attendanceDate}</p>
                        <p style="margin: 0;"><strong>Status:</strong> Not Present in Roster</p>
                    </div>

                    <p>If you believe this is a mistake or if the absence was unplanned, please contact the school office as soon as possible.</p>
                    <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;">
                    <p style="font-size: 12px; color: #666; text-align: center;">This is a system-generated email from BCSM School ERP Portal.</p>
                </div>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Absence alert sent to: ${toEmail} for student: ${studentName}`);
    } catch (error) {
        console.error(`🚨 Absence Email Error:`, error.message);
    }
}

/**
 * FEATURE 6: Leave Status Notification
 */
async function sendLeaveStatusEmail(toEmail, employeeName, leaveType, startDate, status, reason = "") {
    if (!toEmail) return;

    const isApproved = status === 'Approved';
    const statusColor = isApproved ? '#166534' : '#991b1b';
    const statusBg = isApproved ? '#dcfce7' : '#fee2e2';

    const mailOptions = {
        from: `"BCSM HR Department" <${process.env.EMAIL_USER}>`,
        to: toEmail,
        subject: `Leave Application ${status}: ${employeeName}`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background-color: #1e293b; color: white; padding: 20px; text-align: center;">
                    <h1 style="margin: 0; font-size: 20px;">Leave Management System</h1>
                </div>
                <div style="padding: 30px; color: #333; line-height: 1.6;">
                    <h2>Hello ${employeeName},</h2>
                    <p>Your leave application for <strong>${leaveType}</strong> starting from <strong>${startDate}</strong> has been processed.</p>
                    
                    <div style="background-color: ${statusBg}; color: ${statusColor}; padding: 15px; border-radius: 8px; text-align: center; font-weight: bold; margin: 20px 0; border: 1px solid ${statusColor};">
                        STATUS: ${status.toUpperCase()}
                    </div>

                    ${!isApproved && reason ? `<p><strong>Reason for Rejection:</strong> ${reason}</p>` : ''}

                    <p>You can check your updated leave balance in the employee portal.</p>
                    <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;">
                    <p style="font-size: 12px; color: #666; text-align: center;">BCSM School ERP - Digital HR Cell</p>
                </div>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Leave status email sent to: ${toEmail} [${status}]`);
    } catch (error) {
        console.error(`🚨 Leave Email Error:`, error.message);
    }
}

module.exports = { 
    sendPasswordResetEmail, 
    sendRegistrationEmail, 
    sendPaymentEmail, 
    sendEmailWithAttachment,
    sendAbsentEmail,
    sendLeaveStatusEmail
};