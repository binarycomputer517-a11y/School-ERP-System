// manage-compliance.js

document.addEventListener('DOMContentLoaded', () => {
    // DOM elements
    const unmaskButton = document.getElementById('unmask_data_btn');
    const sensitiveFields = document.querySelectorAll('.sensitive-data');
    const maskingStatus = document.getElementById('masking_status');
    const currentRiskLevel = document.getElementById('current_risk_level');
    const refreshScoreButton = document.getElementById('refresh_score');

    // --- 1. Real-time Score Fetch (FIXED) ---
    function fetchComplianceScore() {
        // ⚠️ FIX: Changed 'authToken' to 'erp-token' to match your login.js
        const authToken = localStorage.getItem('erp-token'); 
        
        if (!authToken) {
            currentRiskLevel.textContent = "ত্রুটি: লগইন টোকেন নেই (401)";
            currentRiskLevel.style.color = 'red';
            return;
        }

        fetch('/api/compliance/risk_score', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}` 
            }
        })
        .then(response => {
            if (!response.ok) {
                if (response.status === 401) throw new Error("401: অনুমোদিত নয়। অনুগ্রহ করে লগইন করুন।");
                if (response.status === 403) throw new Error("403: এই ভূমিকার জন্য অ্যাক্সেস নিষিদ্ধ।");
                return response.text().then(text => { throw new Error(`HTTP Error ${response.status}: ${text}`); });
            }
            return response.json(); 
        })
        .then(data => {
            const riskLevel = data.overall_risk; 
            currentRiskLevel.textContent = riskLevel;
            currentRiskLevel.style.color = 
                riskLevel === 'HIGH' ? 'red' : riskLevel === 'MEDIUM' ? 'orange' : 'green';
            console.log("Risk score updated:", data);
        })
        .catch(error => {
            console.error("Error fetching risk score:", error.message);
            currentRiskLevel.textContent = `ত্রুটি: ${error.message.substring(0, 40)}...`;
            currentRiskLevel.style.color = 'red';
        });
    }

    // --- 2. Advanced Feature: Secure Data Unmasking Control (FIXED) ---
    unmaskButton.addEventListener('click', () => {
        
        // Step A: Get the record ID from the HTML
        const recordId = document.getElementById('sensitive_data_view').dataset.recordId;
        
        // ⚠️ FIX: Changed 'authToken' to 'erp-token' to match your login.js
        const authToken = localStorage.getItem('erp-token');

        // Step B: Get the Multi-Factor Authentication (MFA) token from the user
        const mfaToken = prompt("অনুগ্রহ করে আপনার 6-সংখ্যার MFA কোডটি লিখুন:");

        if (!mfaToken || mfaToken.length !== 6) {
            maskingStatus.textContent = "অস্বীকৃত। একটি বৈধ 6-সংখ্যার MFA কোড প্রয়োজন।";
            return;
        }

        if (!authToken) {
            maskingStatus.textContent = "ত্রুটি: অনুমোদিত নয় (লগইন টোকেন নেই)।";
            return;
        }

        maskingStatus.textContent = "সার্ভারের সাথে MFA কোড যাচাই করা হচ্ছে...";

        // Step C: Make a secure API call to fetch the actual sensitive data
        fetch('/api/compliance/unmask_data', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}` // Main auth token
            },
            body: JSON.stringify({
                recordId: recordId,
                mfaToken: mfaToken // Second factor token
            })
        })
        .then(response => {
            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    throw new Error("MFA কোডটি ভুল বা মেয়াদোত্তীর্ণ।");
                }
                throw new Error("সার্ভার থেকে ডেটা আনা যায়নি।");
            }
            return response.json();
        })
        .then(data => {
            // Step D: Success! Populate the fields with REAL data from the server
            maskingStatus.textContent = "ডেটা সফলভাবে উন্মোচন করা হয়েছে।";
            
            sensitiveFields.forEach(field => {
                const fieldId = field.dataset.fieldId; // e.g., "patient_name" or "ssn"
                if (data.sensitiveData[fieldId]) {
                    // Populate the field with the real data
                    field.textContent = data.sensitiveData[fieldId];
                }
            });

            // Step E: Re-mask the data after a short time (Security Requirement)
            setTimeout(() => {
                sensitiveFields.forEach(field => {
                    field.textContent = '**********'; // Re-mask
                });
                maskingStatus.textContent = "সময় শেষ, ডেটা মাস্ক করা হয়েছে।";
            }, 10000); // 10 seconds
        })
        .catch(error => {
            console.error("Unmasking error:", error.message);
            maskingStatus.textContent = `ত্রুটি: ${error.message}`;
            maskingStatus.style.color = 'red';
        });
    });

    // Initial load and event listeners
    fetchComplianceScore();
    refreshScoreButton.addEventListener('click', fetchComplianceScore);
});