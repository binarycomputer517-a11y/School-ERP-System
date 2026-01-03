/**
 * js/messaging-client.js - FINAL ENTERPRISE EDITION
 * ----------------------------------------------------
 * Integrated: Multimedia, Read Receipts, Socket Sync, 
 * Group Topic Editing, and Typing Indicators.
 */

// =========================================================
// 1. CONFIGURATION & STATE
// =========================================================
const API_BASE_URL = '/api/messaging';
const CONVERSATIONS_URL = `${API_BASE_URL}/conversations`;
const MESSAGES_URL = `${API_BASE_URL}/messages`;
const USERS_URL = '/api/users'; 

let currentConversationId = null;
let currentUserId = null; 
let currentUserRole = null;
let socket = null; 
let currentAudio = null;
let typingTimeout;

// DOM Elements
const conversationList = document.getElementById('conversationList');
const messageDisplay = document.getElementById('messageDisplay');
const chatHeader = document.getElementById('chatHeader');
const messageInput = document.getElementById('messageInput');
const sendMessageBtn = document.getElementById('sendMessageBtn');
const newConversationBtn = document.getElementById('newConversationBtn'); 
const typingBox = document.getElementById('typing') || document.createElement('div');

// Modal Elements
const newConversationModal = document.getElementById('newConversationModal');
const modalCloseBtn = newConversationModal?.querySelector('.close-btn');
const recipientSearchInput = document.getElementById('recipientSearchInput');
const searchResultList = document.getElementById('searchResultList');
const startChatBtn = document.getElementById('startChatBtn');

// =========================================================
// 2. AUTH & UTILS
// =========================================================

async function fetchWithAuth(url, options = {}) {
    const token = localStorage.getItem('erp-token');
    const headers = { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers
    };
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || 'API Error');
    }
    return response.json();
}

/**
 * Enhanced Rendering for Text, Voice, and Images
 */
function renderMessage(message) {
    const isSender = message.sender_id === currentUserId;
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message-bubble', isSender ? 'sent' : 'received');
    
    let contentHTML = message.content;

    if (message.message_type === 'voice') {
        contentHTML = `
            <div class="voice-msg" onclick="playAudio('${message.file_url}', this)" style="cursor:pointer; display:flex; align-items:center; gap:10px;">
                <i class="fas fa-play-circle fa-2x"></i>
                <span>Voice Note</span>
            </div>`;
    } else if (message.message_type === 'image') {
        contentHTML = `<img src="${message.file_url}" style="max-width:100%; border-radius:8px; cursor:pointer;" onclick="window.open('${message.file_url}')">`;
    }

    msgDiv.innerHTML = `
        <div class="message-sender">${isSender ? 'You' : (message.sender_name || 'System')}</div>
        <div class="message-content">${contentHTML}</div>
        <div class="message-timestamp">${new Date(message.timestamp || message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
    `;
    messageDisplay.appendChild(msgDiv);
    messageDisplay.scrollTop = messageDisplay.scrollHeight;
}

function playAudio(url, element) {
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    const icon = element.querySelector('i');
    const originalClass = icon.className;
    icon.className = 'fas fa-spinner fa-spin fa-2x';
    
    currentAudio = new Audio(url);
    currentAudio.play().then(() => {
        icon.className = 'fas fa-pause-circle fa-2x';
    }).catch(() => {
        icon.className = originalClass;
        alert("Audio playback failed.");
    });

    currentAudio.onended = () => icon.className = 'fas fa-play-circle fa-2x';
}

// =========================================================
// 3. CORE LOGIC & TOPIC EDIT
// =========================================================

async function loadConversationMessages(conversationId, title) {
    if (conversationId === currentConversationId) return;

    // Reset Header & Enable UI
    chatHeader.innerHTML = `${title} <i class="fas fa-edit topic-edit-icon" style="cursor:pointer; font-size:0.7em; margin-left:10px;" onclick="renameGroup('${conversationId}', '${title}')"></i>`;
    messageDisplay.innerHTML = '<div class="loader">Syncing messages...</div>';
    messageInput.disabled = false;
    sendMessageBtn.disabled = false;

    // Mark as Read
    fetchWithAuth(`${API_BASE_URL}/read/${conversationId}`, { method: 'PUT' }).catch(() => {});

    if (socket && currentConversationId) socket.emit('leave_conversation', currentConversationId);
    currentConversationId = conversationId;
    if (socket) socket.emit('join_conversation', conversationId);

    try {
        const messages = await fetchWithAuth(`${MESSAGES_URL}/${conversationId}`);
        messageDisplay.innerHTML = '';
        messages.length > 0 ? messages.forEach(renderMessage) : messageDisplay.innerHTML = '<p style="text-align:center; padding:20px; opacity:0.5;">No history found.</p>';
    } catch (error) {
        messageDisplay.innerHTML = '<div class="error">Failed to connect to chat server.</div>';
    }
}

/**
 * Group Rename Feature
 */
window.renameGroup = async (id, oldName) => {
    if (currentUserRole === 'Student') return;
    const newTopic = prompt("Enter new Group Topic:", oldName);
    if (newTopic && newTopic !== oldName) {
        try {
            await fetchWithAuth(`${CONVERSATIONS_URL}/${id}/topic`, {
                method: 'PUT',
                body: JSON.stringify({ topic: newTopic })
            });
            chatHeader.innerHTML = `${newTopic} <i class="fas fa-edit topic-edit-icon" style="cursor:pointer; font-size:0.7em; margin-left:10px;" onclick="renameGroup('${id}', '${newTopic}')"></i>`;
            fetchAndRenderConversations();
        } catch (e) { alert("Failed to rename."); }
    }
};

async function fetchAndRenderConversations() {
    try {
        const conversations = await fetchWithAuth(CONVERSATIONS_URL);
        conversationList.innerHTML = conversations.length ? '' : '<li class="p-3 text-center">No chats available.</li>';
        
        conversations.forEach(conv => {
            const li = document.createElement('li');
            li.className = `conversation-item ${conv.id === currentConversationId ? 'active' : ''}`;
            li.innerHTML = `
                <div class="conv-info">
                    <strong>${conv.participant_name || conv.title || 'Untitled'}</strong>
                    <small>${conv.last_message_at ? new Date(conv.last_message_at).toLocaleDateString() : 'New Chat'}</small>
                </div>`;
            li.onclick = () => loadConversationMessages(conv.id, conv.participant_name || conv.title);
            conversationList.appendChild(li);
        });
    } catch (e) { console.error("Inbox load error", e); }
}

// =========================================================
// 4. SOCKET & TYPING
// =========================================================

function initSocket() {
    if (typeof io === 'undefined') return;
    socket = io({ reconnection: true, reconnectionAttempts: 5 }); 

    socket.on('message_received', (msg) => {
        if (msg.conversation_id === currentConversationId) {
            renderMessage(msg);
            fetchWithAuth(`${API_BASE_URL}/read/${currentConversationId}`, { method: 'PUT' });
        } else {
            fetchAndRenderConversations();
        }
    });

    socket.on('user_typing', (data) => {
        if(data.conversationId === currentConversationId) {
            typingBox.style.display = 'block';
            typingBox.innerText = `${data.senderName} is typing...`;
        }
    });

    socket.on('user_stop_typing', () => { typingBox.style.display = 'none'; });
}

function handleTyping() {
    socket.emit('typing', { conversationId: currentConversationId, senderName: 'Someone' });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => socket.emit('stop_typing', currentConversationId), 3000);
}

function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !currentConversationId) return;

    const payload = {
        conversationId: currentConversationId,
        senderId: currentUserId,
        content: text,
        message_type: 'text'
    };

    socket.emit('new_message', payload);
    renderMessage({ ...payload, sender_name: 'You', timestamp: new Date().toISOString() });
    messageInput.value = '';
    socket.emit('stop_typing', currentConversationId);
}

// =========================================================
// 5. ADMIN MODAL & SEARCH
// =========================================================

function initAdminControls() {
    if (currentUserRole === 'Student' || !newConversationBtn) return;
    const selectedRecipients = new Map();

    newConversationBtn.onclick = () => {
        selectedRecipients.clear();
        searchResultList.innerHTML = '';
        newConversationModal.style.display = 'flex';
        recipientSearchInput.value = '';
        recipientSearchInput.focus();
    };

    modalCloseBtn.onclick = () => newConversationModal.style.display = 'none';

    recipientSearchInput.oninput = async (e) => {
        const q = e.target.value;
        if (q.length < 2) return;
        try {
            const users = await fetchWithAuth(`${USERS_URL}/search?q=${q}`);
            searchResultList.innerHTML = '';
            users.forEach(u => {
                if (u.id === currentUserId) return;
                const div = document.createElement('div');
                div.className = 'search-item';
                div.style = "padding:10px; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center;";
                div.innerHTML = `<span>${u.full_name} (${u.role})</span> <button class="btn btn-sm btn-primary" onclick="addRecipient('${u.id}', '${u.full_name}')">Add</button>`;
                searchResultList.appendChild(div);
            });
        } catch(err) { console.error("Search failed"); }
    };

    window.addRecipient = (id, name) => {
        selectedRecipients.set(id, name);
        startChatBtn.disabled = false;
        alert(`${name} added.`);
    };

    startChatBtn.onclick = async () => {
        const ids = Array.from(selectedRecipients.keys());
        try {
            const res = await fetchWithAuth(`${CONVERSATIONS_URL}/new`, {
                method: 'POST',
                body: JSON.stringify({ participants: [currentUserId, ...ids], is_group: ids.length > 1 })
            });
            newConversationModal.style.display = 'none';
            await fetchAndRenderConversations();
            loadConversationMessages(res.id, res.participant_name || 'New Chat');
        } catch(e) { alert("Failed to start chat."); }
    };
}

// =========================================================
// 6. INITIALIZE
// =========================================================
function initializeMessagingClient() {
    currentUserId = localStorage.getItem('profile-id'); 
    currentUserRole = localStorage.getItem('user-role');
    
    if (!currentUserId) {
        window.location.href = '/login.html';
        return;
    }

    fetchAndRenderConversations();
    initSocket();
    initAdminControls();

    sendMessageBtn.onclick = sendMessage;
    messageInput.onkeypress = (e) => { 
        if (e.key === 'Enter') sendMessage(); 
        else handleTyping();
    };
}

document.addEventListener('DOMContentLoaded', initializeMessagingClient);