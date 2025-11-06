const bcrypt = require('bcrypt');
const saltRounds = 10;
const plainPassword = 'FinalPass123'; 

bcrypt.hash(plainPassword, saltRounds, function(err, hash) {
    console.log("New Login Hash:", hash);
    // Copy the output hash string ($2b$10$... ) for the next step.
});