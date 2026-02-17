// routes/feesRouter.js

const express = require('express');
const router = express.Router();
// IMPORTANT: Adjust the path if your controller directory is structured differently
const feeController = require('../controllers/feeController'); 
const { authenticateToken, authorize } = require('../authMiddleware'); 

// Constants (Define roles that can view/manage fees)
const FEE_MANAGEMENT_ROLES = ['Admin', 'Super Admin', 'Staff', 'Student', 'Parent'];

/**
 * @route   GET /api/fees/:studentId
 * @desc    Get the fee structure and summary for a single student.
 * @access  Private (Staff, Admin, or Student/Parent)
 */
router.get(
    '/:studentId', 
    authenticateToken, 
    authorize(FEE_MANAGEMENT_ROLES),
    feeController.getStudentFees
);

// --- ADDED TO FIX THE 404 FROM OTHER FILES (If they still use the old path) ---
/**
 * @route   GET /api/fees/student/:studentId
 * @desc    Alias route for fees for specific front-end implementations.
 * @access  Private 
 */
router.get(
    '/student/:studentId', 
    authenticateToken, 
    authorize(FEE_MANAGEMENT_ROLES),
    feeController.getStudentFees // Uses the same controller logic
);
// ------------------------------------------------------------------------------

module.exports = router;