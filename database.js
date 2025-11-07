// database.js

const { Pool } = require('pg');
const bcrypt = require('bcryptjs'); // Already fixed to bcryptjs
require('dotenv').config();

// ========================================================
// 1. Database Connection Pool
// ========================================================

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    // Use connectionString for environments like Render
    connectionString: process.env.DATABASE_URL, 
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => {
    console.log('Successfully connected to the PostgreSQL database.');
});

// ========================================================
// 2. Database Initialization Logic
// ========================================================

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin_password_123'; 
const ADMIN_ROLE = 'Admin';
const SALT_ROUNDS = 10;

/**
 * Ensures the necessary core tables and columns exist.
 */
async function initializeDatabase() {
    console.log("Starting database initialization...");

    const client = await pool.connect();
    try {
        // --- FIX 1: Ensure critical tables and columns exist ---

        // 1. Create or Update the 'users' table
        const createUsersTableQuery = `
            CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- Changed to UUID type
                username VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL,
                reference_id UUID NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                deleted_at TIMESTAMP WITH TIME ZONE NULL
            );
        `;
        await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'); // Ensure UUID extension is available
        await client.query(createUsersTableQuery);
        console.log("✅ 'users' table is ready.");
        
        // HOTFIX A: Check and add 'branch_id' column (Fixes Login Error 42703)
        await client.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                               WHERE table_name='users' AND column_name='branch_id') THEN
                    ALTER TABLE users ADD COLUMN branch_id VARCHAR(255) NULL;
                END IF;
            END
            $$;
        `);
        console.log("✅ 'users' table has 'branch_id' column.");


        // HOTFIX B: Create 'student_transport_assignments' table (Fixes Notification Service Error 42P01)
        const createTransportTableQuery = `
            CREATE TABLE IF NOT EXISTS student_transport_assignments (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                student_id UUID NOT NULL,
                bus_route_id UUID NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `;
        await client.query(createTransportTableQuery);
        console.log("✅ 'student_transport_assignments' table is ready.");


        // 2. Check and Create default admin user
        const checkUserQuery = 'SELECT id FROM users WHERE username = $1';
        const userCheck = await client.query(checkUserQuery, [ADMIN_USERNAME]);

        // ... (Admin creation logic remains the same)
        if (userCheck.rowCount === 0) {
            console.log(`Creating default admin user: ${ADMIN_USERNAME}`);
            const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS);
            
            // Note: Since 'branch_id' is now guaranteed to exist, we can ignore it in this insert
            const insertUserQuery = `
                INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3);
            `;
            await client.query(insertUserQuery, [ADMIN_USERNAME, hashedPassword, ADMIN_ROLE]);
            
            console.log(`✅ Default admin user created!
                Username: ${ADMIN_USERNAME}
                Password: ${ADMIN_PASSWORD} 
                *** PLEASE CHANGE THIS PASSWORD IMMEDIATELY AFTER LOGGING IN. ***`);
        } else {
            console.log("ℹ️ Default admin user already exists.");
        }
    } catch (err) {
        console.error("❌ FATAL ERROR during database initialization:", err);
        throw err; // Rethrow error to prevent server from starting in a bad state
    } finally {
        client.release(); // Release the client back to the pool
    }
}

// ========================================================
// 3. Exports
// ========================================================

module.exports = {
    pool,
    initializeDatabase
};