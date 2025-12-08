/**
 * SERVER.JS
 * Entry point for the School ERP System
 * Final Updated Version: Incorporating all Global Feature Routers AND Backup Static File Route
 */

// ===================================
// 1. DEPENDENCIES & CONFIGURATION
// ===================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const morgan = require('morgan'); 

// --- Custom Modules ---
const { initializeDatabase, pool } = require('./database');
const { startNotificationService } = require('./notificationService');
const { multerInstance } = require('./multerConfig');
const { authenticateToken } = require('./authMiddleware');

// --- Configuration Constants ---
const PORT = process.env.PORT || 3005;
const UPLOAD_DIRS = [
    path.join(__dirname, 'uploads', 'teacher_photos'),
    path.join(__dirname, 'uploads', 'teacher_cvs'),
    path.join(__dirname, 'uploads', 'transport'),
    path.join(__dirname, 'uploads', 'documents'),
    path.join(__dirname, 'uploads', 'media')
];
const BACKUP_DIR = path.join(__dirname, 'backups');

// --- Router Imports (NEW and existing) ---
const authRouter = require('./routes/auth');
const dashboardRouter = require('./routes/dashboard'); 
const usersRouter = require('./routes/users'); 
const vmsRouter = require('./routes/vms'); 
const verifyRouter = require('./routes/verify'); 
const settingsRouter = require('./routes/settings');
const mediaRouter = require('./routes/media');
const announcementsRouter = require('./routes/announcements');
const noticesRouter = require('./routes/notices');
const messagingRouter = require('./routes/messaging');
const studentsRouter = require('./routes/students');
const admissionRouter = require('./routes/admission');
const teachersRouter = require('./routes/teachers');

// --- GLOBAL MANAGEMENT MODULES (NEW) ---
const branchesRouter = require('./routes/branches'); 
const systemLogsRouter = require('./routes/systemLogs'); 
const backupRestoreRouter = require('./routes/backupRestore'); 
const coursesRouter = require('./routes/courses');
const subjectsRouter = require('./routes/subjects');
const sectionsRouter = require('./routes/sections');
const academicSessionsRouter = require('./routes/academic_sessions');
const academicswithfeesRouter = require('./routes/academicswithfees');
const timetableRouter = require('./routes/timetable');
const attendanceRouter = require('./routes/attendance');
const leaveRouter = require('./routes/leave');
const ptmRouter = require('./routes/ptm');
const examsRouter = require('./routes/exams');
const onlineExamRouter = require('./routes/onlineExam');
const marksRouter = require('./routes/marks');
const reportCardRouter = require('./routes/reportcard');
const certificatesRouter = require('./routes/certificates');
const assignmentsRouter = require('./routes/assignments');
const onlineLearningRouter = require('./routes/onlineLearning');
const feesRouter = require('./routes/fees');
const paymentsRouter = require('./routes/payments');
const invoicesRouter = require('./routes/invoices');
const payrollRouter = require('./routes/payroll');
const staffhrRouter = require('./routes/staffhr');
const hrDepartmentsRouter = require('./routes/hr/departments');
const transportRouter = require('./routes/transport');
const hostelRouter = require('./routes/hostel');
const cafeteriaRouter = require('./routes/cafeteria');
const libraryRouter = require('./routes/library');
// 🛑 CRITICAL FIX: Use the correct split router imports
const inventoryRouter = require('./routes/inventory'); // Mapped to /api/inventory
const assetRouter = require('./routes/asset');         // Mapped to /api/asset
// 🛑 END CRITICAL FIX

const itHelpdeskRouter = require('./routes/it-helpdesk');
const enquiriesRouter = require('./routes/enquiries');
const clubsEventsRouter = require('./routes/clubsEvents');
const alumniRouter = require('./routes/alumni');
const disciplineRouter = require('./routes/discipline');
const complianceRouter = require('./routes/compliance');
const reportsRouter = require('./routes/reports');
const feedbackRouter = require('./routes/feedback');
const placementsRouter = require('./routes/placements');
const healthRouter = require('./routes/health');

// --- App Initialization ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Make Socket.io & Upload accessible globally
app.set('io', io);
app.set('upload', multerInstance);

// ===================================
// 2. GLOBAL MIDDLEWARE
// ===================================

// Logging (Shows API calls in terminal)
app.use(morgan('dev'));

// Security & Parsing
app.use(cors());
app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString(); } 
}));
app.use(express.urlencoded({ extended: true }));

// Static File Serving
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Serve files from the /backups folder
app.use('/backups', express.static(BACKUP_DIR));


// ===================================
// 3. REAL-TIME SOCKET LOGIC
// ===================================
io.on('connection', (socket) => {
    // console.log('Socket connected:', socket.id); // Uncomment for debug
    socket.on('join_conversation', (conversationId) => {
        socket.join(conversationId);
    });
});

// ===================================
// 4. API ROUTES
// ===================================

// --- A. PUBLIC ROUTES (No Token Required) ---
app.use('/api/auth', authRouter);
app.use('/api/dashboard', dashboardRouter); 
app.use('/api/users', usersRouter); 
app.use('/api/vms', vmsRouter); 
app.use('/api/public/verify', verifyRouter); 
app.use('/api/health-records', healthRouter);

// --- B. PROTECTED ROUTES (JWT Token Required) ---
// All routes mounted below require a valid Bearer Token
app.use('/api', authenticateToken);

// --- GLOBAL MANAGEMENT MODULES (NEW) ---
app.use('/api/branches', branchesRouter); 
app.use('/api/system/logs', systemLogsRouter); 
app.use('/api/system/backup', backupRestoreRouter); 
app.use('/api/feedback', feedbackRouter);

// Core Modules
app.use('/api/settings', settingsRouter);
app.use('/api/media', mediaRouter);
app.use('/api/announcements', announcementsRouter);
app.use('/api/notices', noticesRouter);
app.use('/api/messaging', messagingRouter);

// Academic Modules
app.use('/api/students', studentsRouter);
app.use('/api/admission', admissionRouter);
app.use('/api/teachers', teachersRouter);
app.use('/api/courses', coursesRouter);
app.use('/api/subjects', subjectsRouter);
app.use('/api/sections', sectionsRouter);
app.use('/api/academic-sessions', academicSessionsRouter);
app.use('/api/academicswithfees', academicswithfeesRouter);
app.use('/api/timetable', timetableRouter);
app.use('/api/attendance', attendanceRouter);
app.use('/api/leave', leaveRouter);
app.use('/api/ptm', ptmRouter);
app.use('/api/placements', placementsRouter);

// Exam Modules
app.use('/api/exams', examsRouter);
app.use('/api/online-exam', onlineExamRouter);
app.use('/api/marks', marksRouter);
app.use('/api/report-card', reportCardRouter);
app.use('/api/certificates', certificatesRouter);
app.use('/api/assignments', assignmentsRouter);
app.use('/api/online-learning', onlineLearningRouter);

// Finance Modules
app.use('/api/fees', feesRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/invoices', invoicesRouter); 
app.use('/api/payroll', payrollRouter);

// HR & Operations
app.use('/api/staffhr', staffhrRouter);
app.use('/api/hr/departments', hrDepartmentsRouter);
app.use('/api/transport', transportRouter);
app.use('/api/hostel', hostelRouter);
app.use('/api/cafeteria', cafeteriaRouter);
app.use('/api/library', libraryRouter);

// 🛑 CRITICAL FIX: Inventory & Asset Mounting
app.use('/api/inventory', inventoryRouter); // Mapped to routes/inventory.js
app.use('/api/asset', assetRouter);         // Mapped to routes/asset.js
// 🛑 END CRITICAL FIX

app.use('/api/it-helpdesk', itHelpdeskRouter);

// General Modules
app.use('/api/enquiries', enquiriesRouter);
app.use('/api/activities', clubsEventsRouter);
app.use('/api/alumni', alumniRouter);
app.use('/api/discipline', disciplineRouter);
app.use('/api/compliance', complianceRouter);
app.use('/api/reports', reportsRouter);

// ===================================
// 5. FRONTEND ROUTING (SPA Support)
// ===================================

// Root Redirect
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// Catch-all Handler (For 404s and SPA Routing)
app.use((req, res, next) => {
    const url = req.originalUrl;
    
    // API 404 (Explicitly return JSON for API errors)
    if (url.startsWith('/api')) {
        return res.status(404).json({ success: false, message: `API Endpoint not found: ${url}` });
    }

    // Missing Static Files (Images, CSS, JS)
    if (url.match(/\.(html|css|js|png|jpg|jpeg|gif|ico|svg|pdf)$/)) {
        return res.status(404).send("File not found");
    }

    // Default Fallback to Dashboard (for SPA behavior)
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ===================================
// 6. GLOBAL ERROR HANDLER
// ===================================
app.use((err, req, res, next) => {
    console.error("🔥 Global Error:", err.stack);
    
    // Handle specific multer errors
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'File too large' });
    }

    const statusCode = err.status || 500;
    res.status(statusCode).json({
        success: false,
        message: err.message || "Internal Server Error",
        // Only show full error stack in development mode
        error: process.env.NODE_ENV === 'development' ? err : {}
    });
});

// ===================================
// 7. SERVER STARTUP
// ===================================
async function startServer() {
    try {
        // Initialize Directories
        UPLOAD_DIRS.forEach(dir => {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        });
        // Ensure Backup Directory exists
        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }
        
        // Connect Database
        await initializeDatabase();
        console.log("✅ Database initialized successfully.");

        // Start Server
        server.listen(PORT, () => {
            console.log(`🚀 Server running on http://localhost:${PORT}`);
            startNotificationService();
        });

    } catch (error) {
        console.error("❌ Critical Startup Failed:", error.message);
        process.exit(1);
    }
}

// Graceful Shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await pool.end();
    process.exit(0);
});

startServer();