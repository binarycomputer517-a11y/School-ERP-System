const axios = require('axios');

// কনফিগারেশন
const API_URL = 'https://bcsm.org.in/wp-json/erp/v1/publish';
const SECRET_KEY = 'BcK23DTiUQiLFHGg0nVclXlx'; // সেই অ্যাপ পাসওয়ার্ডটিই আমরা কি (Key) হিসেবে ব্যবহার করছি

async function sendNotice() {
    try {
        console.log("নোটিশ পাঠানো হচ্ছে...");

        const response = await axios.post(API_URL, {
            // এখন পাসওয়ার্ড হেডারে না পাঠিয়ে আমরা বডিতে পাঠাচ্ছি
            secret_key: SECRET_KEY, 
            title: 'Final Node.js Integration Test',
            content: 'Success! We bypassed the server restrictions using a custom endpoint.',
            categories: [1]
        });

        console.log('✅ সফল! পোস্ট পাবলিশ হয়েছে।');
        console.log('Message:', response.data.message);
        console.log('Link:', response.data.link);

    } catch (error) {
        console.error('❌ ব্যর্থ হয়েছে!');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Error:', error.response.data);
        } else {
            console.error(error.message);
        }
    }
}

sendNotice();