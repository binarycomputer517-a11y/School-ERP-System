// /server.js
// A modular Express server for a Student Management System (SMS)

// ===================================
// 1. IMPORTS & INITIALIZATION
// ===================================
const express = require('express');
const http = require('http'); 
const { Server } = require('socket.io'); 
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config(); 

// --- Custom Modules ---
const { initializeDatabase } = require('./database');
const { startNotificationService } = require('./notificationService');
const { multerInstance } = require('./multerConfig'); 
const { authenticateToken } = require('./authMiddleware'); 

// --- Upload Directories ---
const TEACHERS_UPLOAD_DIR = path.join(__dirname, 'uploads', 'teachers'); 
const TRANSPORT_UPLOAD_DIR = path.join(__dirname, 'uploads', 'transport'); 
const DOCUMENTS_UPLOAD_DIR = path.join(__dirname, 'uploads', 'documents'); 
const MEDIA_UPLOAD_DIR = path.join(__dirname, 'uploads', 'media'); 

const app = express();
const port = process.env.PORT || 3005;

// --- Server & Socket.io Setup ---
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Make 'io' accessible globally
app.set('io', io);

// ===================================
// 2. CORE MIDDLEWARE
// ===================================
app.use(cors());
app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));
app.use(express.urlencoded({ extended: true }));

// Static Files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Attach Multer
app.set('upload', multerInstance); 

// ===================================
// 3. SOCKET.IO LOGIC
// ===================================
io.on('connection', (socket) => {
    console.log('⚡ User connected (Socket):', socket.id);

    socket.on('join_conversation', (conversationId) => {
        socket.join(conversationId);
        console.log(`User ${socket.id} joined room: ${conversationId}`);
    });

    socket.on('disconnect', () => console.log('User disconnected'));
});

// ===================================
// 4. API ROUTE IMPORTS
// ===================================

// Auth & Core
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const dashboardRoutes = require('./routes/dashboard');
const settingsRoutes = require('./routes/settings');
const mediaRouter = require('./routes/media');
const announcementsRoutes = require('./routes/announcements');
const noticesRouter = require('./routes/notices'); 

// Academics
const studentsRoutes = require('./routes/students');
const admissionRouter = require('./routes/admission');
const teachersRoutes = require('./routes/teachers'); 
const coursesRouter = require('./routes/courses'); 
const subjectsRouter = require('./routes/subjects');
const sectionsRoutes = require('./routes/sections');
const academicSessionsRoutes = require('./routes/academic_sessions');
const academicsWithFeesRouter = require('./routes/academicswithfees');
const timetableRoutes = require('./routes/timetable');
const attendanceRouter = require('./routes/attendance'); 
const leaveRouter = require('./routes/leave'); 

// Exams & Results
const examsRouter = require('./routes/exams'); 
const onlineExamRoutes = require('./routes/onlineExam'); 
const marksRoutes = require('./routes/marks');
const reportCardRouter = require('./routes/reportcard');
const certificatesRouter = require('./routes/certificates');
const assignmentsRouter = require('./routes/assignments'); 
const onlineLearningRouter = require('./routes/onlineLearning');

// Finance
const feesRoutes = require('./routes/fees'); 
const paymentsRouter = require('./routes/payments');
const invoicesRouter = require('./routes/invoices');
const payrollRouter = require('./routes/payroll');

// HR & Staff
const staffhrRouter = require('./routes/staffhr');
const departmentRoutes = require('./routes/hr/departments');

// Operations & Facilities
const transportRouter = require('./routes/transport'); 
const hostelRouter = require('./routes/hostel'); 
const cafeteriaRouter = require('./routes/cafeteria');
const libraryRouter = require('./routes/library');
const erpInventoryAssetRouter = require('./routes/inventory-with-assets'); 
const vmsRouter = require('./routes/vms');

// Communication & Others
const messagingRouter = require('./routes/messaging');
const enquiriesRouter = require('./routes/enquiries');
const activitiesRouter = require('./routes/clubsEvents'); 
const alumniRouter = require('./routes/alumni'); 
const disciplineRouter = require('./routes/discipline');
const complianceRoutes = require('./routes/compliance');
const reportsRoutes = require('./routes/reports');
const ptmRoutes = require('./routes/ptm'); // <--- PTM Route

// ===================================
// 5. ROUTE MOUNTING
// ===================================

// --- Public Routes ---
app.use('/api/auth', authRoutes); 
app.use('/api/dashboard', dashboardRoutes); 
app.use('/api/users', userRoutes); 
app.use('/api/vms', vmsRouter); 

// --- Protected Routes (JWT Required) ---
app.use('/api', authenticateToken); 

// Core
app.use('/api/settings', settingsRoutes);
app.use('/api/media', mediaRouter);
app.use('/api/announcements', announcementsRoutes);
app.use('/api/notices', noticesRouter);
app.use('/api/messaging', messagingRouter);

// Academic
app.use('/api/students', studentsRoutes);
app.use('/api/admission', admissionRouter);
app.use('/api/teachers', teachersRoutes);
app.use('/api/courses', coursesRouter);
app.use('/api/subjects', subjectsRouter);
app.use('/api/sections', sectionsRoutes);
app.use('/api/academic-sessions', academicSessionsRoutes);
app.use('/api/academicswithfees', academicsWithFeesRouter);
app.use('/api/timetable', timetableRoutes);
app.use('/api/attendance', attendanceRouter);
app.use('/api/leave', leaveRouter);
app.use('/api/ptm', ptmRoutes); // <--- Mounted PTM

// Exams
app.use('/api/exams', examsRouter);
app.use('/api/online-exam', onlineExamRoutes);
app.use('/api/marks', marksRoutes);
app.use('/api/report-card', reportCardRouter);
app.use('/api/certificates', certificatesRouter);
app.use('/api/assignments', assignmentsRouter);
app.use('/api/online-learning', onlineLearningRouter);

// Finance
app.use('/api/fees', feesRoutes);
app.use('/api/payments', paymentsRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/payroll', payrollRouter);

// HR
app.use('/api/staffhr', staffhrRouter);
app.use('/api/hr/departments', departmentRoutes);

// Facilities
app.use('/api/transport', transportRouter);
app.use('/api/hostel', hostelRouter);
app.use('/api/cafeteria', cafeteriaRouter);
app.use('/api/library', libraryRouter);
app.use('/api', erpInventoryAssetRouter);

// Other
app.use('/api/enquiries', enquiriesRouter);
app.use('/api/activities', activitiesRouter);
app.use('/api/alumni', alumniRouter);
app.use('/api/discipline', disciplineRouter);
app.use('/api/compliance', complianceRoutes);
app.use('/api/reports', reportsRoutes);


// ===================================
// 6. FRONTEND SERVING
// ===================================
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/exam-management.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'exam-management.html')));

// Catch-all for SPA / Dashboard
app.use((req, res) => {
    const url = req.originalUrl;
    if (url.startsWith('/api')) {
        return res.status(404).json({ message: "API Endpoint not found." });
    }
    if (url.includes('.') && !url.endsWith('.html')) {
        return res.status(404).send("Static file not found");
    }
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ===================================
// 7. STARTUP
// ===================================
async function startServer() {
    try {
        // Create Directories
        [TEACHERS_UPLOAD_DIR, TRANSPORT_UPLOAD_DIR, DOCUMENTS_UPLOAD_DIR, MEDIA_UPLOAD_DIR].forEach(dir => {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        });
        
        // Init DB
        await initializeDatabase();
        console.log("✅ Database initialized.");

        // Start Server
        server.listen(port, () => {
            console.log(`🚀 Server running on http://localhost:${port}`);
            startNotificationService();
        });

    } catch (error) {
        console.error("❌ Startup Failed:", error.message);
        process.exit(1); 
    }
}

startServer();