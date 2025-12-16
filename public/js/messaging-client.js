/**
 * js/messaging-client.js
 * ----------------------------------------------------
 * Final code integrating Auth, Socket.io, Role-based controls, 
 * and New Conversation Modal logic.
 */

// =========================================================
// 1. CONFIGURATION & STATE
// =========================================================

// --- API Endpoints ---
const API_BASE_URL = '/api/messaging';
const CONVERSATIONS_URL = `${API_BASE_URL}/conversations`;
const MESSAGES_URL = `${API_BASE_URL}/messages`;
const USERS_URL = '/api/users'; // For Admin search API: /api/users/search?q=...

// --- Global State ---
let currentConversationId = null;
let currentUserId = null; 
let currentUserRole = null;
let socket = null; 

// --- DOM Elements ---
const conversationList = document.getElementById('conversationList');
const messageDisplay = document.getElementById('messageDisplay');
const chatHeader = document.getElementById('chatHeader');
const messageInput = document.getElementById('messageInput');
const sendMessageBtn = document.getElementById('sendMessageBtn');
const newConversationBtn = document.getElementById('newConversationBtn'); 

// --- Modal Elements (Used only by Admin/Staff) ---
const newConversationModal = document.getElementById('newConversationModal');
const modalCloseBtn = newConversationModal ? newConversationModal.querySelector('.close-btn') : null;
const recipientSearchInput = document.getElementById('recipientSearchInput');
const searchResultList = document.getElementById('searchResultList');
const selectedRecipientsList = document.getElementById('selectedRecipientsList');
const startChatBtn = document.getElementById('startChatBtn');

// =========================================================
// 2. AUTHENTICATION & UTILITIES
// =========================================================

/**
 * Custom fetch wrapper including authentication headers.
 */
async function fetchWithAuth(url, options = {}) {
    const token = localStorage.getItem('erp-token');
    if (!token) {
        console.error('Authentication token not found. Cannot perform API call.');
        throw new Error('Authentication token not found.');
    }
    
    const sessionId = localStorage.getItem('active_session_id');
    
    const headers = { 
        'Authorization': `Bearer ${token}`,
        'X-Session-ID': sessionId || '',
        'Content-Type': 'application/json',
        ...options.headers
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ message: 'Server error.' }));
        console.error(`Fetch error from ${url}:`, errorBody);
        throw new Error(`Failed to fetch: ${errorBody.message}`);
    }

    return response.json();
}

/**
 * Renders a single message bubble in the display area.
 */
function renderMessage(message) {
    const isSender = message.sender_id === currentUserId;
    const messageElement = document.createElement('div');
    
    messageElement.classList.add('message-bubble', isSender ? 'sent' : 'received');
    
    const senderName = isSender ? 'You' : (message.sender_name || 'System');
    
    messageElement.innerHTML = `
        <div class="message-sender">${senderName}</div>
        <div class="message-content">${message.content}</div>
        <div class="message-timestamp">${new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
    `;
    messageDisplay.appendChild(messageElement);
    messageDisplay.scrollTop = messageDisplay.scrollHeight; 
}

// =========================================================
// 3. CORE MESSAGING LOGIC (REST API)
// =========================================================

/**
 * Loads all messages for a selected conversation.
 */
async function loadConversationMessages(conversationId, title) {
    if (conversationId === currentConversationId) return;

    // 1. Update DOM state
    chatHeader.textContent = title;
    messageDisplay.innerHTML = '<div style="text-align: center; padding: 20px;">Loading messages...</div>';
    messageInput.disabled = false;
    sendMessageBtn.disabled = false;
    
    // 2. Handle Socket.io room join/leave
    if (socket && currentConversationId) {
        socket.emit('leave_conversation', currentConversationId);
    }
    currentConversationId = conversationId;
    if (socket) {
        socket.emit('join_conversation', conversationId);
    }

    // 3. Fetch messages from API
    try {
        const messages = await fetchWithAuth(`${MESSAGES_URL}/${conversationId}`);
        
        messageDisplay.innerHTML = '';
        messages.forEach(renderMessage);

        if (messages.length === 0) {
             messageDisplay.innerHTML = '<div style="text-align: center; padding: 20px; color: #888;">No messages yet. Start the conversation!</div>';
        }

    } catch (error) {
        console.error('Failed to load messages:', error);
        messageDisplay.innerHTML = '<div style="text-align: center; padding: 20px; color: red;">Failed to load messages.</div>';
    }
}

/**
 * Fetches the user's list of conversations and renders them.
 */
async function fetchAndRenderConversations() {
    try {
        const conversations = await fetchWithAuth(CONVERSATIONS_URL);
        
        conversationList.innerHTML = '';
        
        if (conversations.length === 0) {
            conversationList.innerHTML = '<li style="padding: 15px; color: #888;">No conversations found.</li>';
            return;
        }

        conversations.forEach(conv => {
            const listItem = document.createElement('li');
            listItem.classList.add('conversation-item');
            listItem.setAttribute('data-id', conv.id);
            
            // Display the participant_name (which is the topic or the other user's name)
            listItem.textContent = conv.participant_name || conv.title || `Chat with ${conv.id.substring(0, 8)}`; 
            
            listItem.addEventListener('click', () => {
                document.querySelectorAll('.conversation-item').forEach(item => item.classList.remove('active'));
                listItem.classList.add('active');
                
                loadConversationMessages(conv.id, listItem.textContent);
            });

            conversationList.appendChild(listItem);
        });

    } catch (error) {
        console.error('Failed to fetch conversations:', error);
        conversationList.innerHTML = '<li style="padding: 15px; color: red;">Error loading chats.</li>';
    }
}

/**
 * Serves the POST request to the backend to create a new chat session.
 */
async function startNewConversation(recipientIds, topic = null) {
    
    // 🔥 CRITICAL FIX 1: Ensure the current user ID is included and unique.
    // The participants array MUST contain the creator's ID (currentUserId)
    const participants = [currentUserId, ...recipientIds].filter((value, index, self) => 
        self.indexOf(value) === index
    );
    
    const isGroup = recipientIds.length > 1;

    try {
        const newConversation = await fetchWithAuth(`${CONVERSATIONS_URL}/new`, {
            method: 'POST',
            body: JSON.stringify({
                participants: participants, // Send the fixed array
                topic: isGroup ? topic || 'Group Chat' : null,
                is_group: isGroup
            })
        });

        console.log('Conversation created:', newConversation);
        
        // Refresh and immediately load the new conversation
        await fetchAndRenderConversations();
        
        const displayTitle = newConversation.topic || newConversation.participant_name || 'New Chat';
        loadConversationMessages(newConversation.id, displayTitle);

        return newConversation;

    } catch (error) {
        console.error('Failed to start new conversation:', error);
        alert('Error: Could not start new conversation.');
        return null;
    }
}

// =========================================================
// 4. MESSAGE SENDING (SOCKET.IO)
// =========================================================

function sendMessage() {
    const content = messageInput.value.trim();
    if (!content || !currentConversationId || !currentUserId) {
        return; 
    }

    const message = {
        conversationId: currentConversationId,
        senderId: currentUserId,
        content: content,
    };

    // 1. Emit message to server
    if (socket) {
        socket.emit('new_message', message);
    } else {
        console.error('Socket connection not established.');
        return;
    }

    // 2. Display message immediately (optimistic update)
    renderMessage({ 
        ...message, 
        sender_id: currentUserId, 
        sender_name: 'You',
        timestamp: new Date().toISOString() 
    });
    
    // 3. Clear input field
    messageInput.value = '';
}

// =========================================================
// 5. SOCKET.IO SETUP
// =========================================================

function initSocket() {
    if (typeof io === 'undefined') {
        console.error("Socket.io library not loaded. Ensure <script src='/socket.io/socket.io.js'></script> is present.");
        return;
    }
    
    socket = io(); 

    socket.on('connect', () => {
        console.log('Socket connected:', socket.id);
        if (currentConversationId) {
            socket.emit('join_conversation', currentConversationId);
        }
    });

    socket.on('message_received', (message) => {
        if (message.conversation_id === currentConversationId) {
            renderMessage(message);
        } else {
            console.log(`New message received in conversation ${message.conversation_id}`);
            // TODO: Add logic to highlight the conversation in the list
        }
    });

    socket.on('disconnect', () => {
        console.warn('Socket disconnected.');
    });
}

// =========================================================
// 6. ADMIN-SPECIFIC LOGIC (MODAL)
// =========================================================

function initAdminControls() {
    // State to hold users selected for the new chat
    const selectedRecipients = new Map();

    const openModal = () => {
        console.log("Attempting to open New Conversation Modal."); // New Action Log

        // Reset state
        recipientSearchInput.value = '';
        searchResultList.innerHTML = '<p style="text-align: center; color: #888;">Start typing to search for recipients.</p>';
        selectedRecipients.clear();
        renderSelectedRecipients();
        startChatBtn.disabled = true;
        
        newConversationModal.style.display = 'flex';
        recipientSearchInput.focus();
    };

    const closeModal = () => {
        newConversationModal.style.display = 'none';
    };

    const renderSelectedRecipients = () => {
        selectedRecipientsList.innerHTML = '';
        if (selectedRecipients.size === 0) {
            selectedRecipientsList.innerHTML = '<li>No recipients selected.</li>';
        }
        selectedRecipients.forEach((user, id) => {
            // FIX 2: Use username if full_name is not available (to avoid 'null')
            const displayName = user.name || user.username || 'Unknown User'; 
            
            const tag = document.createElement('li');
            tag.classList.add('selected-recipient-tag');
            tag.textContent = `${displayName} (${user.role}) X`; // Display the fixed name/username
            
            tag.addEventListener('click', () => {
                selectedRecipients.delete(id);
                renderSelectedRecipients();
            });
            selectedRecipientsList.appendChild(tag);
        });
        startChatBtn.disabled = selectedRecipients.size === 0;
    };


    // 1. Initial Check (Checks if Admin/Staff AND if all DOM elements are present)
    if (currentUserRole === 'Student' || !newConversationBtn || !newConversationModal) {
        console.warn("Admin controls are disabled (Student role) or required DOM elements are missing.");
        return;
    }
    
    console.log("Admin Controls Initialized: New Message Button is Active."); // Success Log

    // 2. Event listeners
    newConversationBtn.addEventListener('click', openModal);
    modalCloseBtn.addEventListener('click', closeModal);
    window.addEventListener('click', (event) => {
        if (event.target === newConversationModal) {
            closeModal();
        }
    });

    // 3. Handle search input (API Call)
    let searchTimeout;
    recipientSearchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const query = recipientSearchInput.value.trim();
        if (query.length < 3) {
            searchResultList.innerHTML = '<p style="text-align: center; color: #888;">Keep typing...</p>';
            return;
        }

        searchTimeout = setTimeout(async () => {
            searchResultList.innerHTML = '<p style="text-align: center;">Searching...</p>';
            
            try {
                // IMPORTANT: Requires backend route GET /api/users/search?q=query
                const users = await fetchWithAuth(`${USERS_URL}/search?q=${query}`);
                
                searchResultList.innerHTML = '';
                if (users.length === 0) {
                    searchResultList.innerHTML = '<p style="text-align: center;">No users found.</p>';
                    return;
                }
                
                users.forEach(user => {
                    if (user.id === currentUserId) return; 
                    
                    // FIX 2: Use full_name or username for display
                    const displayName = user.full_name || user.username || 'Unknown User'; 

                    const item = document.createElement('div');
                    item.classList.add('user-search-item');
                    item.textContent = `${displayName} (${user.role})`; // Display the fixed name/username
                    
                    const addButton = document.createElement('button');
                    addButton.textContent = selectedRecipients.has(user.id) ? 'Selected' : 'Add';
                    addButton.disabled = selectedRecipients.has(user.id);
                    
                    addButton.addEventListener('click', () => {
                        // FIX 2: Store the display name (full_name or username)
                        selectedRecipients.set(user.id, { id: user.id, name: displayName, username: user.username, role: user.role });
                        addButton.textContent = 'Selected';
                        addButton.disabled = true;
                        renderSelectedRecipients();
                    });
                    
                    item.appendChild(addButton);
                    searchResultList.appendChild(item);
                });

            } catch (e) {
                console.error("User search failed:", e);
                searchResultList.innerHTML = '<p style="text-align: center; color: red;">Error searching users.</p>';
            }
        }, 500);
    });
    
    // 4. Handle starting the chat
    startChatBtn.addEventListener('click', async () => {
        const recipientIds = Array.from(selectedRecipients.keys());
        
        // Determine topic for group chats
        let topic = null;
        if (recipientIds.length > 1) {
             topic = prompt("Enter a topic/name for this group chat (Optional):") || 'Group Chat';
        }

        const success = await startNewConversation(recipientIds, topic);
        if (success) {
            closeModal(); // Close only on successful creation
        }
    });
}

// =========================================================
// 7. INITIALIZATION
// =========================================================

/**
 * Performs a robust check of user context and initializes all components.
 */
function initializeMessagingClient() {
    // 1. Set global state from localStorage
    // 🔥 CRITICAL FIX: Use the key names set by the current login.js
    currentUserId = localStorage.getItem('profile-id'); 
    currentUserRole = localStorage.getItem('user-role');
    
    if (!currentUserId || !currentUserRole) { 
        console.error("User context (ID or Role) missing. Please ensure you are logged in and localStorage is populated.");
        chatHeader.textContent = 'Login Required';
        messageDisplay.innerHTML = '<div style="text-align: center; padding: 50px; color: red;">ERROR: User session data is missing. Please log out and log back in.</div>';
        return;
    }

    // 2. Initialize core messaging components
    fetchAndRenderConversations();
    
    // 3. Initialize Socket.io
    initSocket();

    // 4. Set up event listeners for sending messages
    sendMessageBtn.addEventListener('click', sendMessage);
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendMessage();
        }
    });
    
    // 5. Initialize Admin/Staff controls
    initAdminControls();
}

document.addEventListener('DOMContentLoaded', initializeMessagingClient);