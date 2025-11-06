// routes/compliance.js

const express = require('express');
const router = express.Router();
const { pool } = require('../database'); // Ensure this path is correct

// --- GET /api/compliance/risk_score ---
// Fetches a calculated risk score based on compliance events.
router.get('/risk_score', async (req, res) => {
    console.log("Received request for /api/compliance/risk_score"); // Add logging
    try {
        /* * Risk Calculation Logic:
         * This example calculates risk based on the number of 'FAILURE' events.
         * Adjust this query based on your specific compliance metrics.
        */
        
        const riskQuery = `
            SELECT COUNT(*) 
            FROM compliance_event_log 
            WHERE status = 'FAILURE'; 
        `; // Ensure table and column names are correct
        
        console.log("Executing risk query:", riskQuery); // Log the query
        const result = await pool.query(riskQuery);
        console.log("Query result:", result.rows); // Log the result

        // Check if rows were returned before accessing count
        if (result.rows && result.rows.length > 0) {
            const highRiskCount = parseInt(result.rows[0].count, 10);

            let riskLevel = 'LOW'; // Default risk level

            // Define risk thresholds (adjust as needed)
            if (highRiskCount > 20) {
                riskLevel = 'HIGH';
            } else if (highRiskCount > 5) {
                riskLevel = 'MEDIUM';
            }

            // Send the JSON response expected by manage-compliance.js
            res.json({ 
                overall_risk: riskLevel,
                failed_events_count: highRiskCount 
            });
        } else {
            // Handle case where query returns no rows (though COUNT(*) should always return one)
             console.error('Risk query returned no rows.');
             res.status(500).json({ message: 'Error processing risk score data.' });
        }

    } catch (err) {
        // Log the specific database error for debugging
        console.error('Error executing risk score query:', err); 
        res.status(500).json({ message: 'Server error fetching risk score.' });
    }
});

// --- Future Endpoints ---
/* * Add other compliance-related endpoints here, such as:
 * POST /api/compliance/unmask_data
 * GET /api/compliance/audit_logs 
 * etc.
*/

// --- Placeholder for Unmask Data Endpoint ---
router.post('/unmask_data', async (req, res) => {
    // ⚠️ TODO: Implement secure MFA verification and data fetching logic here
    console.log("Received unmask request:", req.body);
    // 1. Verify primary token (already done by middleware)
    // 2. Verify MFA token (req.body.mfaToken) against user's MFA setup
    // 3. Log the unmasking attempt/success in compliance_event_log
    // 4. Fetch the actual sensitive data from PostgreSQL based on req.body.recordId
    // 5. Return the sensitive data in the expected format: { sensitiveData: { field_id: value, ... } }
    
    // Placeholder response - REPLACE THIS
    if (req.body.mfaToken === '123456') { // Mock check - DO NOT USE IN PRODUCTION
         res.json({
             sensitiveData: {
                 patient_name: "প্রকৃত নাম (সার্ভার থেকে)", // Replace with actual data
                 ssn: "XXX-XX-প্রকৃত নম্বর"          // Replace with actual data
             }
         });
    } else {
         res.status(401).json({ message: "MFA কোডটি ভুল বা মেয়াদোত্তীর্ণ।" });
    }
});


module.exports = router;