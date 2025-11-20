const jwt = require('jsonwebtoken');

/**
 * Middleware to verify the JWT from the Authorization header or the URL query string.
 * This version extracts the UUID core ID and performs role normalization.
 */
function authenticateToken(req, res, next) {
    // 1. Check the Authorization Header first (Standard API Calls)
    const authHeader = req.headers['authorization'];
    let token = authHeader && authHeader.split(' ')[1];

    // 2. If token is not in the header, check the URL query string (for reports/downloads)
    if (!token && req.query.token) {
        token = req.query.token;
    }

    if (token == null) {
        // 401: Unauthorized - No token provided
        return res.sendStatus(401); 
    }

    // JWT_SECRET is accessed via environment variables, ensuring security
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            // Token is invalid, expired, or malformed
            return res.sendStatus(403); // 403: Forbidden
        }
        
        // user.id is the UUID from users.id (The actual primary key)
        const coreUUID = user.id; 
        
        // Critical Check: Ensure the core UUID is present
        if (!coreUUID) {
             console.error('JWT payload missing core UUID.');
             return res.status(403).json({ message: 'Forbidden: Token payload missing core user ID (UUID).' });
        }
        
        // --- FIX 1: ROLE NORMALIZATION ---
        // Convert the role to lowercase here. This makes authorization case-insensitive,
        // solving the common local vs. server 'Admin' vs. 'admin' problem.
        const userRole = user.role ? user.role.toLowerCase() : null; 
        
        // 4. Attach IDs and data to the request object.
        req.user = {
            // FIX: Primary UUID for database operations (e.g., attendance.marked_by)
            id: coreUUID, 
            
            // Secondary/Legacy ID (null if not in token, but kept for compatibility)
            userId: user.reference_id || null, 
            
            // The normalized (lowercase) role
            role: userRole,     
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

    // FIX 2: Convert the list of required roles to lowercase for comparison
    const allowedRoles = roles.map(r => r.toLowerCase());

    return (req, res, next) => {
        // Ensure user data and role exist (req.user.role is already lowercase)
        if (!req.user || !req.user.role) {
             return res.status(403).json({ message: 'Forbidden: Authentication failed during token verification.' });
        }

        // Check if the lowercase user role is included in the lowercase allowed list
        if (!allowedRoles.length || allowedRoles.includes(req.user.role)) {
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