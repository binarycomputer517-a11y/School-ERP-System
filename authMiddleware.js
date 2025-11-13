const jwt = require('jsonwebtoken');

/**
 * Middleware to verify the JWT from the Authorization header or the URL query string.
 * This version separates the INTEGER user ID from the UUID reference ID.
 */
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    let token = authHeader && authHeader.split(' ')[1];

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
        
        // --- FINAL FIXES FOR HYBRID ID SCHEMA ---

        // 1. Determine the core integer user ID (used for the 'users' table FK)
        const coreUserId = user.id; // Assume the primary JWT field is the INTEGER users.id

        // 2. Determine the profile-specific reference ID (UUID, used for Students/Teachers tables)
        const profileReferenceId = user.reference_id || user.student_id || user.teacher_id || null; 
        
        // 3. Process coreUserId to ensure it is always an INTEGER number if present.
        let processedUserId;
        if (coreUserId && !isNaN(coreUserId)) {
            processedUserId = parseInt(coreUserId, 10); 
        } else {
             // If ID is missing or non-numeric (e.g., in a flawed token), treat it as an error
             console.error('JWT payload is missing a valid numeric user ID (users.id).');
             return res.status(403).json({ message: 'Forbidden: Token payload structure is invalid.' });
        }
        
        // 4. Attach BOTH IDs to the request object.
        req.user = {
            // This is the core ID linked to the 'users' table (INTEGER)
            userId: processedUserId, 
            
            // This is the profile-specific ID linked to Students/Teachers tables (UUID or INTEGER profile PK)
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