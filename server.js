// /server.js
// A modular Express server for a Student Management System (SMS)

// ===================================
// 1. IMPORTS & INITIALIZATION
// ===================================
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config(); 

// --- Custom Modules & Configuration ---
const { initializeDatabase } = require('./database');
const { startNotificationService } = require('./notificationService');
// *** CRITICAL FIX: Destructure the correct key 'multerInstance' ***
const { multerInstance } = require('./multerConfig'); 
const { authenticateToken } = require('./authMiddleware'); // JWT Middleware

// --- Constants & Setup ---
// Define specific upload paths used by the routes (kept for startup checks)
const TEACHERS_UPLOAD_DIR = path.join(__dirname, 'uploads', 'teachers'); 
const TRANSPORT_UPLOAD_DIR = path.join(__dirname, 'uploads', 'transport'); 
const DOCUMENTS_UPLOAD_DIR = path.join(__dirname, 'uploads', 'documents'); 
const MEDIA_UPLOAD_DIR = path.join(__dirname, 'uploads', 'media'); 

const app = express();
const port = process.env.PORT || 3005;

// ===================================
// 2. CORE MIDDLEWARE
// ===================================
app.use(cors());
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf.toString();
    }
}));
app.use(express.urlencoded({ extended: true }));

// Serve static files (client assets) and uploads
app.use(express.static(path.join(__dirname, 'public')));
// The /uploads static route is crucial for accessing all uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// CRITICAL FIX: Attach the initialized BASE Multer instance to the app object.
app.set('upload', multerInstance); // <-- Uses the correctly imported 'multerInstance'

// ===================================
// 3. API ROUTE DEFINITIONS
// ===================================

// --- Import Route Modules ---
const authRoutes = require('./routes/auth');
const studentsRoutes = require('./routes/students');
const examsRouter = require('./routes/exams'); 
const userRoutes = require('./routes/users');
const timetableRoutes = require('./routes/timetable');
const marksRoutes = require('./routes/marks');
const academicsWithFeesRouter = require('./routes/academicswithfees');
const teachersRoutes = require('./routes/teachers'); 
const attendanceRouter = require('./routes/attendance'); 
const noticesRouter = require('./routes/notices'); 
const transportRouter = require('./routes/transport'); // Uses req.app.get('upload')
const payrollRouter = require('./routes/payroll');
const libraryRouter = require('./routes/library');
const feesRoutes = require('./routes/fees');
const subjectsRouter = require('./routes/subjects');
const activitiesRouter = require('./routes/clubsEvents'); 
const onlineLearningRouter = require('./routes/onlineLearning');
const onlineExamRoutes = require('./routes/onlineExam'); 
const leaveRouter = require('./routes/leave'); 
const announcementRoutes = require('./routes/announcements');
const certificatesRouter = require('./routes/certificates');
const complianceRoutes = require('./routes/compliance');
const sectionsRoutes = require('./routes/sections');
const admissionRouter = require('./routes/admission');
const coursesRouter = require('./routes/courses'); 
// --- FIX: IMPORT THE ENQUIRIES ROUTER ---
const enquiriesRouter = require('./routes/enquiries');
const assignmentsRouter = require('./routes/assignments'); 
const staffhrRouter = require('./routes/staffhr');
const messagingRouter = require('./routes/messaging');
const cafeteriaRouter = require('./routes/cafeteria');
const ptmRoutes = require('./routes/ptm');
const dashboardRoutes = require('./routes/dashboard');
const reportCardRouter = require('./routes/reportcard');
const disciplineRouter = require('./routes/discipline');
const settingsRoutes = require('./routes/settings');
const hostelRouter = require('./routes/hostel'); 
const erpInventoryAssetRouter = require('./routes/inventory-with-assets'); 
const departmentRoutes = require('./routes/hr/departments');
const mediaRouter = require('./routes/media');
// VMS Routes (Needs a separate import if not already done, assuming it's called vmsRouter)
const vmsRouter = require('./routes/vms');
const alumniRouter = require('./routes/alumni'); // Import the alumni router


// --- PUBLIC API ROUTES (NO AUTH REQUIRED) ---
// Login, Register, Forgot Password Reset (Public routes for authentication)
app.use('/api/auth', authRoutes); 
app.use('/api/dashboard', dashboardRoutes); 

// --- FIX: VMS ROUTES MUST BE PUBLIC ---
// Host lookup and Visitor check-in must be mounted before authenticateToken.
app.use('/api/users', userRoutes); 
app.use('/api/vms', vmsRouter); 


// --- PROTECTED API ROUTES (JWT AUTH REQUIRED) ---
app.use('/api', authenticateToken); 

// All routes mounted here require a valid token
app.use('/api/students', studentsRoutes);
// NOTE: userRoutes is already mounted above, but protected endpoints within it 
// must use authenticateToken internally.
app.use('/api/timetable', timetableRoutes);
app.use('/api/marks', marksRoutes);
app.use('/api/academicswithfees', academicsWithFeesRouter);
app.use('/api/teachers', teachersRoutes); 
app.use('/api/attendance', attendanceRouter); 
app.use('/api/exams', examsRouter);
app.use('/api/notices', noticesRouter); 
app.use('/api/transport', transportRouter); 
app.use('/api/payroll', payrollRouter); 
app.use('/api/admission', admissionRouter); 
app.use('/api/discipline', disciplineRouter);
app.use('/api/cafeteria', cafeteriaRouter);
app.use('/api/messaging', messagingRouter);
app.use('/api/library', libraryRouter);
app.use('/api/staffhr', staffhrRouter);
app.use('/api/fees', feesRoutes);
app.use('/api/subjects', subjectsRouter);
app.use('/api/ptm', ptmRoutes);
app.use('/api/hostel', hostelRouter); 
app.use('/api/settings', settingsRoutes);
app.use('/api/assignments', assignmentsRouter); 
app.use('/api/report-card', reportCardRouter);
app.use('/api/online-exam', onlineExamRoutes);
app.use('/api/courses', coursesRouter); 
app.use('/api/activities', activitiesRouter); 
app.use('/api/online-learning', onlineLearningRouter); 
app.use('/api/leave', leaveRouter); 
app.use('/api/announcements', announcementRoutes);
app.use('/api/certificates', certificatesRouter); 
app.use('/api/compliance', complianceRoutes);
app.use('/api/sections', sectionsRoutes); 
app.use('/api', erpInventoryAssetRouter); 
// --- FIX: MOUNT THE ENQUIRIES ROUTER ---
app.use('/api/enquiries', enquiriesRouter);
app.use('/api/hr/departments', departmentRoutes);
app.use('/api/fees', require('./routes/fees'));
app.use('/api/media', mediaRouter);
// --- NEW FIX: MOUNT THE ALUMNI ROUTER to fix the 404 error ---
app.use('/api/alumni', alumniRouter); // Mount the alumni router at /api/alumni 

// ===================================
// 4. PAGE SERVING & SPA ROUTING 
// ===================================
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/exam-management.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'exam-management.html'));
});

// Catch-all route for Single Page Application (SPA) support.
app.use((req, res, next) => {
    const url = req.originalUrl;
    
    // 1. 404 for unmatched API calls
    if (url.startsWith('/api')) {
        return res.status(404).json({ message: "API Endpoint not found." });
    }
    
    // 2. Check for file extensions (like .css, .js, .png) that the static
    //    middleware failed to find.
    if (url.includes('.') && !url.endsWith('.html')) {
        console.warn('404: Static asset not found by middleware: %s', url);
        return res.status(404).send("Static file not found: " + url);
    }

    // 3. Serve the dashboard.html for all other routes (SPA fallback)
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'), (err) => {
        if (err) {
            console.error("Dashboard file serving error:", err);
            res.status(500).send("Error: Required client file is missing from public directory.");
        }
    });
});

// ===================================
// 5. SERVER STARTUP LOGIC
// ===================================
async function startServer() {
    try {
        // 1. File System Check (Updated to include all relevant dirs)
        const uploadDirs = [
            TEACHERS_UPLOAD_DIR, 
            TRANSPORT_UPLOAD_DIR, 
            DOCUMENTS_UPLOAD_DIR,
            MEDIA_UPLOAD_DIR 
        ];
        for (const dir of uploadDirs) {
            if (!fs.existsSync(dir)) {
                console.log(`Creating upload directory: ${dir}`);
                fs.mkdirSync(dir, { recursive: true });
            }
        }
        
        // 2. Database Initialization
        await initializeDatabase();
        console.log("Database initialized successfully.");

        // 3. Start Express Server
        app.listen(port, () => {
            console.log(`✅ Server is running on http://localhost:${port}`);
            
            // 4. Start background services
            startNotificationService();
        });

    } catch (error) {
        // Catch critical errors, log them, and exit
        console.error("🔥🔥 Failed to start server due to a critical error:", error.message);
        process.exit(1); 
    }
}

// Execute the startup function
startServer();