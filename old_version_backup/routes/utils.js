// routes/utils.js

const express = require('express');
const router = express.Router();
const { authenticateToken, authorize } = require('../authMiddleware'); 
// Assuming pool is needed for other utility checks

// Roles allowed to run health checks
const HEALTH_CHECK_ROLES = ['Admin', 'Super Admin', 'Staff'];

// =========================================================
// 1. DELIVERY CHANNEL HEALTH CHECK (GET)
// =========================================================
/**
 * @route   GET /api/utils/delivery-health
 * @desc    Checks the simulated operational status of external services (SMS, Email).
 * @access  Private (Admin, Staff, Super Admin)
 */
router.get('/delivery-health', authenticateToken, authorize(HEALTH_CHECK_ROLES), async (req, res) => {
    // --- SIMULATED CHECK LOGIC ---
    // In a real application, you would connect to the actual SMS/Email APIs here.
    
    // For now, we simulate a possible status:
    const healthStatus = {
        timestamp: new Date().toISOString(),
        sms: Math.random() > 0.1 ? 'OK' : 'Degraded', // 90% chance of OK
        email: Math.random() > 0.05 ? 'OK' : 'Degraded', // 95% chance of OK
        in_app: 'OK' // Always OK if server is running
    };

    res.status(200).json({
        sms: healthStatus.sms,
        email: healthStatus.email,
        in_app: healthStatus.in_app,
        timestamp: healthStatus.timestamp
    });
});

module.exports = router;