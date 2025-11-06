const readline = require('readline');
const bcrypt = require('bcrypt');
const pool = require('./db');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function createAdmin() {
  try {
    const userCountResult = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'admin'");
    if (parseInt(userCountResult.rows[0].count) > 0) {
      console.log('An Admin user already exists. Setup is not required.');
      pool.end();
      rl.close();
      return;
    }

    console.log('--- Creating the First Admin User ---');
    rl.question('Enter Admin Username: ', (username) => {
      rl.question('Enter Admin Email: ', (email) => { // <-- ADDED EMAIL QUESTION
        rl.question('Enter Admin Password: ', async (password) => {
          if (!username || !password || !email) { // <-- ADDED EMAIL CHECK
            console.error('Username, email, and password cannot be empty.');
            rl.close();
            pool.end();
            return;
          }

          try {
            const salt = await bcrypt.genSalt(10);
            const password_hash = await bcrypt.hash(password, salt);

            // UPDATED THE INSERT STATEMENT TO INCLUDE EMAIL
            await pool.query(
              "INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, 'admin')",
              [username, email, password_hash] // <-- ADDED EMAIL TO THE VALUES
            );

            console.log('\n✅ Admin user created successfully!');
            console.log('You can now start the server and log in with these credentials.');
          } catch (dbError) {
            console.error('Error saving admin user to database:', dbError);
          } finally {
            rl.close();
            pool.end();
          }
        });
      });
    });

  } catch (err) {
    console.error('Error connecting to the database or checking users:', err);
    pool.end();
    rl.close();
  }
}

createAdmin();