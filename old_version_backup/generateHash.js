const bcrypt = require('bcrypt');
const saltRounds = 10;
const plainPassword = 'admin123'; // আপনি যে পাসওয়ার্ডটি মনে রাখতে চান

async function hashPassword() {
    try {
        const hash = await bcrypt.hash(plainPassword, saltRounds);
        console.log('Your password:', plainPassword);
        console.log('Your REAL hash (copy this):');
        console.log(hash);
    } catch (err) {
        console.error('Error hashing password:', err);
    }
}

hashPassword();