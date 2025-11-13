const jwt = require('jsonwebtoken');

/**
 * Middleware to verify the JWT from the Authorization header or the URL query string.
 * This version safely extracts the INTEGER core user ID.
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

        // --- EXTRACTING INTEGER IDs ---

        const coreUserId = user.id; // Comes from users.id (Expected to be an INTEGER)
        
        // This is the profile-specific ID (UUID/Text) retrieved during login.
        const profileReferenceId = user.reference_id || null; 
        
        // FIX: Ensure coreUserId is cast to INTEGER to match the users.id column type.
        let processedUserId;
        if (coreUserId !== undefined && coreUserId !== null) {
            processedUserId = parseInt(coreUserId, 10); 
            
            // Critical Check: If parseInt results in NaN (Not a Number), the token payload is rejected.
            if (isNaN(processedUserId)) {
                 console.error('JWT payload contains non-numeric core user ID for INTEGER schema.');
                 return res.status(403).json({ message: 'Forbidden: Token payload structure is invalid.' });
            }
        } else {
             return res.status(403).json({ message: 'Forbidden: Token payload missing User ID.' });
        }
        
        // 4. Attach IDs to the request object.
        req.user = {
            // userId is the core ID linked to the 'users' table (INTEGER)
            userId: processedUserId, 
            
            // This is the profile-specific ID (UUID or Text) for profile tables
            referenceId: profileReferenceId, 
            
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