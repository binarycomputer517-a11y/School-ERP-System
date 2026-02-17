const axios = require('axios');

// কনফিগারেশন (এগুলো .env ফাইলে রাখলে আরও ভালো)
const WP_API_URL = 'https://bcsm.org.in/wp-json/erp/v1/publish';
const WP_SECRET_KEY = 'BcK23DTiUQiLFHGg0nVclXlx'; 

/**
 * ওয়ার্ডপ্রেসে নোটিশ পাঠানোর ফাংশন
 * @param {string} title - নোটিশের শিরোনাম
 * @param {string} content - নোটিশের বিস্তারিত
 * @param {number} categoryId - ক্যাটাগরি আইডি (ডিফল্ট: 1)
 */
async function publishToWebsite(title, content, categoryId = 1) {
    try {
        const response = await axios.post(WP_API_URL, {
            secret_key: WP_SECRET_KEY,
            title: title,
            content: content,
            categories: [categoryId]
        });

        if (response.data.success) {
            console.log('✅ Website Notice Published:', response.data.link);
            return { success: true, link: response.data.link };
        } else {
            return { success: false, error: 'Unknown Error' };
        }

    } catch (error) {
        console.error('❌ WordPress Publish Error:', error.message);
        return { success: false, error: error.message };
    }
}

module.exports = { publishToWebsite };