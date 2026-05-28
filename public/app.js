// Connect to WebSocket Server
const socket = io();

// DOM Element Selections
const statusBadge = document.getElementById('status-badge');
const statusText = statusBadge.querySelector('.status-text');
const logoutBtn = document.getElementById('logout-btn');

// Connection State Cards
const viewLoading = document.getElementById('connection-loading');
const viewScan = document.getElementById('connection-scan');
const viewReady = document.getElementById('connection-ready');
const viewDisconnected = document.getElementById('connection-disconnected');
const errorMessageText = document.getElementById('error-message-text');
const qrImage = document.getElementById('qr-image');
const reconnectBtn = document.getElementById('reconnect-btn');

// Rules & Configurations
const responderToggle = document.getElementById('responder-toggle');
const replyTemplateInput = document.getElementById('reply-template-input');
const saveTemplateBtn = document.getElementById('save-template-btn');
const saveSuccessMsg = document.getElementById('save-success-msg');

// Live Chat Stream Elements
const chatMessagesContainer = document.getElementById('chat-messages-container');
const chatEmptyState = document.getElementById('chat-empty-state');
const clearFeedBtn = document.getElementById('clear-feed-btn');

// Manual Outbound Form
const testPhoneInput = document.getElementById('test-phone');
const testMessageInput = document.getElementById('test-message');
const sendManualBtn = document.getElementById('send-manual-btn');

// Toasts
const errorToast = document.getElementById('error-toast');
const errorToastText = document.getElementById('error-toast-text');

// State Cache
let activeState = 'Disconnected';

/* --- Helper Functions --- */

// Toggle views based on connection state
function renderState(state, qrData = null) {
    activeState = state;
    
    // Reset views
    viewLoading.style.display = 'none';
    viewScan.style.display = 'none';
    viewReady.style.display = 'none';
    viewDisconnected.style.display = 'none';
    
    // Status Badge & Header Controls
    statusBadge.className = 'status-badge ' + state.toLowerCase();
    statusText.textContent = state;

    if (state === 'Ready') {
        logoutBtn.style.display = 'flex';
        viewReady.style.display = 'flex';
    } else {
        logoutBtn.style.display = 'none';
        
        if (state === 'Initializing') {
            viewLoading.style.display = 'flex';
        } else if (state === 'Scanning') {
            if (qrData) {
                qrImage.src = qrData;
                viewScan.style.display = 'flex';
            } else {
                viewLoading.style.display = 'flex';
            }
        } else if (state === 'Disconnected') {
            viewDisconnected.style.display = 'flex';
        }
    }
}

// Show temporary feedback toast
function showToast(message, isError = false) {
    if (isError) {
        errorToastText.textContent = message;
        errorToast.style.display = 'flex';
        setTimeout(() => {
            errorToast.style.display = 'none';
        }, 4000);
    } else {
        saveSuccessMsg.style.display = 'flex';
        setTimeout(() => {
            saveSuccessMsg.style.display = 'none';
        }, 3000);
    }
}

// Append messages to real-time chat monitor
function appendMessage(msg) {
    // Hide empty state if first message
    if (chatEmptyState) {
        chatEmptyState.style.display = 'none';
    }

    const bubbleWrapper = document.createElement('div');
    const isAutoReply = msg.senderName.includes('AI Auto-Responder');
    
    bubbleWrapper.className = `msg-bubble-wrapper ${msg.type}`;
    if (isAutoReply) {
        bubbleWrapper.classList.add('auto-reply');
    }

    bubbleWrapper.innerHTML = `
        <div class="msg-meta">${msg.senderName}</div>
        <div class="msg-bubble">
            ${msg.body.replace(/\n/g, '<br>')}
        </div>
        <div class="msg-time">${msg.timestamp}</div>
    `;

    chatMessagesContainer.appendChild(bubbleWrapper);
    
    // Auto-scroll to latest
    chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
}

/* --- WebSocket Listeners --- */

// Handle Server Status Synchronization
socket.on('status-update', (data) => {
    console.log('Status synced:', data);
    renderState(data.status, data.qr);
    if (data.error) {
        errorMessageText.textContent = `Reason: ${data.error}`;
        showToast(`Authentication issue: ${data.error}`, true);
    }
});

// Sync Auto Responder Checkbox
socket.on('responder-toggled', (enabled) => {
    responderToggle.checked = enabled;
});

// Sync Response Template Text
socket.on('sync-template', (template) => {
    replyTemplateInput.value = template;
});

// Sync Template Update Success
socket.on('template-updated', () => {
    showToast();
});

// Listen for incoming/outgoing chats
socket.on('new-message', (message) => {
    console.log('New message received from socket:', message);
    appendMessage(message);
});

// Listen for errors
socket.on('error-msg', (err) => {
    showToast(err, true);
});

/* --- UI Interactions & Event Binding --- */

// Toggle AI responder
responderToggle.addEventListener('change', () => {
    socket.emit('toggle-responder', responderToggle.checked);
});

// Save AI message template
saveTemplateBtn.addEventListener('click', () => {
    const text = replyTemplateInput.value.trim();
    if (!text) {
        showToast('Template cannot be empty!', true);
        return;
    }
    socket.emit('update-template', text);
});

// Manual logout/disconnect request
logoutBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to disconnect WhatsApp and remove your logged-in session?')) {
        renderState('Initializing');
        socket.emit('logout');
    }
});

// Manual outward test submit
sendManualBtn.addEventListener('click', () => {
    const to = testPhoneInput.value.trim();
    const message = testMessageInput.value.trim();

    if (activeState !== 'Ready') {
        showToast('Please link your WhatsApp account before sending messages!', true);
        return;
    }
    if (!to || !message) {
        showToast('Please enter both number and message!', true);
        return;
    }

    socket.emit('send-message', { to, message });
    testMessageInput.value = ''; // clear message input
});

// Reconnection trigger
reconnectBtn.addEventListener('click', () => {
    window.location.reload();
});

// Clear Chat Feed Screen
clearFeedBtn.addEventListener('click', () => {
    // Retain only elements that aren't the empty state
    chatMessagesContainer.innerHTML = '';
    
    // Re-insert empty state
    const emptyHtml = `
        <div id="chat-empty-state" class="empty-state-view">
            <div class="empty-icon">
                <i class="fa-solid fa-message-slash"></i>
            </div>
            <h3>No messages yet</h3>
            <p>Link your device, then send a message to the scanned WhatsApp number from another phone to see it appear here in real-time, accompanied by the bot's auto-reply!</p>
        </div>
    `;
    chatMessagesContainer.innerHTML = emptyHtml;
    // Cache empty state reference back
    chatEmptyState = document.getElementById('chat-empty-state');
});
