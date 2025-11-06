// database.js

const { Pool } = require('pg');
const bcrypt = require('bcrypt');
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
    // Use connectionString for environments like Heroku
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
const ADMIN_PASSWORD = 'admin_password_123'; // ⚠️ Change this immediately after first login
const ADMIN_ROLE = 'Admin';
const SALT_ROUNDS = 10;

/**
 * Ensures the 'users' table exists and creates a default admin user if one is not present.
 * This function is designed to be called once on application startup.
 */
async function initializeDatabase() {
    console.log("Starting database initialization...");

    const client = await pool.connect();
    try {
        // Define the SQL to create the users table
        // NOTE: This is the user table structure that you thought was deleted.
        // It will recreate it if it doesn't exist.
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL,
                reference_id INTEGER NULL
            );
        `;
        await client.query(createTableQuery);
        console.log("✅ 'users' table is ready.");

        // Check if the default admin user already exists
        const checkUserQuery = 'SELECT id FROM users WHERE username = $1';
        const userCheck = await client.query(checkUserQuery, [ADMIN_USERNAME]);

        if (userCheck.rowCount === 0) {
            // Create a new admin user if not found
            console.log(`Creating default admin user: ${ADMIN_USERNAME}`);
            const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS);
            
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