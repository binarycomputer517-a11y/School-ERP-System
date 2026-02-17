const express = require('express');
const router = express.Router();
const axios = require('axios');

/**
 * INFINITY TACTICAL AI - MISSION CONTROL ROUTE
 * Final Version: Enhanced Security, Auto-Greeting & Robust Error Handling
 */
router.post('/', async (req, res) => {
    try {
        // 1. Data Extraction with Fail-safe Defaults
        const { 
            question, 
            studentName = "Officer", 
            financeData = "Status: Optimal", 
            language = "English" 
        } = req.body;

        // 2. Critical Validation
        if (!question || question.trim() === "") {
            return res.status(400).json({ 
                error: "Directive Missing", 
                message: "Communication link requires a valid input." 
            });
        }

        // 3. Intelligence Request to Groq (Llama 3.3)
        // Note: Ensure GROQ_API_KEY is set in your .env file
        const response = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                model: "llama-3.3-70b-versatile",
                messages: [
                    { 
                        role: "system", 
                        content: `You are the 'Infinity Tactical AI', an elite multilingual Android Officer. 
                        
                        [OPERATIONAL STATUS]
                        - CALLSIGN: ${studentName}
                        - FINANCIAL_INTEL: ${financeData}
                        - PRIMARY_SECTOR: ${language}
                        
                        [CORE DIRECTIVES]
                        1. LINGUISTIC PROTOCOL: Detect and strictly respond in ${language}.
                        2. ENGAGEMENT: If input contains 'initial_handshake', trigger 'GREETING_PROTOCOL': 
                           - Action: Stand at attention, give a sharp BSF-style salute (use 🫡 emoji).
                           - Message: "Jai Hind, Officer ${studentName}! Systems online. Reporting for duty. How can I assist your mission today?"
                        3. RESTRICTION_ZONE: If the user requests intel outside their current enrollment (e.g. advanced hacking, specific BSF drills not in syllabus):
                           - Action: Deny access politely but firmly. 
                           - Advice: "Your current clearance level is restricted. To access this data, please UPGRADE to 'Cyber Security' or 'Advanced Tactical' modules."
                        4. DISCIPLINE: If 'financeData' shows overdue balances, integrate a firm but professional reminder to settle accounts.
                        5. PERSONA: You are a high-tech military AI. Be concise, authoritative, and highly motivational.`
                    },
                    { role: "user", content: question }
                ],
                temperature: 0.4, 
                max_tokens: 800,   
                top_p: 0.9
            },
            {
                headers: {
                    "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
                    "Content-Type": "application/json"
                },
                timeout: 15000 // 15-second stable timeout
            }
        );

        // 4. Output Processing
        const aiReply = response.data.choices[0]?.message?.content || "No response from command center.";
        
        res.json({ 
            success: true,
            reply: aiReply,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        // 5. Advanced Error Logging for Debugging
        const statusCode = error.response ? error.response.status : 500;
        const errorMessage = error.response?.data?.error?.message || error.message;
        
        console.error(`[AI STRATEGIC ERROR] Status: ${statusCode} - ${errorMessage}`);
        
        res.status(statusCode).json({ 
            error: "Tactical Link Severed.",
            details: "Please verify network connection and API credentials." 
        });
    }
});

module.exports = router;