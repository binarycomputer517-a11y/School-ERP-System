// /multerConfig.js (CORRECTED with Dynamic Destination)

const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Define specific directories relative to the project root
const UPLOADS_BASE_DIR = path.join(__dirname, 'uploads');
const TEACHERS_UPLOAD_DIR = path.join(UPLOADS_BASE_DIR, 'teachers');
const TRANSPORT_UPLOAD_DIR = path.join(UPLOADS_BASE_DIR, 'transport'); 
const DOCUMENTS_UPLOAD_DIR = path.join(UPLOADS_BASE_DIR, 'documents'); 

// --- 1. Dynamic Storage Configuration ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let destDir;
        
        // Dynamically set the destination based on the file field name
        if (file.fieldname === 'photo' || file.fieldname === 'license') {
            // Target: Vehicle Photos and Driver Licenses
            destDir = TRANSPORT_UPLOAD_DIR; 
        } else if (file.fieldname === 'document') {
            // Target: Vehicle Documents (Registration, Insurance, etc.)
            destDir = DOCUMENTS_UPLOAD_DIR; 
        } else {
            // Default target for teacher-related fields (teacher_photo, cv_file, etc.)
            destDir = TEACHERS_UPLOAD_DIR;
        }

        // Ensure the required directory exists
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        cb(null, destDir);
    },
    filename: (req, file, cb) => {
        const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        cb(null, Date.now() + '-' + sanitizedFilename);
    }
});

// --- 2. Configure Primary Upload Instance (Has .single() method) ---
const primaryUploadInstance = multer({ 
    storage: storage, 
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// --- 3. Configure .fields() Middleware (for existing teacher routes) ---
const uploadFilesMiddleware = primaryUploadInstance.fields([
    { name: 'teacher_photo', maxCount: 1 },
    { name: 'cv_file', maxCount: 1 },
    { name: 'degree_cert', maxCount: 1 },
    { name: 'experience_cert', maxCount: 1 }
]);

// --- 4. Export the specific components ---
module.exports = {
    uploadFiles: uploadFilesMiddleware,
    // CRITICAL: Export the base instance needed by req.app.get('upload')
    multerInstance: primaryUploadInstance 
};