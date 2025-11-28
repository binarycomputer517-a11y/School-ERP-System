// /server.js
// A modular Express server for a Student Management System (SMS)

// ===================================
// 1. IMPORTS & INITIALIZATION
// ===================================
const express = require('express');
const http = require('http'); // [NEW] Required for Socket.io
const { Server } = require('socket.io'); // [NEW] Import Socket.io
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config(); 

// --- Custom Modules & Configuration ---
const { initializeDatabase } = require('./database');
const { startNotificationService } = require('./notificationService');
const { multerInstance } = require('./multerConfig'); 
const { authenticateToken } = require('./authMiddleware'); // JWT Middleware

// --- Constants & Setup ---
const TEACHERS_UPLOAD_DIR = path.join(__dirname, 'uploads', 'teachers'); 
const TRANSPORT_UPLOAD_DIR = path.join(__dirname, 'uploads', 'transport'); 
const DOCUMENTS_UPLOAD_DIR = path.join(__dirname, 'uploads', 'documents'); 
const MEDIA_UPLOAD_DIR = path.join(__dirname, 'uploads', 'media'); 

const app = express();
const port = process.env.PORT || 3005;

// [NEW] Create HTTP Server & Socket.io Instance
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins (adjust for production)
        methods: ["GET", "POST"]
    }
});

// [NEW] Make 'io' accessible globally in routes via req.app.get('io')
app.set('io', io);

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
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Attach the initialized BASE Multer instance to the app object.
app.set('upload', multerInstance); 

// ===================================
// 3. SOCKET.IO CONNECTION LOGIC
// ===================================
io.on('connection', (socket) => {
    console.log('⚡ A user connected via Socket.io:', socket.id);

    // Event: User joins a specific conversation (Room)
    socket.on('join_conversation', (conversationId) => {
        socket.join(conversationId);
        console.log(`User ${socket.id} joined room: ${conversationId}`);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// ===================================
// 4. API ROUTE DEFINITIONS
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
const transportRouter = require('./routes/transport'); 
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
const enquiriesRouter = require('./routes/enquiries');
const assignmentsRouter = require('./routes/assignments'); 
const staffhrRouter = require('./routes/staffhr');
const messagingRouter = require('./routes/messaging');
const cafeteriaRouter = require('./routes/cafeteria');
const paymentsRouter = require('./routes/payments');
const ptmRoutes = require('./routes/ptm');
const dashboardRoutes = require('./routes/dashboard');
const reportCardRouter = require('./routes/reportcard');
const disciplineRouter = require('./routes/discipline');
const settingsRoutes = require('./routes/settings');
const hostelRouter = require('./routes/hostel'); 
const erpInventoryAssetRouter = require('./routes/inventory-with-assets'); 
const departmentRoutes = require('./routes/hr/departments');
const mediaRouter = require('./routes/media');
const vmsRouter = require('./routes/vms');
const alumniRouter = require('./routes/alumni'); 
const invoicesRouter = require('./routes/invoices');
const reportsRoutes = require('./routes/reports');
const academicSessionsRoutes = require('./routes/academic_sessions');
// --- PUBLIC API ROUTES (NO AUTH REQUIRED) ---
app.use('/api/auth', authRoutes); 
app.use('/api/dashboard', dashboardRoutes); 
app.use('/api/users', userRoutes); 
app.use('/api/vms', vmsRouter); 


// --- PROTECTED API ROUTES (JWT AUTH REQUIRED) ---
app.use('/api', authenticateToken); 

// Routes
app.use('/api/students', studentsRoutes);
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
app.use('/api/reports', reportsRoutes);
app.use('/api/fees', feesRoutes); 
app.use('/api/payments', paymentsRouter);
app.use('/api/invoices', invoicesRouter);
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
app.use('/api/enquiries', enquiriesRouter);
app.use('/api/hr/departments', departmentRoutes);
app.use('/api/media', mediaRouter);
app.use('/api/alumni', alumniRouter); 
app.use('/api/messaging', messagingRouter);
app.use('/api/academic-sessions', academicSessionsRoutes);
// ===================================
// 5. PAGE SERVING & SPA ROUTING 
// ===================================
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/exam-management.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'exam-management.html'));
});

// Catch-all route for SPA
app.use((req, res, next) => {
    const url = req.originalUrl;
    if (url.startsWith('/api')) {
        return res.status(404).json({ message: "API Endpoint not found." });
    }
    if (url.includes('.') && !url.endsWith('.html')) {
        return res.status(404).send("Static file not found: " + url);
    }
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'), (err) => {
        if (err) res.status(500).send("Error: Client file missing.");
    });
});

// ===================================
// 6. SERVER STARTUP LOGIC
// ===================================
async function startServer() {
    try {
        // 1. File System Check
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

        // 3. Start Server (USING server.listen, NOT app.listen)
        server.listen(port, () => {
            console.log(`✅ Server is running on http://localhost:${port}`);
            startNotificationService();
        });

    } catch (error) {
        console.error("🔥🔥 Failed to start server:", error.message);
        process.exit(1); 
    }
}

startServer();