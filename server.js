/**
 * SERVER.JS
 * Entry point for the School ERP System
 * Final Updated Version: Fixed UUID vs Receipt Number Logic
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

// --- Router Imports (All Modules) ---
const authRouter = require('./routes/auth');
const dashboardRouter = require('./routes/dashboard'); 
const usersRouter = require('./routes/users'); 
const vmsRouter = require('./routes/vms'); 
const verifyRouter = require('./routes/verify'); 
const settingsRouter = require('./routes/settings');
const { generateAndSendDailyReport } = require('./routes/daily-report-automation');
const mediaRouter = require('./routes/media');
const announcementsRouter = require('./routes/announcements');
const noticesRouter = require('./routes/notices');
const messagingRouter = require('./routes/messaging');
const studentsRouter = require('./routes/students');
const admissionRouter = require('./routes/admission');
const teachersRouter = require('./routes/teachers');
const utilsRouter = require('./routes/utils');
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
const onlineExamRouter = require('./routes/onlineExam');
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
const inventoryRouter = require('./routes/inventory'); 
const assetRouter = require('./routes/asset');         
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

// 🚀 MERGED ROUTER IMPORTS & FIXES
const examsRouter = require('./routes/exams'); 
const examMarksRouter = require('./routes/exam_marks'); 
const quizzesRouter = require('./routes/quizzes'); 
const transcriptRoutes = require('./routes/transcript'); 
const calendarRoutes = require('./routes/calendar'); 
const notificationsRouter = require('./routes/notifications');


// --- App Initialization ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { 
        origin: [
            'https://bcsm.org.in',
            'https://www.bcsm.org.in',
            'https://portal.bcsm.org.in',
            'http://localhost:3000'
        ],
        methods: ["GET", "POST"] 
    }
});

// Make Socket.io & Upload accessible globally
app.set('io', io);
app.set('upload', multerInstance);

// ===================================
// 2. GLOBAL MIDDLEWARE
// ===================================
app.use(morgan('dev'));

// ✅ UPDATED & ROBUST CORS CONFIGURATION
const allowedOrigins = [
    'https://bcsm.org.in',       
    'https://www.bcsm.org.in',
    'https://portal.bcsm.org.in', 
    'https://www.portal.bcsm.org.in', // Added to prevent www vs non-www mismatch
    'http://localhost:3000',
    'http://localhost:3005',
    'http://localhost',           
    'capacitor://localhost'       
];

app.use(cors({
    origin: function (origin, callback) {
        // 1. Allow if no origin (e.g., Mobile Apps, Server-to-Server or Postman)
        if (!origin) return callback(null, true);
        
        // 2. Check if origin is in the allowed list or is a localhost variation
        const isAllowed = allowedOrigins.includes(origin) || 
                          origin.startsWith('http://localhost') || 
                          origin.startsWith('http://127.0.0.1');

        if (isAllowed) {
            callback(null, true);
        } else {
            console.error('🔥 CORS Blocked for Origin:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true, 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type', 
        'Authorization', 
        'X-Requested-With', 
        'Accept', 
        'Origin'
    ]
}));

// বাকি মিডলওয়্যারগুলো আগের মতোই থাকবে
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/backups', express.static(BACKUP_DIR));
app.get('/favicon.ico', (req, res) => res.status(204).end());


// ===================================
// 3. REAL-TIME SOCKET LOGIC (ENTERPRISE MASTER)
// ===================================
io.on('connection', (socket) => {
    console.log('⚡ User Connected:', socket.id);

    /**
     * A. INITIALIZATION & PRIVATE ROOMS
     * Links the socket to the user's specific UUID for targeted pings
     */
    socket.on('join_user_room', (userId) => {
        if (!userId) return;
        socket.join(`user_${userId}`);
        console.log(`📡 Private Link: user_${userId}`);
    });

    /**
     * B. CONVERSATION FLOW
     */
    socket.on('join_conversation', (conversationId) => { 
        if (!conversationId) return;
        socket.join(conversationId); 
        console.log(`👥 User joined conversation: ${conversationId}`);
    });

    socket.on('leave_conversation', (conversationId) => { 
        socket.leave(conversationId); 
        console.log(`🏃 User left conversation: ${conversationId}`);
    });

    /**
     * C. USER INTERACTION (Typing & Read)
     */
    socket.on('typing', (data) => {
        // data: { conversationId, senderName }
        socket.to(data.conversationId).emit('user_typing', data);
    });

    socket.on('stop_typing', (conversationId) => {
        socket.to(conversationId).emit('user_stop_typing');
    });

    socket.on('mark_as_read', (data) => {
        const { conversationId, userId } = data;
        // Immediate UI sync for other participants currently in the chat
        socket.to(conversationId).emit('messages_read_sync', { conversationId, userId });
    });

    /**
     * D. MASTER MESSAGE DISPATCHER
     */
    socket.on('new_message', async (message) => {
        const { conversationId, senderId, content, message_type, file_url } = message;
        if (!conversationId || !senderId) return; 

        try {
            // 1. Database Persistence
            const saveResult = await pool.query(
                `INSERT INTO messages (conversation_id, sender_id, content, message_type, file_url) 
                 VALUES ($1, $2, $3, $4, $5) RETURNING *;`,
                [conversationId, senderId, content || '', message_type || 'text', file_url || null]
            );
            const savedMessage = saveResult.rows[0];

            // 2. Refresh Conversation Sorting
            await pool.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1`, [conversationId]);

            // 3. Fetch Identity for Display
            const userResult = await pool.query('SELECT full_name FROM users WHERE id = $1', [senderId]);
            const senderName = userResult.rows[0]?.full_name || 'User';

            const broadcastData = { ...savedMessage, timestamp: savedMessage.created_at, sender_name: senderName };

            // 4. In-Chat Broadcast (Real-time view)
            io.to(conversationId).emit('message_received', broadcastData);

            // 5. Cross-Platform Notifications (To private rooms of other participants)
            const participants = await pool.query(
                `SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND user_id != $2`,
                [conversationId, senderId]
            );

            participants.rows.forEach(p => {
                io.to(`user_${p.user_id}`).emit('global_unread_update', {
                    conversationId,
                    senderName,
                    preview: content ? content.substring(0, 30) + "..." : "Sent a file"
                });
            });

        } catch (error) {
            console.error('🚀 Socket Error:', error);
            socket.emit('message_error', { message: 'Database sync failed.' });
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ User Disconnected');
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
app.use('/api/inventory', inventoryRouter); 
app.use('/api/asset', assetRouter);



// --- B. PROTECTED ROUTES (JWT Token Required) ---
// All routes mounted below require a valid Bearer Token
app.use('/api', authenticateToken);

/**
 * ✅ UPDATED: MANUAL REPORT TRIGGER
 * এটি এখন Super Admin এবং Branch Admin (যেমন wb02_admin) উভয়কেই অনুমতি দেবে।
 */
app.get('/api/finance/trigger-daily-report', authenticateToken, async (req, res) => {
    try {
        // 🛡️ রোল চেক আপডেট: super admin অথবা admin হলেই রিপোর্ট জেনারেট হবে
        const allowedRoles = ['super admin', 'admin'];
        
        if (!allowedRoles.includes(req.user.role.toLowerCase())) {
            return res.status(403).json({ message: "Access denied. Only Admins can generate reports." });
        }

        console.log(`📊 Report triggered by: ${req.user.username} (Role: ${req.user.role})`);
        
        await generateAndSendDailyReport();
        res.json({ success: true, message: "Daily Report generation triggered! Check your email." });
    } catch (err) {
        console.error("Manual Trigger Error:", err);
        res.status(500).json({ message: "Failed to trigger report." });
    }
});

/**
 * 2. TEST EMAIL DELIVERY (Fixed Path)
 */
app.post('/api/utils/test-email', async (req, res) => {
    // ✅ সংশোধন: মেইলার ফাইল থেকে ইমপোর্ট করুন
    const { sendEmailWithAttachment } = require('./utils/mailer');
    
    try {
        await sendEmailWithAttachment({
            to: 'casudam1989@gmail.com',
            subject: '🚀 ERP System: Email Service Test',
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; border: 2px solid #005A9C;">
                    <h2 style="color: #005A9C;">Connection Successful!</h2>
                    <p>Your SMTP settings are working perfectly for the BCSM Portal.</p>
                    <p>Timestamp: <b>${new Date().toLocaleString()}</b></p>
                </div>
            `
        });
        res.json({ success: true, message: "Test email sent successfully! Check your inbox." });
    } catch (error) {
        console.error("Test Email Error:", error);
        res.status(500).json({ success: false, message: "Email failed to send." });
    }
});
// ==========================================
// CUSTOM ROUTE 1: Student Fee Clearance Check
// ==========================================
app.get('/api/students/fee-clearance', async (req, res) => {
    try {
        const userId = req.user.id;
        const studentRes = await pool.query('SELECT student_id FROM students WHERE user_id = $1', [userId]);
        if (studentRes.rows.length === 0) return res.status(404).json({ message: "Student not found" });
        
        const studentId = studentRes.rows[0].student_id;

        const feeQuery = `
            SELECT 
                COALESCE(SUM(tuition_fee), 0) - COALESCE(SUM(amount_paid), 0) as due_amount
            FROM fee_records 
            WHERE student_id = $1`;

        const feeRes = await pool.query(feeQuery, [studentId]);
        const dueAmount = parseFloat(feeRes.rows[0].due_amount || 0);

        if (dueAmount <= 0) {
            res.json({ cleared: true, message: "Fees Cleared" });
        } else {
            res.json({ cleared: false, due: dueAmount, message: "Fees Pending" });
        }
    } catch (err) {
        console.error("Fee Check Error:", err);
        res.json({ cleared: true, message: "Fee Check Bypassed (Error)" });
    }
});

// ==========================================
// CUSTOM ROUTE: Student Payment History
// ==========================================
app.get('/api/finance/student/payment-history', async (req, res) => {
    try {
        const userId = req.user.id;

        const studentRes = await pool.query('SELECT student_id FROM students WHERE user_id = $1', [userId]);
        if (studentRes.rows.length === 0) return res.status(404).json({ message: "Student not found" });
        const studentId = studentRes.rows[0].student_id;

        const query = `
            SELECT 
                fp.id,
                si.total_amount as total_amount,  
                fp.amount as amount_paid,         
                (si.total_amount - si.paid_amount) as balance, 
                fp.payment_date,
                fp.payment_mode,
                fp.transaction_id,
                si.status as status
            FROM fee_payments fp
            JOIN student_invoices si ON fp.invoice_id = si.id
            WHERE si.student_id = $1
            ORDER BY fp.payment_date DESC`;

        const historyRes = await pool.query(query, [studentId]);
        res.json(historyRes.rows);

    } catch (err) {
        console.error("Payment History Error:", err);
        res.status(500).json({ message: "Server error fetching history" });
    }
});


// ==========================================
// CUSTOM ROUTE: Student Fee Receipts List
// ==========================================
app.get('/api/finance/student/receipts', async (req, res) => {
    try {
        const userId = req.user.id;
        
        const studentRes = await pool.query('SELECT student_id FROM students WHERE user_id = $1', [userId]);
        if (studentRes.rows.length === 0) return res.status(404).json({ message: "Student not found" });
        const studentId = studentRes.rows[0].student_id;

        const query = `
            SELECT 
                fp.id,
                fp.transaction_id,
                fp.payment_date,
                fp.amount,
                fp.payment_mode,
                fp.remarks,
                si.invoice_number,
                'School Fee' as fee_type
            FROM fee_payments fp
            JOIN student_invoices si ON fp.invoice_id = si.id
            WHERE si.student_id = $1
            ORDER BY fp.payment_date DESC`;

        const receipts = await pool.query(query, [studentId]);
        res.json(receipts.rows);

    } catch (err) {
        console.error("Receipt Fetch Error:", err);
        res.status(500).json({ message: "Server error fetching receipts" });
    }
});

// ==========================================
// ✅ CUSTOM ROUTE: Single Receipt Details (FIXED: UUID vs String)
// ==========================================


app.get('/api/finance/receipt/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // 1. Check if the ID provided is a valid UUID
        const isUUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);

        let queryCondition = '';

        if (isUUID) {
            // Case A: User clicked 'View' from an internal list (Uses Database UUID)
            queryCondition = 'fp.id = $1';
        } else {
            // Case B: User searched by Receipt Number (Uses String/Transaction ID)
            queryCondition = 'fp.transaction_id = $1';
        }

        const query = `
            SELECT 
                fp.id, fp.transaction_id, fp.payment_date, fp.amount, fp.payment_mode,
                s.first_name, s.last_name, s.enrollment_no, s.roll_number,
                c.course_name,
                si.invoice_number, 
                'Tuition & Fees' as fee_description
            FROM fee_payments fp
            JOIN student_invoices si ON fp.invoice_id = si.id
            JOIN students s ON si.student_id = s.student_id
            LEFT JOIN courses c ON s.course_id = c.id
            WHERE ${queryCondition}`;

        const receipt = await pool.query(query, [id]);
        
        if (receipt.rows.length === 0) return res.status(404).json({ message: "Receipt not found" });
        res.json(receipt.rows[0]);

    } catch (err) {
        console.error("Single Receipt Error:", err);
        res.status(500).json({ message: "Server error" });
    }
});

// --- GLOBAL MANAGEMENT MODULES ---
app.use('/api/branches', branchesRouter); 
app.use('/api/system/logs', systemLogsRouter); 
app.use('/api/system/backup', backupRestoreRouter); 
app.use('/api/feedback', feedbackRouter);
app.use('/api/utils', utilsRouter);
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
app.use('/api/notifications', notificationsRouter);
// Exam Modules
app.use('/api/exams', examsRouter); 
app.use('/api/online-exam', onlineExamRouter);
app.use('/api/marks', examMarksRouter); 
app.use('/api/quizzes', quizzesRouter); 
app.use('/api/report-card', reportCardRouter);
app.use('/api/certificates', certificatesRouter);
app.use('/api/assignments', assignmentsRouter);
app.use('/api/online-learning', onlineLearningRouter);

// Calendar Route
app.use('/api/calendar', calendarRoutes); 

// Transcript Route
app.use('/api/transcript', transcriptRoutes); 

// Finance Modules
app.use('/api/finance', feesRouter);      
app.use('/api/payments', paymentsRouter);
app.use('/api/invoices', invoicesRouter); 
app.use('/api/payroll', payrollRouter);

// HR & Operations
app.use('/api/staffhr', staffhrRouter);
app.use('/api/hr', hrDepartmentsRouter);
app.use('/api/transport', transportRouter);
app.use('/api/hostel', hostelRouter);
app.use('/api/cafeteria', cafeteriaRouter); 
app.use('/api/library', libraryRouter); 


app.use('/api/it-helpdesk', itHelpdeskRouter);

// General Modules
app.use('/api/enquiries', enquiriesRouter);
app.use('/api/activities', clubsEventsRouter);
app.use('/api/alumni', alumniRouter);
app.use('/api/discipline', disciplineRouter);
app.use('/api/compliance', complianceRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/health-records', healthRouter);


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
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'File too large' });
    }
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ success: false, message: 'Request Entity Too Large (Check server.js limits)' });
    }

    const statusCode = err.status || 500;
    res.status(statusCode).json({
        success: false,
        message: err.message || "Internal Server Error",
        error: process.env.NODE_ENV === 'development' ? err : {}
    });
});

// ===================================
// 7. CRON JOBS (Scheduled Tasks)
// ===================================
const cron = require('node-cron');

/**
 * 🛡️ AUTO-CLEANUP: প্রতি ঘণ্টার শুরুতে (0 মিনিটে) একবার এই চেকটি চলবে।
 * এটি চেক করবে কোন স্টুডেন্ট রেজিস্ট্রেশনের ২৪ ঘণ্টার মধ্যে পেমেন্ট করেনি।
 */
cron.schedule('0 * * * *', async () => {
    try {
        console.log('--- 🛡️ Running Student Account Expiry Check ---');
        
        // বর্তমান সময় থেকে ২৪ ঘণ্টা আগের সময় হিসাব করা
        const cutoffTime = new Date();
        cutoffTime.setHours(cutoffTime.getHours() - 24);

        /**
         * লজিক: 
         * ১. ইউজার রোল 'Student' হতে হবে।
         * ২. রেজিস্ট্রেশন করার পর ২৪ ঘণ্টা পার হয়ে গেছে।
         * ৩. এখনো পেমেন্ট করেনি (is_paid = false)।
         * ৪. স্ট্যাটাস অলরেডি 'expired' নয়।
         */
        const updateQuery = `
            UPDATE users 
            SET status = 'expired', is_active = false
            WHERE role = 'Student' 
            AND is_paid = false 
            AND status != 'expired'
            AND created_at < $1
        `;

        const result = await pool.query(updateQuery, [cutoffTime]);
        
        if (result.rowCount > 0) {
            console.log(`✅ Success: ${result.rowCount} জন স্টুডেন্টের আইডি মেয়াদ শেষ হওয়ায় বন্ধ করা হয়েছে।`);
        } else {
            console.log('ℹ️ No expired accounts found.');
        }
    } catch (err) {
        console.error('❌ Cron Job Error:', err);
    }
});



// ===================================
// 8. SERVER STARTUP
// ===================================
async function startServer() {
    try {
        UPLOAD_DIRS.forEach(dir => {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        });
        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }
        
        await initializeDatabase();
        console.log("✅ Database initialized successfully.");

        server.listen(PORT, () => {
            console.log(`🚀 Server running on http://localhost:${PORT}`);
            startNotificationService();
        });

    } catch (error) {
        console.error("❌ Critical Startup Failed:", error.message);
        process.exit(1);
    }
}

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await pool.end();
    process.exit(0);
});

cron.schedule('0 21 * * *', async () => {
    try {
        console.log('--- 📊 Starting Scheduled Daily Report Automation ---');
        await generateAndSendDailyReport();
        console.log('✅ Scheduled Report Task Completed.');
    } catch (err) {
        console.error('❌ Scheduled Report Task Failed:', err);
    }
});

startServer();