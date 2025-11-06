// routes/server-students.js (This is the file Node.js should execute)

const express = require('express');
const router = express.Router();
// You would also require your database connection here
// const db = require('../config/database'); 

// Middleware to check authentication on the server
function verifyToken(req, res, next) {
    // Get token from the Authorization header (e.g., Bearer <token>)
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ message: 'Authentication required' });
    }
    const token = authHeader.split(' ')[1];
    
    // ---
    // TO DO: Implement JWT verification logic here
    // If verification is successful, attach user info to req.user
    // If verification fails: return res.status(403).json({ message: 'Invalid token' });
    // ---
    
    // For now, bypass if a token exists (INSECURE, implement JWT logic)
    next();
}

// POST endpoint for enrolling a student (matching the client-side fetch call)
router.post('/students', verifyToken, async (req, res) => {
    // This is where you insert the student data into your database
    const studentData = req.body;

    if (!studentData.roll_number || !studentData.first_name || !studentData.course_code) {
        return res.status(400).json({ message: 'Missing required fields.' });
    }

    try {
        // Example: await db.insertStudent(studentData);
        // Successful enrollment response
        res.status(200).json({ 
            message: 'Student enrolled successfully!', 
            student: { roll_number: studentData.roll_number } 
        });
    } catch (error) {
        console.error('Database error during enrollment:', error);
        res.status(500).json({ message: 'Internal server error during enrollment.' });
    }
});

module.exports = router;