const jwt = require('jsonwebtoken');

/**
 * Middleware to verify the JWT from the Authorization header or the URL query string.
 * This version uses the UUID from the users table as the core userId.
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
        return res.sendStatus(401); // 401: Unauthorized - No token provided
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            // Token is invalid, expired, or malformed
            return res.sendStatus(403); // 403: Forbidden
        }

        // --- EXTRACTING UUID IDs ---

        // coreUserId is the UUID string from the users table.
        const coreUserId = user.id; 
        
        // This is the profile-specific ID (UUID/Text) retrieved during login (e.g., student_id, teacher_id).
        const profileReferenceId = user.reference_id || null; 
        
        // Validation: Ensure the core ID exists
        if (!coreUserId) {
             console.error('JWT payload is missing the core user ID (UUID).');
             return res.status(403).json({ message: 'Forbidden: Token payload structure is invalid.' });
        }
        
        // 4. Attach BOTH IDs to the request object.
        req.user = {
            // userId is the core ID linked to the 'users' table (UUID string)
            userId: coreUserId, 
            
            // This is the profile-specific ID linked to Students/Teachers tables (UUID or Text)
            referenceId: profileReferenceId, 
            
            role: user.role,     
            branch_id: user.branch_id 
        };

        next();
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
        // req.user.role is set by authenticateToken.
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