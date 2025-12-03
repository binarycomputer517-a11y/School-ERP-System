const jwt = require('jsonwebtoken');

// 1. IMPORT THE CENTRALIZED SECRET KEY
// This ensures that Login and Verify use the EXACT same key, preventing auto-logout.
const { secret } = require('./config/jwtSecret'); 

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

    // 3. VERIFY TOKEN USING THE CENTRAL SECRET
    // We use the imported 'secret' variable instead of process.env directly
    jwt.verify(token, secret, (err, user) => {
        if (err) {
            console.error("Token Verification Failed:", err.message);
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
        
        // --- ROLE NORMALIZATION ---
        // Convert the role to lowercase here. This makes authorization case-insensitive.
        const userRole = user.role ? user.role.toLowerCase() : null; 
        
        // 4. Attach IDs and data to the request object.
        req.user = {
            // Primary UUID for database operations
            id: coreUUID, 
            
            // Secondary/Legacy ID (null if not in token)
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

    // Convert the list of required roles to lowercase for comparison
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