/**
 * SERVER.JS
 * Entry point for the Student Management System (ERP)
 * Structure: Imports -> Config -> Middleware -> Routes -> Error Handling -> Startup
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
const morgan = require('morgan'); // Request logger (install via: npm install morgan)

// --- Custom Modules ---
const { initializeDatabase, pool } = require('./database');
const { startNotificationService } = require('./notificationService');
const { multerInstance } = require('./multerConfig');
const { authenticateToken } = require('./authMiddleware');

// --- Configuration Constants ---
const PORT = process.env.PORT || 3005;
const UPLOAD_DIRS = [
    path.join(__dirname, 'uploads', 'teachers'),
    path.join(__dirname, 'uploads', 'transport'),
    path.join(__dirname, 'uploads', 'documents'),
    path.join(__dirname, 'uploads', 'media')
];

// --- App Initialization ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Make Socket.io accessible globally via req.app.get('io')
app.set('io', io);
app.set('upload', multerInstance);

// ===================================
// 2. GLOBAL MIDDLEWARE
// ===================================

// Logging (Optional: Remove if you don't want logs in console)
app.use(morgan('dev'));

// Security & Parsing
app.use(cors());
app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString(); } // Useful for Webhooks (Stripe etc.)
}));
app.use(express.urlencoded({ extended: true }));

// Static File Serving
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ===================================
// 3. REAL-TIME SOCKET LOGIC
// ===================================
io.on('connection', (socket) => {
    // console.log(`⚡ Socket Connected: ${socket.id}`);

    socket.on('join_conversation', (conversationId) => {
        socket.join(conversationId);
        // console.log(`Socket ${socket.id} joined room: ${conversationId}`);
    });

    socket.on('disconnect', () => {
        // console.log(`Socket Disconnected: ${socket.id}`);
    });
});

// ===================================
// 4. API ROUTES
// ===================================

// --- A. PUBLIC ROUTES (No Token Required) ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/dashboard', require('./routes/dashboard')); // Dashboard stats usually public to logged in users via frontend check
app.use('/api/users', require('./routes/users')); 
app.use('/api/vms', require('./routes/vms')); // Visitor Management usually needs public access

// --- B. PROTECTED ROUTES (JWT Token Required) ---
// All routes mounted below this line require a valid Bearer Token
app.use('/api', authenticateToken);

// Core Modules
app.use('/api/settings', require('./routes/settings'));
app.use('/api/media', require('./routes/media'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/notices', require('./routes/notices'));
app.use('/api/messaging', require('./routes/messaging'));

// Academic Modules
app.use('/api/students', require('./routes/students'));
app.use('/api/admission', require('./routes/admission'));
app.use('/api/teachers', require('./routes/teachers'));
app.use('/api/courses', require('./routes/courses'));
app.use('/api/subjects', require('./routes/subjects'));
app.use('/api/sections', require('./routes/sections'));
app.use('/api/academic-sessions', require('./routes/academic_sessions'));
app.use('/api/academicswithfees', require('./routes/academicswithfees'));
app.use('/api/timetable', require('./routes/timetable'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/leave', require('./routes/leave'));
app.use('/api/ptm', require('./routes/ptm'));

// Exam Modules
app.use('/api/exams', require('./routes/exams'));
app.use('/api/online-exam', require('./routes/onlineExam'));
app.use('/api/marks', require('./routes/marks'));
app.use('/api/report-card', require('./routes/reportcard'));
app.use('/api/certificates', require('./routes/certificates'));
app.use('/api/assignments', require('./routes/assignments'));
app.use('/api/online-learning', require('./routes/onlineLearning'));

// Finance Modules
app.use('/api/fees', require('./routes/fees'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/payroll', require('./routes/payroll'));

// HR & Operations
app.use('/api/staffhr', require('./routes/staffhr'));
app.use('/api/hr/departments', require('./routes/hr/departments'));
app.use('/api/transport', require('./routes/transport'));
app.use('/api/hostel', require('./routes/hostel'));
app.use('/api/cafeteria', require('./routes/cafeteria'));
app.use('/api/library', require('./routes/library'));
app.use('/api', require('./routes/inventory-with-assets'));

// General Modules
app.use('/api/enquiries', require('./routes/enquiries'));
app.use('/api/activities', require('./routes/clubsEvents'));
app.use('/api/alumni', require('./routes/alumni'));
app.use('/api/discipline', require('./routes/discipline'));
app.use('/api/compliance', require('./routes/compliance'));
app.use('/api/reports', require('./routes/reports'));

// ===================================
// 5. FRONTEND ROUTING (SPA Support)
// ===================================

// Specific Static Pages
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/exam-management.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'exam-management.html')));

// Catch-all Handler (For SPA behavior or 404s)
app.use((req, res, next) => {
    const url = req.originalUrl;
    
    // If it's an API request that wasn't handled above, return 404 JSON
    if (url.startsWith('/api')) {
        return res.status(404).json({ success: false, message: "API Endpoint not found." });
    }

    // If it looks like a file request (has extension) but missing, return 404
    if (url.includes('.') && !url.endsWith('.html')) {
        return res.status(404).send("File not found");
    }

    // Otherwise, serve the Dashboard (or 404 page if you prefer)
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ===================================
// 6. GLOBAL ERROR HANDLER
// ===================================
app.use((err, req, res, next) => {
    console.error("🔥 Global Error:", err.stack);
    
    const statusCode = err.status || 500;
    res.status(statusCode).json({
        success: false,
        message: err.message || "Internal Server Error",
        error: process.env.NODE_ENV === 'development' ? err : {}
    });
});

// ===================================
// 7. SERVER STARTUP & SHUTDOWN
// ===================================
async function startServer() {
    try {
        // 1. Initialize Directories
        UPLOAD_DIRS.forEach(dir => {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        });
        
        // 2. Connect Database
        await initializeDatabase();
        console.log("✅ Database initialized successfully.");

        // 3. Start Server
        server.listen(PORT, () => {
            console.log(`🚀 Server running on http://localhost:${PORT}`);
            
            // 4. Start Background Services
            startNotificationService();
        });

    } catch (error) {
        console.error("❌ Critical Startup Failed:", error.message);
        process.exit(1);
    }
}

// Handle Graceful Shutdown (Ctrl+C or Docker Stop)
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await pool.end(); // Close DB connections
    process.exit(0);
});

startServer();