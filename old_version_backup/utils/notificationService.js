// utils/notificationService.js
const nodemailer = require('nodemailer');
// dotenv লোড হয়েছে ধরে নিচ্ছি

// ==========================================================
// ✅ চূড়ান্ত ফিক্স: EMAIL_HOST এবং EMAIL_PORT ব্যবহার করা হচ্ছে
// ==========================================================
const transporter = nodemailer.createTransport({
    // 🚨 FIX: SMTP_HOST এর পরিবর্তে EMAIL_HOST ব্যবহার করা হলো
    host: process.env.EMAIL_HOST,
    // 🚨 FIX: SMTP_PORT এর পরিবর্তে EMAIL_PORT ব্যবহার করা হলো
    port: process.env.EMAIL_PORT, 
    // NOTE: EMAIL_SECURE যদি 'true' হয় তবে এটি SSL/TLS চালু করবে
    secure: process.env.EMAIL_SECURE === 'true', 
    auth: {
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS 
    },
});

/**
 * পাসওয়ার্ড রিসেট লিঙ্ক সহ ইমেল পাঠায়
 * @param {string} toEmail - প্রাপকের ইমেল ঠিকানা
 * @param {string} resetLink - সম্পূর্ণ রিসেট URL
 */
async function sendPasswordResetEmail(toEmail, resetLink) {
    if (!toEmail) {
        console.warn('Skipping password reset email: Recipient email address is missing.');
        return; 
    }
    
    try {
        const mailOptions = {
            from: `"School ERP Admin" <${process.env.EMAIL_USER}>`, 
            to: toEmail,
            subject: 'Action Required: Password Reset for School ERP Account',
            html: `
                <p>Hello,</p>
                <p>We received a request to reset the password for your School ERP account. If you made this request, please click the secure link below:</p>
                
                <a href="${resetLink}" style="background-color: #005A9C; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px; display: inline-block; margin: 15px 0; font-weight: bold;">
                    Reset Your Password
                </a>
                
                <p style="font-size: 12px; color: #555;">This secure link is valid for **60 minutes**.</p>
                <p>If you did not request a password reset, you can safely ignore this email.</p>
                <br>
                <p>Regards,<br>School ERP System Administrator</p>
            `,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`Password reset email sent successfully to ${toEmail}. Message ID: ${info.messageId}`);

    } catch (error) {
        // এই ত্রুটিটি এখন প্রকৃত SMTP সমস্যা দেখাবে, লোকালহোস্ট সংযোগের ত্রুটি নয়।
        console.error(`🚨 CRITICAL ERROR: Failed to send password reset email to ${toEmail}. Check SMTP Configuration.`, error.message);
        throw new Error("Failed to send notification email. Please check server logs for SMTP errors."); 
    }
}

module.exports = { sendPasswordResetEmail };