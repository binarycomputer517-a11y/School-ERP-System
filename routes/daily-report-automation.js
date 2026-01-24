const ExcelJS = require('exceljs');
const cron = require('node-cron');

// ✅ FIXED PATHS: Added '../' to go up one level to the root directory
const { pool } = require('../database'); 
const { sendEmailWithAttachment } = require('../utils/mailer'); 

/**
 * Function to generate a detailed Excel report per branch and email it to the Super Admin.
 */
async function generateAndSendDailyReport() {
    console.log('📊 [System] Starting Daily Report Automation...');
    
    try {
        // 1. Fetch the list of all active branches
        const branches = await pool.query('SELECT id, branch_name FROM branches');

        for (const branch of branches.rows) {
            const { id: branchId, branch_name: branchName } = branch;

            // 2. Fetch today's transaction details using JOINs
            const transactionDetails = await pool.query(`
                SELECT 
                    p.transaction_id, u.username as student_name, s.roll_number,
                    p.amount, p.payment_mode, TO_CHAR(p.payment_date, 'HH12:MI AM') as pay_time,
                    i.invoice_number
                FROM fee_payments p
                JOIN student_invoices i ON p.invoice_id = i.id
                JOIN students s ON i.student_id = s.student_id
                JOIN users u ON s.user_id = u.id
                WHERE i.branch_id = $1 AND p.payment_date::date = CURRENT_DATE
                ORDER BY p.payment_date ASC
            `, [branchId]);

            // Skip if no transactions occurred in this branch today
            if (transactionDetails.rowCount === 0) {
                console.log(`ℹ️ No transactions today for branch: ${branchName}`);
                continue;
            }

            // 3. Create Excel Workbook and Worksheet
            const workbook = new ExcelJS.Workbook();
            const sheet = workbook.addWorksheet('Daily Transactions');

            // Define Excel Column Headers
            sheet.columns = [
                { header: 'Time', key: 'pay_time', width: 15 },
                { header: 'Student Name', key: 'student_name', width: 25 },
                { header: 'Roll Number', key: 'roll_number', width: 15 },
                { header: 'Invoice No', key: 'invoice_number', width: 20 },
                { header: 'Payment Mode', key: 'payment_mode', width: 15 },
                { header: 'Transaction ID', key: 'transaction_id', width: 25 },
                { header: 'Amount (INR)', key: 'amount', width: 15 }
            ];

            // Add Data Rows
            transactionDetails.rows.forEach(row => sheet.addRow(row));

            // Style Header Row (Bold)
            sheet.getRow(1).font = { bold: true };

            // Generate Buffer from Workbook
            const buffer = await workbook.xlsx.writeBuffer();

            // 4. Send Email to Super Admin with the Attachment
            await sendEmailWithAttachment({
                to: 'casudam1989@gmail.com', 
                subject: `📊 Daily Summary - ${branchName} (${new Date().toLocaleDateString()})`,
                html: `<h3>Daily Transaction Report for ${branchName}</h3>
                       <p>Total Transactions: <b>${transactionDetails.rowCount}</b></p>
                       <p>Please find the detailed Excel report attached below.</p>`,
                attachments: [
                    {
                        filename: `Report_${branchName}_${new Date().toISOString().split('T')[0]}.xlsx`,
                        content: buffer
                    }
                ]
            });
            console.log(`✅ Report sent successfully for: ${branchName}`);
        }
    } catch (err) {
        console.error('❌ Automation Error:', err);
    }
}

// 5. Setup Cron Job (Runs every day at 21:00 / 9:00 PM)
cron.schedule('0 21 * * *', () => {
    generateAndSendDailyReport();
});

module.exports = { generateAndSendDailyReport };