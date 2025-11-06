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

        // CRITICAL FIX: Ensure we prioritize the primary ID key used by the server (user.id or user.reference_id)
        const userIdFromToken = user.id || user.reference_id; 

        req.user = {
            // ⭐ FIXED: Assigning to 'userId' to match the routes/messaging.js requirement.
            userId: userIdFromToken, 
            role: user.role,     
            branch_id: user.branch_id 
        };

        // Safety check: Ensure an ID was actually found in the token payload
        if (!req.user.userId) { // Checking req.user.userId now
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
        // req.user is available because authenticateToken runs first.
        // NOTE: The role is read from req.user.role, which is correctly assigned above.
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