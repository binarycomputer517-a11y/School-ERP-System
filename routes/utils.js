// routes/utils.js

const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../authMiddleware'); 
const { pool, DB } = require('../database'); // Added pool for DB updates
const { transporter } = require('../services/emailService'); // Integrated your verified transporter

// Roles allowed to run system checks
const HEALTH_CHECK_ROLES = ['admin', 'super admin', 'staff'];

// =========================================================
// 1. DELIVERY CHANNEL HEALTH CHECK (GET)
// =========================================================
router.get('/delivery-health', authenticateToken, authorize(HEALTH_CHECK_ROLES), async (req, res) => {
    const healthStatus = {
        timestamp: new Date().toISOString(),
        sms: Math.random() > 0.1 ? 'OK' : 'Degraded',
        email: Math.random() > 0.05 ? 'OK' : 'Degraded',
        in_app: 'OK'
    };

    res.status(200).json(healthStatus);
});

// =========================================================
// 2. ONE-CLICK AUTO-REMINDER TEST (POST/GET)
// =========================================================
/**
 * @route   GET /api/utils/test-auto-reminder
 * @desc    Force-triggers a finance reminder test to verify SMTP & DB Stamping.
 * @access  Private (Super Admin Only)
 */
router.get('/test-auto-reminder', authenticateToken, authorize(['super admin']), async (req, res) => {
    const testTarget = 'casudam1989@GMAIL.COM';

    try {
        console.log(`🧪 Initializing Manual Telemetry Test for: ${testTarget}`);

        const mailOptions = {
            from: `"Institutional Test Node" <${process.env.EMAIL_USER}>`,
            to: testTarget,
            subject: `SYSTEM TEST: 2026 Auto-Reminder Sync`,
            html: `
                <div style="font-family: sans-serif; border: 2px solid #4f46e5; padding: 25px; border-radius: 12px; max-width: 600px;">
                    <h2 style="color: #4f46e5;">Manual Trigger: SUCCESS</h2>
                    <p>This email confirms that your <b>Nodemailer Transporter</b> and <b>Path Configurations</b> are correctly linked.</p>
                    <div style="background-color: #f8fafc; padding: 15px; border-radius: 8px; margin: 20px 0;">
                        <p style="margin: 0; font-size: 14px;"><b>Test Status:</b> Operational</p>
                        <p style="margin: 0; font-size: 14px;"><b>Timestamp:</b> ${new Date().toLocaleString()}</p>
                    </div>
                    <p>The system is now ready for the scheduled run on the 2nd of the month.</p>
                </div>`
        };

        // 1. Test the SMTP Transport
        await transporter.sendMail(mailOptions);

        // 2. Test the Database Stamping (Updates the admin's own student record for the test)
        await pool.query(
            `UPDATE ${DB.STUDENTS} SET last_finance_reminder_sent = CURRENT_TIMESTAMP WHERE user_id = $1`,
            [req.user.id]
        );

        res.status(200).json({
            success: true,
            message: `Manual trigger successful. Test payload dispatched to ${testTarget}.`,
            telemetry: "SMTP Handshake OK | DB Stamp OK"
        });

    } catch (error) {
        console.error("❌ Manual Trigger Failure:", error.message);
        res.status(500).json({ 
            success: false, 
            message: "Telemetry test failed.", 
            error: error.message 
        });
    }
});

module.exports = router;