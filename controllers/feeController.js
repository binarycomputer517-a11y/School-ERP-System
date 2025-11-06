// feeController.js

exports.getStudentFees = async (req, res) => {
    const studentId = req.params.studentId;
    
    // SQL to fetch fee structure by joining students and fee_structures tables
    const sqlQuery = `
        SELECT
            fs.admission_fee, fs.registration_fee, fs.examination_fee,
            fs.has_transport, fs.transport_fee, fs.has_hostel, fs.hostel_fee,
            fs.structure_name
        FROM
            fee_structures fs
        JOIN
            students s ON fs.course_id = s.course_id AND fs.batch_id = s.batch_id
        WHERE
            s.id = $1;
    `;

    try {
        // **IMPORTANT**: Execute the query using your actual database client (db)
        const result = await db.query(sqlQuery, [studentId]);
        const rawStructure = result.rows[0]; 
        
        if (!rawStructure) {
            // Return 404 if the student or fee structure is not found
            return res.status(404).json({ message: "Fee structure not found for this student ID." });
        }
        
        // --- Data Transformation for Front-End ---
        let totalFees = 0;
        const breakdown = [];
        
        // Helper to process and format each fee head
        const mapFees = (name, amount, isOptional, isIncluded) => {
            // Only include non-zero amounts
            if (amount && amount > 0 && (!isOptional || isIncluded)) { 
                const feeAmount = parseFloat(amount);
                breakdown.push({
                    fee_head: name,
                    amount: feeAmount,
                    status: 'Pending', // Placeholder: Real status needs a separate 'payments' table join
                    due_date: 'N/A' // Placeholder
                });
                totalFees += feeAmount;
            }
        };

        mapFees('Admission Fee', rawStructure.admission_fee, false, true);
        mapFees('Registration Fee', rawStructure.registration_fee, false, true);
        mapFees('Examination Fee', rawStructure.examination_fee, false, true);
        
        // Handle optional fees (Transport and Hostel)
        mapFees('Transport Fee', rawStructure.transport_fee, true, rawStructure.has_transport);
        mapFees('Hostel Fee', rawStructure.hostel_fee, true, rawStructure.has_hostel);
        
        // --- Final Response Structure ---
        const feesPaid = 0.00; // Placeholder for actual paid amount calculation
        
        res.json({
            summary: {
                total_fees: totalFees,
                fees_paid: feesPaid,
                balance_due: totalFees - feesPaid
            },
            breakdown: breakdown
        });

    } catch (error) {
        console.error('Database or Processing Error fetching student fees:', error);
        res.status(500).json({ message: 'Internal server error while fetching fees.' });
    }
};