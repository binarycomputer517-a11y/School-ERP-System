const { publishToWebsite } = require('../services/wordpressService');

// যখন এডমিন 'Publish Notice' বাটনে ক্লিক করবে
exports.createNotice = async (req, res) => {
    const { title, description, publishToWeb } = req.body;

    // ১. প্রথমে আপনার ডাটাবেসে সেভ করুন (PostgreSQL)
    // const newNotice = await pool.query(...)

    // ২. যদি ওয়েবসাইটে পাবলিশ করতে চায়
    if (publishToWeb) {
        const wpResult = await publishToWebsite(title, description);
        
        if (wpResult.success) {
            console.log("ওয়েবসাইটেও পাবলিশ হয়েছে!");
        }
    }

    res.json({ message: "Notice created successfully" });
};