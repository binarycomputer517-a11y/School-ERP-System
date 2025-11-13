const jwt = require('jsonwebtoken');

/**
 * Middleware to verify the JWT from the Authorization header or the URL query string.
 * This version safely extracts the UUID core ID and the INTEGER reference ID.
 */
function authenticateToken(req, res, next) {
    // 1. Check the Authorization Header first (Standard API Calls)
    const authHeader = req.headers['authorization'];
    let token = authHeader && authHeader.split(' ')[1];

    // 2. If token is not in the header, check the URL query string (for file downloads/reports)
    if (!token && req.query.token) {
        token = req.query.token;
    }

    if (token == null) {
        // 401: Unauthorized - No token provided
        // This is where "Session expired or unauthorized" usually originates if no token is found.
        return res.sendStatus(401); 
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            // Token is invalid, expired, or malformed
            return res.sendStatus(403); // 403: Forbidden
        }
        
        // --- Core ID Extraction ---
        // user.id is the UUID from users.id (The actual primary key)
        const coreUUID = user.id; 
        
        // user.reference_id is the INTEGER from users.serial_id (The numeric ID)
        const referenceId = user.reference_id || null; 
        
        // Critical Check: Ensure the core UUID is present
        if (!coreUUID) {
             console.error('JWT payload missing core UUID.');
             return res.status(403).json({ message: 'Forbidden: Token payload missing core user ID (UUID).' });
        }
        
        // 4. Attach IDs to the request object.
        req.user = {
            // FIX: Pass the actual UUID from the token payload 'id'
            id: coreUUID, 
            
            // FIX: Pass the INTEGER reference ID as 'userId' for legacy/numeric use
            userId: referenceId, 
            
            role: user.role,     
            branch_id: user.branch_id 
        };

        next();
    });
}
// -------------------------------------------------------------------------------------------------

/**
 * Middleware factory to authorize users based on roles.
 */
function authorize(roles = []) {
    if (typeof roles === 'string') {
        roles = [roles];
    }

    return (req, res, next) => {
        // Ensure req.user.id (the UUID) or req.user.role exists.
        if (!req.user || !req.user.role) {
             return res.status(403).json({ message: 'Forbidden: Authentication failed during token verification.' });
        }

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