/**
 * js/messaging-client.js - ULTIMATE ENTERPRISE EDITION
 * ----------------------------------------------------
 * Integrated: Multimedia (Upload & Voice), Read Receipts, Socket Sync, 
 * Group Topic Editing, Media Gallery, Dynamic Header, Emoji Picker,
 * Delete for Everyone, Live Search, Reply Mode, and Last Seen.
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
let replyingToId = null; 

// Multimedia Recording State
let mediaRecorder;
let audioChunks = [];

// DOM Elements
const conversationList = document.getElementById('conversationList');
const messageDisplay = document.getElementById('messageDisplay');
const chatHeader = document.getElementById('chatHeader');
const messageInput = document.getElementById('messageInput');
const sendMessageBtn = document.getElementById('sendMessageBtn');
const newConversationBtn = document.getElementById('newConversationBtn'); 
const typingBox = document.getElementById('typing') || document.createElement('div');
const mediaSidebar = document.getElementById('mediaGallery');
const mediaContent = document.getElementById('mediaContent');
const chatSearchInput = document.getElementById('chatSearchInput');

// Reply & Emoji UI Elements
const replyPreview = document.getElementById('replyPreview');
const replySenderName = document.getElementById('replySenderName');
const replyText = document.getElementById('replyText');
const emojiBtn = document.getElementById('emojiPickerBtn');
const emojiPickerContainer = document.getElementById('emojiPickerContainer');

// Modal Elements
const newConversationModal = document.getElementById('newConversationModal');
const modalCloseBtn = document.querySelector('.close-btn');
const recipientSearchInput = document.getElementById('recipientSearchInput');
const searchResultList = document.getElementById('searchResultList');
const startChatBtn = document.getElementById('startChatBtn');

// =========================================================
// 2. EMOJI PICKER LOGIC
// =========================================================

function initEmojiPicker() {
    if (!emojiBtn || !emojiPickerContainer) return;

    // Picmo Picker ইনিশিয়ালাইজ করা (নিশ্চিত করুন HTML-এ CDN আছে)
    try {
        const picker = picmo.createPicker({
            rootElement: emojiPickerContainer
        });

        // বাটন ক্লিক করলে পিকার শো/হাইড হবে
        emojiBtn.onclick = (e) => {
            e.stopPropagation();
            emojiPickerContainer.style.display = emojiPickerContainer.style.display === 'none' ? 'block' : 'none';
        };

        // ইমোজি সিলেক্ট করলে ইনপুট ফিল্ডে যোগ হবে
        picker.addEventListener('emoji:select', (selection) => {
            messageInput.value += selection.emoji;
            messageInput.focus();
        });

        // বাইরে ক্লিক করলে পিকার বন্ধ হবে
        document.addEventListener('click', (e) => {
            if (!emojiPickerContainer.contains(e.target) && e.target !== emojiBtn) {
                emojiPickerContainer.style.display = 'none';
            }
        });
    } catch (err) {
        console.error("Emoji Picker failed to load:", err);
    }
}

// =========================================================
// 3. AUTH & UTILS
// =========================================================

async function fetchWithAuth(url, options = {}) {
    const token = localStorage.getItem('erp-token');
    const headers = { 
        'Authorization': `Bearer ${token}`,
        ...options.headers
    };
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || 'API Error');
    }
    return response.json();
}

/**
 * Enhanced Rendering for Text, Voice, Images, and Replies
 */
function renderMessage(message) {
    const isSender = message.sender_id === currentUserId;
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message-bubble', isSender ? 'sent' : 'received');
    msgDiv.setAttribute('data-message-id', message.id);
    
    const isDeleted = message.deleted_at !== null;
    let contentHTML = isDeleted ? `<em>${message.content}</em>` : message.content;

    if (!isDeleted) {
        if (message.message_type === 'voice') {
            contentHTML = `
                <div class="voice-msg" onclick="playAudio('${message.file_url}', this)" style="cursor:pointer; display:flex; align-items:center; gap:10px;">
                    <i class="fas fa-play-circle fa-2x"></i>
                    <span>Voice Note</span>
                </div>`;
        } else if (message.message_type === 'image') {
            contentHTML = `<img src="${message.file_url}" style="max-width:100%; border-radius:8px; cursor:pointer;" onclick="window.open('${message.file_url}')" alt="Shared Image">`;
        }
    }

    let replyQuoteHTML = "";
    if (message.reply_to_content && !isDeleted) {
        replyQuoteHTML = `
            <div class="reply-quote p-2 mb-2 border-start border-primary border-4 bg-light rounded" style="font-size: 0.8rem; opacity: 0.8; cursor: pointer;">
                <strong class="d-block text-primary">${message.reply_to_sender || 'User'}</strong>
                <span class="text-truncate d-block">${message.reply_to_content}</span>
            </div>`;
    }

    let controlsHTML = "";
    if (!isDeleted) {
        const deleteBtn = isSender ? `<i class="fas fa-trash-alt ms-2 text-danger" style="cursor:pointer; font-size:0.75rem;" onclick="deleteMessageForEveryone('${message.id}')"></i>` : '';
        const replyBtn = `<i class="fas fa-reply ms-2 text-primary" style="cursor:pointer; font-size:0.75rem;" onclick="initReply('${message.id}', '${isSender ? 'You' : (message.sender_name || 'User')}', '${message.content}')"></i>`;
        controlsHTML = `<div class="message-controls d-flex gap-1 opacity-0 transition-all">${replyBtn}${deleteBtn}</div>`;
    }

    msgDiv.innerHTML = `
        <div class="message-sender">${isSender ? 'You' : (message.sender_name || 'System')}</div>
        ${replyQuoteHTML}
        <div class="message-content">${contentHTML}</div>
        <div class="message-timestamp d-flex align-items-center justify-content-end gap-1">
            ${new Date(message.timestamp || message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            ${controlsHTML}
        </div>
    `;
    messageDisplay.appendChild(msgDiv);
    messageDisplay.scrollTop = messageDisplay.scrollHeight;
}

function playAudio(url, element) {
    if (currentAudio) { 
        currentAudio.pause(); 
        const prevIcon = document.querySelector('.fa-pause-circle');
        if (prevIcon) prevIcon.className = 'fas fa-play-circle fa-2x';
    }
    const icon = element.querySelector('i');
    icon.className = 'fas fa-spinner fa-spin fa-2x';
    currentAudio = new Audio(url);
    currentAudio.play().then(() => {
        icon.className = 'fas fa-pause-circle fa-2x';
    }).catch(() => {
        icon.className = 'fas fa-play-circle fa-2x';
        alert("Audio playback failed.");
    });
    currentAudio.onended = () => icon.className = 'fas fa-play-circle fa-2x';
}

async function deleteMessageForEveryone(messageId) {
    if (!confirm("Delete this message for everyone?")) return;
    try {
        await fetchWithAuth(`${API_BASE_URL}/message/${messageId}`, { method: 'DELETE' });
    } catch (err) {
        alert("Failed to delete message.");
    }
}

// =========================================================
// 4. MULTIMEDIA HANDLERS (File & Voice)
// =========================================================

async function handleFileUpload(input) {
    const file = input.files[0];
    if (!file || !currentConversationId) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
        const res = await fetchWithAuth(`${API_BASE_URL}/upload`, {
            method: 'POST',
            body: formData
        });
        const payload = {
            conversationId: currentConversationId,
            senderId: currentUserId,
            content: file.name,
            message_type: file.type.startsWith('image/') ? 'image' : 'document',
            file_url: res.fileUrl
        };
        socket.emit('new_message', payload);
        renderMessage({ ...payload, sender_name: 'You', created_at: new Date() });
        input.value = ''; 
    } catch (e) { alert("Upload failed."); }
}

async function toggleVoiceRecording() {
    const micBtn = document.querySelector('.fa-microphone');
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        micBtn.style.color = "";
        return;
    }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const formData = new FormData();
            formData.append('file', audioBlob, 'voice-msg.webm');
            const res = await fetchWithAuth(`${API_BASE_URL}/upload`, {
                method: 'POST',
                body: formData
            });
            const payload = {
                conversationId: currentConversationId,
                senderId: currentUserId,
                content: 'Voice Message',
                message_type: 'voice',
                file_url: res.fileUrl
            };
            socket.emit('new_message', payload);
            renderMessage({ ...payload, sender_name: 'You', created_at: new Date() });
        };
        mediaRecorder.start();
        micBtn.style.color = "red";
    } catch (err) { alert("Mic access denied."); }
}

// =========================================================
// 5. CORE LOGIC & PRESENCE
// =========================================================

async function loadConversationMessages(conversationId, title, photoUrl = null, participantId = null) {
    if (conversationId === currentConversationId) return;
    const baseUrl = window.location.origin; 
    let finalPhoto = (photoUrl && photoUrl !== 'undefined' && photoUrl !== 'null' && photoUrl !== '') 
        ? (photoUrl.startsWith('http') ? photoUrl : `${baseUrl}/${photoUrl}`)
        : `https://ui-avatars.com/api/?name=${encodeURIComponent(title)}&background=random&color=fff&bold=true`;

    chatHeader.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
            <div style="display:flex; align-items:center; gap:12px;">
                <button id="mobileToggle" class="d-md-none border-0 bg-transparent"><i class="fas fa-bars"></i></button>
                <div class="position-relative">
                    <img src="${finalPhoto}" style="width:45px; height:45px; border-radius:50%; object-fit:cover; border:2px solid #007bff;">
                    <span id="active-dot" class="position-absolute bottom-0 end-0 rounded-circle border border-white" style="width:12px; height:12px; display:none;"></span>
                </div>
                <div>
                    <strong id="headerTitle" style="font-size:1.1em; display:block; color:#333;">${title}</strong>
                    <small id="header-status" style="font-size:0.8em; display:none;"></small>
                </div>
            </div>
            <button class="btn btn-sm btn-outline-primary" onclick="toggleMediaSidebar()"><i class="fas fa-images"></i> Gallery</button>
        </div>`;

    messageDisplay.innerHTML = '<div class="loader text-center p-5"><i class="fas fa-sync fa-spin"></i> Syncing...</div>';
    messageInput.disabled = false;
    sendMessageBtn.disabled = false;

    if (socket && currentConversationId) socket.emit('leave_conversation', currentConversationId);
    currentConversationId = conversationId;
    if (socket) socket.emit('join_conversation', conversationId);

    if (participantId) fetchUserPresence(participantId);
    loadMediaGallery(conversationId);
    fetchWithAuth(`${API_BASE_URL}/read/${conversationId}`, { method: 'PUT' }).catch(() => {});

    try {
        const messages = await fetchWithAuth(`${MESSAGES_URL}/${conversationId}`);
        messageDisplay.innerHTML = '';
        if (messages.length > 0) messages.forEach(renderMessage);
        else messageDisplay.innerHTML = '<div class="text-center p-5 opacity-50">No history found.</div>';
    } catch (error) {
        messageDisplay.innerHTML = '<div class="text-danger text-center p-5">Sync failed.</div>';
    }
}

async function fetchUserPresence(userId) {
    const statusText = document.getElementById('header-status');
    const dot = document.getElementById('active-dot');
    try {
        const data = await fetchWithAuth(`${API_BASE_URL}/user-status/${userId}`);
        statusText.style.display = 'block';
        dot.style.display = 'block';
        if (data.is_online) {
            statusText.innerHTML = '<i class="fas fa-circle" style="font-size:8px;"></i> Online Now';
            statusText.style.color = '#28a745';
            dot.style.backgroundColor = '#28a745';
        } else {
            const time = data.last_seen ? new Date(data.last_seen).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : 'Offline';
            statusText.innerText = `Last seen at ${time}`;
            statusText.style.color = '#6c757d';
            dot.style.backgroundColor = '#6c757d';
        }
    } catch (e) { console.error("Presence check failed"); }
}

window.toggleMediaSidebar = () => mediaSidebar && mediaSidebar.classList.toggle('active');

async function loadMediaGallery(conversationId) {
    if (!mediaContent) return;
    mediaContent.innerHTML = '<div class="text-center p-3"><i class="fas fa-spinner fa-spin"></i></div>';
    try {
        const media = await fetchWithAuth(`${API_BASE_URL}/media/${conversationId}`);
        mediaContent.innerHTML = media.length ? '' : '<p class="text-center small text-muted mt-3">No shared media.</p>';
        media.forEach(item => {
            const wrapper = document.createElement('div');
            wrapper.className = 'gallery-item';
            if (item.message_type === 'image') {
                wrapper.innerHTML = `<img src="${item.file_url}" class="media-thumb" onclick="window.open('${item.file_url}')" style="width:100%; aspect-ratio:1/1; object-fit:cover; border-radius:4px; cursor:pointer;">`;
            } else {
                wrapper.innerHTML = `<div class="media-thumb text-center p-2 border rounded" onclick="window.open('${item.file_url}')" style="cursor:pointer; background:#f8f9fa;"><i class="fas fa-file-alt fa-lg"></i><br><small>File</small></div>`;
            }
            mediaContent.appendChild(wrapper);
        });
    } catch (e) { mediaContent.innerHTML = '<small class="text-danger">Error loading gallery</small>'; }
}

// =========================================================
// 6. MESSAGE ACTIONS (REPLY & DELETE)
// =========================================================

window.initReply = (id, name, content) => {
    replyingToId = id;
    replyPreview.style.display = 'flex';
    replySenderName.innerText = `Replying to ${name}`;
    replyText.innerText = content;
    messageInput.focus();
};

window.cancelReply = () => {
    replyingToId = null;
    replyPreview.style.display = 'none';
};

// =========================================================
// 7. SOCKETS & SENDING
// =========================================================

function initSocket() {
    if (typeof io === 'undefined') return;
    const token = localStorage.getItem('erp-token');
    socket = io({ auth: { token }, reconnection: true, reconnectionAttempts: 5 }); 

    socket.on('message_received', (msg) => {
        if (msg.conversation_id === currentConversationId) {
            renderMessage(msg);
            fetchWithAuth(`${API_BASE_URL}/read/${currentConversationId}`, { method: 'PUT' });
        } else { fetchAndRenderConversations(); }
    });

    socket.on('message_deleted', (id) => {
        const el = document.querySelector(`[data-message-id="${id}"]`);
        if (el) {
            el.innerHTML = '<div class="message-content"><em>This message was deleted</em></div>';
        }
    });

    socket.on('user_typing', (data) => {
        if(data.conversationId === currentConversationId) {
            typingBox.style.display = 'block';
            typingBox.innerHTML = `<em>${data.senderName} is typing...</em>`;
        }
    });

    socket.on('user_stop_typing', () => typingBox.style.display = 'none');
}

function handleTyping() {
    if (!currentConversationId) return;
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
        message_type: 'text',
        reply_to_id: replyingToId 
    };
    socket.emit('new_message', payload);
    renderMessage({ ...payload, sender_name: 'You', created_at: new Date() });
    messageInput.value = '';
    cancelReply();
    socket.emit('stop_typing', currentConversationId);
}

// =========================================================
// 8. INBOX & ADMIN CONTROLS
// =========================================================

async function fetchAndRenderConversations() {
    try {
        const conversations = await fetchWithAuth(CONVERSATIONS_URL);
        conversationList.innerHTML = conversations.length ? '' : '<li class="p-3 text-center">No chats.</li>';
        conversations.forEach(conv => {
            const li = document.createElement('li');
            li.className = `conversation-item list-group-item list-group-item-action border-0 ${conv.id === currentConversationId ? 'active' : ''}`;
            const unreadCount = conv.unread_count > 0 ? `<span class="badge bg-danger rounded-pill">${conv.unread_count}</span>` : '';
            li.innerHTML = `
                <div class="d-flex justify-content-between align-items-center">
                    <div class="conv-info text-truncate">
                        <div class="fw-bold">${conv.participant_name || 'User'}</div>
                        <small class="text-muted">${conv.last_message_at ? new Date(conv.last_message_at).toLocaleDateString() : 'New'}</small>
                    </div>
                    ${unreadCount}
                </div>`;
            li.onclick = () => loadConversationMessages(conv.id, conv.participant_name, conv.participant_photo, conv.participant_id);
            conversationList.appendChild(li);
        });
    } catch (e) { console.error("Inbox load error", e); }
}

function initAdminControls() {
    if (currentUserRole === 'Student' || !newConversationBtn) return;
    newConversationBtn.onclick = () => {
        searchResultList.innerHTML = '';
        newConversationModal.style.display = 'flex';
        recipientSearchInput.value = '';
        startChatBtn.disabled = true;
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
                div.className = 'search-item d-flex justify-content-between p-2 border-bottom';
                div.innerHTML = `<span>${u.full_name}</span> <button class="btn btn-sm btn-primary rounded-pill px-3" onclick="startNewChat('${u.id}', '${u.full_name}', '${u.profile_image_path}')">Chat</button>`;
                searchResultList.appendChild(div);
            });
        } catch(err) { console.error("Search failed"); }
    };
}

window.startNewChat = async (id, name, photo) => {
    try {
        const res = await fetchWithAuth(`${CONVERSATIONS_URL}/new`, {
            method: 'POST',
            body: JSON.stringify({ targetUserId: id, initial_message: "Connection established." })
        });
        newConversationModal.style.display = 'none';
        await fetchAndRenderConversations();
        loadConversationMessages(res.id, name, photo, id);
    } catch(e) { alert("Failed to start chat."); }
};

// =========================================================
// 9. INITIALIZE
// =========================================================

function initializeMessagingClient() {
    currentUserId = localStorage.getItem('profile-id'); 
    currentUserRole = localStorage.getItem('user-role');
    const token = localStorage.getItem('erp-token');
    
    if (!currentUserId || !token) {
        if (!sessionStorage.getItem('redirecting')) {
            sessionStorage.setItem('redirecting', 'true');
            window.location.replace('/login.html'); 
        }
        return;
    }
    sessionStorage.removeItem('redirecting');

    fetchAndRenderConversations();
    initSocket();
    initAdminControls();
    initEmojiPicker(); // Emoji Picker সক্রিয় করা হলো

    document.getElementById('hiddenFile').addEventListener('change', function() { handleFileUpload(this); });
    document.querySelector('.fa-microphone').addEventListener('click', () => { toggleVoiceRecording(); });

    if (sendMessageBtn) sendMessageBtn.onclick = sendMessage;
    if (messageInput) {
        messageInput.onkeypress = (e) => { 
            if (e.key === 'Enter') {
                e.preventDefault();
                if (!messageInput.disabled) sendMessage(); 
            } else { handleTyping(); }
        };
    }

    if (chatSearchInput) {
        chatSearchInput.oninput = (e) => {
            const term = e.target.value.toLowerCase().trim();
            const items = conversationList.getElementsByClassName('conversation-item');
            Array.from(items).forEach(item => {
                const nameText = item.querySelector('.fw-bold').innerText.toLowerCase();
                item.style.display = nameText.includes(term) ? "" : "none";
            });
        };
    }
}
document.addEventListener('DOMContentLoaded', initializeMessagingClient);