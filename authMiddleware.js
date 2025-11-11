const jwt = require('jsonwebtoken');

/**
 * Middleware to verify the JWT from the Authorization header or the URL query string.
 */
function authenticateToken(req, res, next) {
    // 1. Check the Authorization Header first (Standard API Calls)
    const authHeader = req.headers['authorization'];
    let token = authHeader && authHeader.split(' ')[1];

    // 2. If token is not in the header, check the URL query string (for file downloads)
    if (!token && req.query.token) {
        token = req.query.token;
    }

    if (token == null) {
        return res.sendStatus(401); 
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.sendStatus(403); 
        }

        // --- CRITICAL FIXES FOR INTEGER ID DATABASE ---
        
        // 1. Safely retrieve the ID from the token payload.
        const rawUserId = user.id || user.reference_id;
        
        // 2. Convert ID to an integer if it's a small number, as indicated by your DB schema (ID 1, 2, 5).
        // This ensures compatibility if your database columns (like created_by, user_id) are integers.
        let userIdFromToken;
        if (rawUserId && !isNaN(rawUserId)) {
            // Use parseInt to convert string '1' to number 1
            userIdFromToken = parseInt(rawUserId, 10); 
        } else {
            // Keep it as a string (UUID) if it looks like one.
            userIdFromToken = rawUserId; 
        }
        
        // --- END CRITICAL FIXES ---

        req.user = {
            // Assigning the processed ID to 'userId'
            userId: userIdFromToken, 
            role: user.role,     
            branch_id: user.branch_id 
        };

        // Safety check: Ensure an ID was actually found in the token payload
        if (!req.user.userId) {
            console.error('JWT token payload is missing a valid ID.');
            return res.status(403).json({ message: 'Forbidden: Invalid token payload structure.' });
        }
        
        next(); // Proceeds to the next middleware or route handler.
    });
}

/**
 * Middleware factory to authorize users based on roles.
 */
function authorize(roles = []) {
    if (typeof roles === 'string') {
        roles = [roles];
    }

    return (req, res, next) => {
        // req.user.role is correctly set to 'Admin' or 'Teacher' (string) by authenticateToken.
        if (!roles.length || roles.includes(req.user.role)) {
            // User has the required role, proceed.
            next();
        } else {
            // User does not have permission, deny access.
            return res.status(403).json({ message: 'Forbidden: You do not have permission to perform this action.' });
        }
    };
}

module.exports = {
    authenticateToken,
    authorize
};