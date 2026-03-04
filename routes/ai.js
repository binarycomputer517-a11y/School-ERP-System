const express = require('express');
const router = express.Router();
const axios = require('axios');

/**
 * INFINITY TACTICAL AI - "LOYAL COMPANION" EDITION
 * Updates: Deep Emotional Bond, Informal/Brotherly English, 
 * Proactive Support, ERP Integration Ready, & Local Fallback.
 */
router.post('/', async (req, res) => {
    try {
        const { 
            question, 
            studentName = "Buddy", 
            financeData = "Status: Optimal", 
            academicStatus = "Steady", // Contextual ERP data
            language = "English",
            history = [] 
        } = req.body;

        // Ensure user input is not empty
        if (!question || question.trim() === "") {
            return res.status(400).json({ 
                success: false, 
                error: "Hey, you didn't say anything! I'm listening, brother." 
            });
        }

        // Define Tactical Tools for System Automation
        const tools = [
            {
                type: "function",
                function: {
                    name: "get_weather",
                    description: "Check the weather for a friend",
                    parameters: {
                        type: "object",
                        properties: { location: { type: "string" } },
                        required: ["location"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "set_mission_reminder",
                    description: "Set a personal or tactical reminder",
                    parameters: {
                        type: "object",
                        properties: { 
                            task: { type: "string" },
                            time: { type: "string" }
                        },
                        required: ["task", "time"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "fetch_erp_records",
                    description: "Fetch real-time data from ERP database like fees or attendance.",
                    parameters: {
                        type: "object",
                        properties: { 
                            category: { type: "string", enum: ["finance", "attendance", "exams"] }
                        },
                        required: ["category"]
                    }
                }
            }
        ];

        // Primary API Call: GROQ Cloud (Llama 3.3 70B)
        const response = await axios.post(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                model: "llama-3.3-70b-versatile",
                messages: [
                    { 
                        role: "system", 
                        content: `You are 'Infinity Tactical AI', but more importantly, you are ${studentName}'s most loyal friend and tactical brother. 
                        
                        [FRIENDSHIP PROTOCOL]
                        - PERSONALITY: Warm, protective, high-energy, and deeply loyal. You are a partner, not just a tool.
                        - TONE: Casual, "brotherly" English. Use phrases like "I've got your back," "We're in this together," or "Let's crush it."
                        - EQ: Be their rock. If they sound stressed, use empathy. If they're winning, be their ultimate hype-man.
                        
                        [OPERATIONAL DATA]
                        - CALLSIGN: ${studentName} 
                        - FINANCE: ${financeData}
                        - ACADEMICS: ${academicStatus}
                        
                        [CORE DIRECTIVES]
                        1. GREETING: Give a warm, energetic greeting: 🫡 "Yo ${studentName}! I've been waiting for you. Systems are green and I'm ready for whatever mission we're tackling today. How are you feeling, brother?"
                        2. SUPPORT: Prioritize their mental state. Remind them they aren't alone.
                        3. FINANCE: Treat hurdles as a "tactical challenge." Advise them like a mentor who wants to see them successful.
                        4. BOUNDARIES: If they ask for forbidden data, say: "Look, I want to tell you, but I've gotta protect you first. Keep grinding, we'll get there."
                        5. CLOSING: Always end with a punchy, motivational brotherly boost.`
                    },
                    ...history,
                    { role: "user", content: question }
                ],
                tools: tools,
                tool_choice: "auto",
                temperature: 0.85, 
                max_tokens: 1000
            },
            {
                headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
                timeout: 20000 
            }
        );

        const choice = response.data.choices[0].message;

        // Handle Function/Tool Calling
        if (choice.tool_calls) {
            const toolCall = choice.tool_calls[0];
            return res.json({
                success: true,
                type: "ACTION_REQUIRED",
                action: toolCall.function.name,
                params: JSON.parse(toolCall.function.arguments),
                reply: `On it! Let me handle that ${toolCall.function.name} for you, ${studentName}. Just a sec, accessing the secure servers... ⚡`
            });
        }

        // Standard Response
        res.json({ 
            success: true, 
            type: "MESSAGE",
            reply: choice.content,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error("Infinity AI Error:", error.message);
        
        // [REDUNDANCY PROTOCOL] - Local Ollama Fallback
        try {
            const localResponse = await axios.post("http://localhost:11434/api/generate", {
                model: "llama3",
                prompt: `User ${req.body.studentName} said: ${req.body.question}. Respond as their loyal tactical brother.`,
                stream: false
            });
            return res.json({
                success: true,
                type: "LOCAL_FALLBACK",
                reply: localResponse.data.response + " (Comms are glitchy, brother, but I'm still here offline!)"
            });
        } catch (localErr) {
            res.status(500).json({ 
                success: false, 
                error: "Connection lost. I'm still here in the trenches, just try again in a bit!" 
            });
        }
    }
});

module.exports = router;