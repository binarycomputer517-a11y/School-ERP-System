const nodemailer = require('nodemailer');

// 1. Setup transporter using .env credentials
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: process.env.EMAIL_PORT || 587,
    secure: false, // true for 465, false for other ports
    auth: {
        user: process.env.EMAIL_USER, // schoolerp995@gmail.com
        pass: process.env.EMAIL_PASS  // sqpztuyqoivgasek (App Password)
    }
});

/**
 * FEATURE 1: Sends a professional fee payment confirmation email
 * Triggered after successful online/manual payment
 */
const sendPaymentEmail = async (to, studentName, amount, txnId) => {
    const mailOptions = {
        from: `"School ERP Finance" <${process.env.EMAIL_USER}>`,
        to: to,
        subject: 'Payment Confirmation - Fee Received',
        html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px; max-width: 600px;">
                <h2 style="color: #22c55e;">Payment Successful!</h2>
                <p>Dear <b>${studentName}</b>,</p>
                <p>We have successfully received your fee payment of <b>₹${amount}</b>.</p>
                <p><b>Transaction ID:</b> <span style="color: #4f46e5;">${txnId}</span></p>
                <p>Your student account has been updated. You can view or download your official receipt from your student portal.</p>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                <p style="font-size: 12px; color: #666;">Regards,<br><b>Accounts Department</b><br>School ERP System</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Payment Email sent to: ${to}`);
        return { success: true };
    } catch (error) {
        console.error("❌ Payment Email Sending Error:", error);
        return { success: false, error };
    }
};

/**
 * FEATURE 2: Sends an email with an attachment (Excel/PDF)
 * Used by Daily Report Automation & PDF Receipt System
 */
const sendEmailWithAttachment = async ({ to, subject, html, attachments }) => {
    const mailOptions = {
        from: `"School ERP Reports" <${process.env.EMAIL_USER}>`,
        to: to,
        subject: subject,
        html: html,
        attachments: attachments // Format: [{ filename: 'name.xlsx', content: buffer }]
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Report Email with attachment sent to: ${to}`);
        return { success: true };
    } catch (error) {
        console.error("❌ Attachment Email Error:", error);
        return { success: false, error };
    }
};

module.exports = { 
    sendPaymentEmail, 
    sendEmailWithAttachment 
};