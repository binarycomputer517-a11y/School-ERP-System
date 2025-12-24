const nodemailer = require('nodemailer');

// Setup transporter using your .env credentials
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST, // smtp.gmail.com
    port: process.env.EMAIL_PORT, // 587
    secure: false, 
    auth: {
        user: process.env.EMAIL_USER, // schoolerp995@gmail.com
        pass: process.env.EMAIL_PASS  // sqpztuyqoivgasek
    }
});

/**
 * Sends a professional fee payment confirmation email
 */
const sendPaymentEmail = async (to, studentName, amount, txnId) => {
    const mailOptions = {
        from: `"School ERP Finance" <${process.env.EMAIL_USER}>`,
        to: to,
        subject: 'Payment Confirmation - Fee Received',
        html: `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                <h2 style="color: #22c55e;">Payment Successful!</h2>
                <p>Dear ${studentName},</p>
                <p>We have successfully received your online fee payment of <b>₹${amount}</b>.</p>
                <p><b>Transaction ID:</b> ${txnId}</p>
                <p>Your student account has been updated automatically. You can download your official receipt from the dashboard.</p>
                <br>
                <p>Regards,<br><b>Accounts Department</b><br>School ERP System</p>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        return { success: true };
    } catch (error) {
        console.error("Email Sending Error:", error);
        return { success: false, error };
    }
};

module.exports = { sendPaymentEmail };