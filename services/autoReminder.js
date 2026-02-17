const cron = require('node-cron');
const { pool } = require('../database');
const { transporter } = require('./emailService'); // ✅ Standardized to match your actual filename
const moment = require('moment');

/**
 * INSTITUTIONAL AUTO-REMINDER ENGINE
 * Scheduled to trigger on the 2nd of every month at 09:00 AM
 */
const startAutoReminders = () => {
    // Cron Syntax: Minute Hour Day Month Day-of-Week
    cron.schedule('0 9 2 * *', async () => {
        console.log(`[${moment().format('YYYY-MM-DD HH:mm')}] 🤖 Monthly Auto-Reminder Engine Triggered...`);

        try {
            // 1. Fetch all students with outstanding balances from the registry
            const query = `
                SELECT s.student_id, u.username AS student_name, u.email,
                (SELECT SUM(total_amount - paid_amount) FROM student_invoices WHERE student_id = s.student_id AND status != 'Paid') as balance
                FROM students s
                JOIN users u ON s.user_id = u.id
                WHERE EXISTS (SELECT 1 FROM student_invoices WHERE student_id = s.student_id AND status != 'Paid')
            `;
            
            const { rows } = await pool.query(query);
            console.log(`Found ${rows.length} accounts with outstanding arrears.`);

            for (const student of rows) {
                if (!student.email || parseFloat(student.balance) <= 0) continue;

                const mailOptions = {
                    from: `"Finance Registry" <${process.env.EMAIL_USER}>`,
                    to: student.email,
                    subject: `Monthly Arrears Statement - ${student.student_name}`,
                    html: `
                        <div style="font-family: sans-serif; border: 1px solid #e2e8f0; padding: 25px; border-radius: 12px; max-width: 600px;">
                            <h2 style="color: #4f46e5;">Automated Payment Reminder</h2>
                            <p>Dear Parent/Guardian,</p>
                            <p>This is an automated monthly notification regarding the outstanding balance for <b>${student.student_name}</b>.</p>
                            <div style="background-color: #fff5f5; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ef4444;">
                                <p style="margin: 0; color: #991b1b; font-weight: bold;">Current Arrears: ₹${parseFloat(student.balance).toLocaleString('en-IN')}</p>
                            </div>
                            <p>Please clear these dues via the Academic Portal to ensure uninterrupted service.</p>
                            <a href="https://portal.bcsm.org.in" style="background-color: #4f46e5; color: white; padding: 12px 25px; text-decoration: none; border-radius: 50px; display: inline-block; font-weight: bold;">SYNC LEDGER & PAY NOW</a>
                            <hr style="border: 0; border-top: 1px solid #eee; margin: 30px 0;">
                            <p style="font-size: 10px; color: #64748b; text-align: center;">Institutional Telemetry Node | Automated Generation</p>
                        </div>
                    `
                };

                try {
                    await transporter.sendMail(mailOptions);
                    // Stamp the database so the UI shows they were notified today
                    await pool.query(`UPDATE students SET last_finance_reminder_sent = CURRENT_TIMESTAMP WHERE student_id = $1`, [student.student_id]);
                    console.log(`✅ Auto-Dispatch Successful: ${student.email}`);
                } catch (err) {
                    console.error(`❌ Auto-Dispatch Failed for ${student.email}:`, err.message);
                }
            }
            console.log(`[${moment().format('YYYY-MM-DD HH:mm')}] 🏁 Monthly Cycle Complete.`);
        } catch (error) {
            console.error("Critical Failure in Auto-Reminder Logic:", error.message);
        }
    });
};

module.exports = { startAutoReminders };