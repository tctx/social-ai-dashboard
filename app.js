require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const app = express();

// --- CONFIG ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const UNIPILE_DSN = process.env.UNIPILE_DSN?.startsWith('http') ? process.env.UNIPILE_DSN : `https://${process.env.UNIPILE_DSN}`; // e.g., https://api1.unipile.com:13111
const UNIPILE_TOKEN = process.env.UNIPILE_TOKEN; // From Unipile dashboard
let messages = []; // In-memory store for MVP; replace with DB later
let conversations = {}; // Group messages by chat_id for conversation view
let instagramAccountId = null; // Store connected IG account ID after auth
const processedMessages = new Set(); // Track processed provider_message_ids to avoid duplicates

// Session persistence functions
function saveSession() {
  if (instagramAccountId) {
    const sessionData = {
      instagramAccountId,
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync('./session.json', JSON.stringify(sessionData, null, 2));
    console.log('💾 Session saved to file');
  }
}

function loadSession() {
  try {
    if (fs.existsSync('./session.json')) {
      const sessionData = JSON.parse(fs.readFileSync('./session.json', 'utf8'));
      if (sessionData.instagramAccountId) {
        instagramAccountId = sessionData.instagramAccountId;
        console.log('📂 Session restored from file:', instagramAccountId);
        console.log('🕐 Session saved at:', sessionData.timestamp);
        return true;
      }
    }
  } catch (error) {
    console.log('❌ Failed to load session:', error.message);
  }
  return false;
}

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- UNIPILE AUTHENTICATION ---
app.post('/api/unipile/auth', async (req, res) => {
  const { username, password, twoFactorCode } = req.body;
  console.log('🔐 Authentication attempt for:', username);
  console.log('🔗 UNIPILE_DSN:', UNIPILE_DSN);
  console.log('🔑 UNIPILE_TOKEN present:', !!UNIPILE_TOKEN);
  console.log('⏰ Request started at:', new Date().toISOString());
  
  // Set a timeout for the entire operation
  const timeoutId = setTimeout(() => {
    console.log('⏰ Request timeout after 60 seconds');
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout - Instagram/Unipile taking too long' });
    }
  }, 60000);
  
  try {
    // Initial auth request
    console.log('📤 Sending auth request to Unipile...');
    
    const requestPayload = {
      provider: 'INSTAGRAM',
      username,
      password
    };
    console.log('📦 Request payload:', JSON.stringify(requestPayload, null, 2));
    
    // Try the correct endpoint - some Unipile instances use different paths
    const endpoint = `${UNIPILE_DSN}/api/v1/accounts`;
    console.log('🎯 Full endpoint URL:', endpoint);
    
    let authResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-KEY': UNIPILE_TOKEN,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Social-AI-Dashboard/1.0'
      },
      body: JSON.stringify(requestPayload)
    });
    
    console.log('📥 Response status:', authResponse.status);
    console.log('📥 Response headers:', Object.fromEntries(authResponse.headers.entries()));
    
    let authData = await authResponse.json();
    console.log('📄 Response data:', JSON.stringify(authData, null, 2));

    // Handle 2FA if required (status 201 with checkpoint)
    if ((authResponse.status === 201 || authResponse.status === 202) && authData.checkpoint) {
      console.log('🔐 2FA required, checkpoint type:', authData.checkpoint.type);
      if (!twoFactorCode) {
        return res.status(202).json({ checkpoint: true, account_id: authData.account_id });
      }
      
      console.log('📱 Submitting 2FA code:', twoFactorCode);
      console.log('📱 Account ID:', authData.account_id);
      
      const checkpointPayload = {
        provider: 'INSTAGRAM',
        account_id: authData.account_id,
        code: twoFactorCode
      };
      console.log('📱 2FA payload:', JSON.stringify(checkpointPayload, null, 2));
      
      const checkpointEndpoint = `${UNIPILE_DSN}/api/v1/accounts/checkpoint`;
      console.log('📱 2FA endpoint:', checkpointEndpoint);
      
      authResponse = await fetch(checkpointEndpoint, {
        method: 'POST',
        headers: {
          'X-API-KEY': UNIPILE_TOKEN,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Social-AI-Dashboard/1.0'
        },
        body: JSON.stringify(checkpointPayload)
      });
      
      console.log('📱 2FA response status:', authResponse.status);
      console.log('📱 2FA response headers:', Object.fromEntries(authResponse.headers.entries()));
      
      authData = await authResponse.json();
      console.log('📱 2FA response data:', JSON.stringify(authData, null, 2));
    }

    if (authResponse.status === 200 || authResponse.status === 201) {
      console.log('✅ Authentication successful!');
      console.log('⏰ Request completed at:', new Date().toISOString());
      clearTimeout(timeoutId);
      instagramAccountId = authData.account_id; // Store for sending messages
      saveSession(); // Save session to file
      res.json({ success: true, account_id: instagramAccountId });
    } else {
      console.log('❌ Authentication failed with status:', authResponse.status);
      console.log('❌ Error message:', authData.message || authData.detail || 'Auth failed');
      console.log('⏰ Request failed at:', new Date().toISOString());
      clearTimeout(timeoutId);
      res.status(authResponse.status).json({ error: authData.message || authData.detail || 'Auth failed' });
    }
  } catch (error) {
    console.log('💥 Exception during authentication:', error.message);
    console.log('💥 Full error:', error);
    console.log('⏰ Request errored at:', new Date().toISOString());
    clearTimeout(timeoutId);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// --- API ROUTES ---

// Unipile webhook for incoming Instagram DMs
app.post('/api/incoming', async (req, res) => {
  console.log('📨 Incoming webhook received at:', new Date().toISOString());
  
  // Parse the real Unipile webhook payload structure
  const { 
    message, 
    sender, 
    chat_id, 
    message_id, 
    event, 
    account_type, 
    provider_message_id, 
    account_id 
  } = req.body;
  
  console.log('📨 Event:', event, '| Account:', account_id, '| Sender:', sender?.attendee_name);
  console.log('📨 Provider Message ID:', provider_message_id);
  // console.log('📨 Full webhook payload:', JSON.stringify(req.body, null, 2)); // Commented to reduce log spam
  console.log('📨 Headers:', JSON.stringify(req.headers, null, 2));
  
  // Check if this is an Instagram message
  if (account_type && account_type !== 'INSTAGRAM') {
    console.log('❌ Unsupported platform:', account_type);
    return res.status(400).json({ error: 'Unsupported platform' });
  }

  const senderProviderId = sender?.attendee_provider_id;
  // Try to get a proper display name - check attendees array for the actual user name
  let senderName = sender?.attendee_name || sender?.attendee_provider_id || 'Unknown User';
  
  // If sender is just a number (user ID), try to find the real name in attendees
  if (senderName.match(/^\d+$/)) {
    const { attendees } = req.body;
    const realUser = attendees?.find(a => a.attendee_provider_id !== senderProviderId);
    if (realUser?.attendee_name) {
      senderName = realUser.attendee_name;
      console.log('📨 Found real user name:', senderName, 'instead of ID:', sender?.attendee_name);
    }
  }
  const messageText = message || '[Media]';

  // Check for duplicate messages using provider_message_id (the real Instagram message ID)
  if (processedMessages.has(provider_message_id)) {
    console.log('⚠️ Duplicate message detected, ignoring. Provider message ID:', provider_message_id);
    return res.json({ success: true, duplicate: true });
  }
  
  // Also check if we already have this exact message from this user in the last 30 seconds (additional safety)
  const recentDuplicate = messages.find(m => 
    m.text === messageText && 
    m.user === senderName && 
    (Date.now() - parseInt(m.id)) < 30000 // 30 seconds
  );
  
  if (recentDuplicate) {
    console.log('⚠️ Recent duplicate message detected, ignoring. User:', senderName, 'Text:', messageText.substring(0, 50));
    return res.json({ success: true, duplicate: true });
  }
  
  // Filter out messages sent BY the bot account (Ghost Runner)
  if (senderName === 'Ghost Runner' || senderProviderId === '17845578411552197') {
    console.log('🤖 Ignoring outbound message from bot account:', senderName);
    return res.json({ success: true, ignored: 'bot_message' });
  }
  
  console.log('📨 Processing Instagram DM from:', senderName);
  console.log('📨 Message content:', messageText);
  console.log('📨 Chat ID:', chat_id);
  console.log('📨 Message ID:', message_id);
  console.log('📨 Event type:', event);

  const msg = {
    id: Date.now().toString(),
    message_id, // Store Unipile message ID
    provider_message_id, // Store Instagram's actual message ID for duplicate detection
    account_id, // Store the account_id from webhook for sending responses
    platform: 'Instagram',
    user: senderName,
    text: messageText,
    chat_id,
    aiResponse: await generateAIResponse(messageText, 'Instagram'),
    history: []
  };
  
  console.log('📨 Created message:', JSON.stringify(msg, null, 2));
  messages.unshift(msg);
  
  // Add to conversations for threaded view - group by user, not chat_id
  // Use provider_chat_id (the Instagram conversation ID) as the primary key for grouping
  const { provider_chat_id } = req.body;
  const userKey = provider_chat_id || `${senderName}_${senderProviderId}`; // Use Instagram's conversation ID if available
  if (!conversations[userKey]) {
    conversations[userKey] = {
      chat_id, // Use the latest chat_id
      user: senderName,
      platform: 'Instagram',
      last_message_time: new Date().toISOString(),
      messages: [],
      all_chat_ids: [chat_id] // Track all chat_ids for this user
    };
  } else {
    // Update chat_id to the latest one and track all chat_ids
    conversations[userKey].chat_id = chat_id;
    if (!conversations[userKey].all_chat_ids.includes(chat_id)) {
      conversations[userKey].all_chat_ids.push(chat_id);
    }
  }
  
  // Add incoming customer message to conversation
  conversations[userKey].messages.push({
    id: msg.id,
    text: messageText,
    sender: 'customer',
    timestamp: new Date().toISOString(),
    type: 'incoming'
  });
  conversations[userKey].last_message_time = new Date().toISOString();
  
  processedMessages.add(provider_message_id); // Mark as processed to prevent duplicates
  console.log('📨 Total messages in queue:', messages.length);
  
  res.json({ success: true });
});

// Test endpoint to simulate incoming messages
app.post('/api/test-message', async (req, res) => {
  console.log('🧪 Test message endpoint called');
  const { text = 'Hello! What are your hours?', sender = 'test_user_123' } = req.body;
  
  const msg = {
    id: Date.now().toString(),
    platform: 'Instagram',
    user: sender,
    text: text,
    chat_id: 'test_chat_' + Date.now(),
    aiResponse: await generateAIResponse(text, 'Instagram'),
    history: []
  };
  
  messages.unshift(msg);
  console.log('🧪 Test message created:', JSON.stringify(msg, null, 2));
  
  res.json({ success: true, message: msg });
});

// Get all messages
app.get('/api/messages', (req, res) => {
  // Only log when message count changes to reduce spam
  if (!app.lastMessageCount || app.lastMessageCount !== messages.length) {
    console.log('📋 Messages requested, returning', messages.length, 'messages');
    app.lastMessageCount = messages.length;
  }
  res.json(messages);
});

// Get conversations for threaded view
app.get('/api/conversations', (req, res) => {
  const conversationList = Object.keys(conversations).map(key => ({
    ...conversations[key],
    conversation_id: key // Include the key for lookup
  })).sort((a, b) => new Date(b.last_message_time) - new Date(a.last_message_time));
  res.json(conversationList);
});

// Get specific conversation with full history
app.get('/api/conversations/:conversation_id', (req, res) => {
  const conversation = conversations[req.params.conversation_id];
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  res.json({
    ...conversation,
    conversation_id: req.params.conversation_id
  });
});

// Logout endpoint to disconnect Instagram account
app.post('/api/logout', async (req, res) => {
  console.log('🚪 Logout request received');
  
  if (!instagramAccountId) {
    console.log('❌ No active session to logout');
    return res.status(400).json({ error: 'No active session' });
  }
  
  try {
    console.log('📤 Sending logout request to Unipile for account:', instagramAccountId);
    
    const response = await fetch(`${UNIPILE_DSN}/api/v1/accounts/${instagramAccountId}`, {
      method: 'DELETE',
      headers: {
        'X-API-KEY': UNIPILE_TOKEN,
        'Accept': 'application/json'
      }
    });
    
    console.log('📥 Logout response status:', response.status);
    const responseData = await response.json();
    console.log('📄 Logout response data:', JSON.stringify(responseData, null, 2));
    
    if (response.ok) {
      console.log('✅ Successfully logged out from Unipile');
      instagramAccountId = null; // Clear the stored account ID
      
      // Clear the session file
      const fs = require('fs');
      const sessionFile = './session.json';
      if (fs.existsSync(sessionFile)) {
        fs.unlinkSync(sessionFile);
        console.log('🗑️ Session file deleted');
      }
      
      res.json({ success: true, message: 'Logged out successfully' });
    } else {
      console.log('❌ Failed to logout:', responseData);
      res.status(response.status).json({ error: responseData.message || responseData.detail || 'Failed to logout' });
    }
  } catch (error) {
    console.log('💥 Exception during logout:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Session status endpoint
app.get('/api/session-status', (req, res) => {
  res.json({ 
    connected: !!instagramAccountId,
    account_id: instagramAccountId 
  });
});

// Generate AI response endpoint for frontend
app.post('/api/generate-response', async (req, res) => {
  const { text, platform } = req.body;
  try {
    const aiResponse = await generateAIResponse(text, platform);
    res.json({ response: aiResponse });
  } catch (error) {
    console.error('Error generating AI response:', error);
    res.status(500).json({ error: 'Failed to generate response' });
  }
});

// Send response directly from conversation view
app.post('/api/send-conversation-response', async (req, res) => {
  const { conversation_id, chat_id, finalText } = req.body;
  
  if (!conversation_id || !chat_id || !finalText) {
    return res.status(400).json({ error: 'conversation_id, chat_id and finalText are required' });
  }
  
  // Find the conversation
  const conversation = conversations[conversation_id];
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  
  // Get the account_id from the conversation (use the latest customer message)
  const lastCustomerMessage = [...conversation.messages].reverse().find(m => m.sender === 'customer');
  if (!lastCustomerMessage) {
    return res.status(400).json({ error: 'No customer messages found in conversation' });
  }
  
  // Find the original message to get account_id
  const originalMessage = messages.find(m => m.chat_id === chat_id);
  if (!originalMessage) {
    return res.status(400).json({ error: 'Original message data not found' });
  }
  
  console.log('📤 Sending conversation response...');
  console.log('📤 Chat ID:', chat_id);
  console.log('📤 Account ID:', originalMessage.account_id);
  console.log('📤 Final text:', finalText);
  
  try {
    const formData = new FormData();
    formData.append('account_id', originalMessage.account_id);
    formData.append('text', finalText);
    
    const response = await fetch(`${UNIPILE_DSN}/api/v1/chats/${chat_id}/messages`, {
      method: 'POST',
      headers: {
        'X-API-KEY': UNIPILE_TOKEN,
        'Accept': 'application/json'
      },
      body: formData
    });
    
    console.log('📥 Send response status:', response.status);
    const responseData = await response.json();
    console.log('📄 Send response data:', JSON.stringify(responseData, null, 2));
    
    if (response.ok) {
      console.log('✅ Conversation message sent successfully!');
      
      // Add outbound message to conversation
      conversation.messages.push({
        id: `response_${Date.now()}`,
        text: finalText,
        sender: 'bot',
        timestamp: new Date().toISOString(),
        type: 'outgoing'
      });
      conversation.last_message_time = new Date().toISOString();
      
      res.json({ success: true });
    } else {
      console.log('❌ Failed to send conversation message:', responseData);
      res.status(response.status).json({ error: responseData.message || responseData.detail || 'Failed to send message' });
    }
  } catch (error) {
    console.log('💥 Exception during conversation send:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Check Unipile for messages (polling alternative to webhooks)
app.get('/api/fetch-messages', async (req, res) => {
  if (!instagramAccountId) {
    return res.status(400).json({ error: 'Instagram not connected' });
  }
  
  try {
    console.log('🔍 Fetching messages from Unipile for account:', instagramAccountId);
    const response = await fetch(`${UNIPILE_DSN}/api/v1/messages?account_id=${instagramAccountId}`, {
      headers: {
        'X-API-KEY': UNIPILE_TOKEN,
        'Accept': 'application/json'
      }
    });
    
    const data = await response.json();
    console.log('📨 Unipile messages response:', JSON.stringify(data, null, 2));
    res.json(data);
  } catch (error) {
    console.log('❌ Error fetching messages:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Regenerate AI response
app.post('/api/regenerate/:id', async (req, res) => {
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  msg.history.push({ action: 'Regenerated AI response' });
  msg.aiResponse = await generateAIResponse(msg.text, msg.platform);
  res.json(msg);
});

// Send final response to Instagram
app.post('/api/send/:id', async (req, res) => {
  console.log('📤 Send response request received for ID:', req.params.id);
  console.log('📤 Request body:', JSON.stringify(req.body, null, 2));
  
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) {
    console.log('❌ Message not found for ID:', req.params.id);
    return res.status(404).json({ error: 'Message not found' });
  }
  
  const { finalText } = req.body;
  if (!finalText) {
    console.log('❌ No finalText provided in request');
    return res.status(400).json({ error: 'finalText is required' });
  }

  if (!msg.account_id) {
    console.log('❌ No account_id in message - authentication required');
    return res.status(401).json({ error: 'Message missing account_id. Please reconnect your Instagram account.' });
  }

  console.log('📤 Sending response to Unipile...');
  console.log('📤 Account ID:', msg.account_id);
  console.log('📤 Chat ID:', msg.chat_id);
  console.log('📤 Final text:', finalText);

  try {
    // Create FormData for multipart/form-data as required by Unipile API
    const formData = new FormData();
    formData.append('account_id', msg.account_id);
    formData.append('text', finalText);
    
    console.log('📤 Form data fields:');
    console.log('📤 - account_id:', msg.account_id);
    console.log('📤 - text:', finalText);

    const response = await fetch(`${UNIPILE_DSN}/api/v1/chats/${msg.chat_id}/messages`, {
      method: 'POST',
      headers: {
        'X-API-KEY': UNIPILE_TOKEN,
        'Accept': 'application/json'
        // No Content-Type header - let fetch set it automatically for FormData
      },
      body: formData
    });
    
    console.log('📥 Send response status:', response.status);
    const responseData = await response.json();
    console.log('📄 Send response data:', JSON.stringify(responseData, null, 2));

    if (response.ok) {
      console.log('✅ Message sent successfully!');
  msg.history.push({ action: `Sent response: ${finalText}` });
      
      // Add outbound message to conversation - find by user
      const userKey = Object.keys(conversations).find(key => 
        conversations[key].all_chat_ids && conversations[key].all_chat_ids.includes(msg.chat_id)
      );
      if (userKey && conversations[userKey]) {
        conversations[userKey].messages.push({
          id: `response_${Date.now()}`,
          text: finalText,
          sender: 'bot',
          timestamp: new Date().toISOString(),
          type: 'outgoing'
        });
        conversations[userKey].last_message_time = new Date().toISOString();
      }
      
      messages = messages.filter(m => m.id !== msg.id); // Remove from inbox
  res.json({ success: true });
    } else {
      console.log('❌ Failed to send message:', responseData);
      res.status(response.status).json({ error: responseData.message || responseData.detail || 'Failed to send message' });
    }
  } catch (error) {
    console.log('💥 Exception during send:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- AI Generation Function ---
async function generateAIResponse(userMessage, platform) {
  const prompt = `You are the social media manager for a restaurant brand. The user asked on ${platform}: "${userMessage}". Reply on-brand, relevant, informative, timely.`;
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: prompt }],
      max_tokens: 100
    })
  });
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// --- FRONTEND ---
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Social Media AI Dashboard</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css">
  <style>
    body { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; }
    .sidebar { height: 90vh; overflow-y: auto; }
    .list-group-item { cursor: pointer; }
    .message-card { background: #fff; border-radius: 12px; box-shadow: 0 8px 25px rgba(0,0,0,0.15); }
    .main-container { background: rgba(255,255,255,0.95); border-radius: 15px; backdrop-filter: blur(10px); }
    
    /* Chat message styles */
    .chat-message { margin-bottom: 12px; clear: both; }
    .chat-message.incoming { text-align: left; }
    .chat-message.outgoing { text-align: right; }
    .message-bubble { display: inline-block; max-width: 70%; padding: 10px 14px; border-radius: 18px; word-wrap: break-word; }
    .message-bubble.incoming { background-color: #e9ecef; color: #333; border-bottom-left-radius: 4px; }
    .message-bubble.outgoing { background-color: #007bff; color: white; border-bottom-right-radius: 4px; }
    .message-time { font-size: 0.75rem; color: #6c757d; margin-top: 4px; }
    .chat-container { scroll-behavior: smooth; }
    .connect-btn { 
      background: linear-gradient(45deg, #E1306C, #F56040, #F77737, #FCAF45, #FFDC80); 
      border: none; 
      color: white;
      font-weight: 600;
      padding: 12px 24px;
      border-radius: 25px;
      transition: all 0.3s ease;
    }
    .connect-btn:hover { 
      transform: translateY(-2px); 
      box-shadow: 0 8px 20px rgba(225,48,108,0.4);
      color: white;
    }
    .modal-content { border-radius: 20px; border: none; box-shadow: 0 20px 40px rgba(0,0,0,0.3); }
    .modal-header { background: linear-gradient(45deg, #E1306C, #F56040); color: white; border-radius: 20px 20px 0 0; }
    .form-control { border-radius: 10px; border: 2px solid #e9ecef; padding: 12px 16px; }
    .form-control:focus { border-color: #E1306C; box-shadow: 0 0 0 0.2rem rgba(225,48,108,0.25); }
    .btn-instagram { 
      background: linear-gradient(45deg, #E1306C, #F56040); 
      border: none; 
      color: white;
      font-weight: 600;
      padding: 12px 24px;
      border-radius: 10px;
      width: 100%;
    }
    .btn-instagram:hover { 
      background: linear-gradient(45deg, #c42a5c, #e55536); 
      color: white;
    }
    .connection-status { 
      display: inline-flex; 
      align-items: center; 
      padding: 8px 16px; 
      border-radius: 20px; 
      font-weight: 600;
    }
    .status-connected { background: linear-gradient(45deg, #56ab2f, #a8e6cf); color: white; }
    .status-disconnected { background: linear-gradient(45deg, #ff6b6b, #ffa8a8); color: white; }
  </style>
</head>
<body>
  <!-- Navbar -->
  <nav class="navbar navbar-dark" style="background: linear-gradient(45deg, #E1306C, #F56040);">
    <div class="container-fluid">
      <span class="navbar-brand mb-0 h1">🍔 Social AI Dashboard</span>
      <div class="d-flex align-items-center">
        <span id="connectionStatus" class="connection-status status-disconnected me-3">
          <i class="bi bi-instagram me-2"></i>Not Connected
        </span>
        <button id="testMessageBtn" class="btn btn-outline-light me-2" onclick="sendTestMessage()" style="display: none;">
          <i class="bi bi-chat-dots me-2"></i>Test Message
        </button>
        <button id="connectBtn" class="connect-btn" data-bs-toggle="modal" data-bs-target="#instagramModal">
          <i class="bi bi-instagram me-2"></i>Connect Instagram
        </button>
        <button id="logoutBtn" class="btn btn-outline-danger ms-2" onclick="logoutInstagram()" style="display: none;">
          <i class="bi bi-box-arrow-right me-2"></i>Logout
        </button>
      </div>
    </div>
  </nav>

  <!-- Main Content -->
  <div class="container-fluid mt-4">
    <div class="main-container p-4">
      <div class="row">
        <!-- Sidebar -->
        <div class="col-md-4 border-end sidebar">
          <div class="p-3 border-bottom">
            <div class="btn-group w-100" role="group">
              <button type="button" class="btn btn-outline-primary active" id="inboxTab" onclick="switchView('inbox')">
                <i class="bi bi-inbox me-1"></i>Inbox
              </button>
              <button type="button" class="btn btn-outline-primary" id="conversationsTab" onclick="switchView('conversations')">
                <i class="bi bi-chat-dots me-1"></i>Chats
              </button>
            </div>
          </div>
          <div id="messageList" class="list-group"></div>
          <div id="conversationList" class="list-group" style="display: none;"></div>
        </div>

        <!-- Main Panel -->
        <div class="col-md-8 p-4">
          <div id="mainPanel" class="text-muted text-center">
            <i class="bi bi-chat-dots" style="font-size: 4rem; opacity: 0.3;"></i>
            <h4 class="mt-3">Select a message or conversation to view details</h4>
            <p>Connect your Instagram account to start managing DMs</p>
          </div>
          
          <!-- Conversation View -->
          <div id="conversationView" class="d-none">
            <div class="d-flex justify-content-between align-items-center mb-3 pb-3 border-bottom">
              <div>
                <h5 class="mb-0" id="conversationTitle">Conversation</h5>
                <small class="text-muted" id="conversationInfo">Instagram</small>
              </div>
              <button class="btn btn-outline-secondary btn-sm" onclick="closeConversation()">
                <i class="bi bi-x-lg"></i>
              </button>
            </div>
            
            <!-- Chat Messages -->
            <div id="chatMessages" class="chat-container mb-3" style="height: 400px; overflow-y: auto; border: 1px solid #dee2e6; border-radius: 8px; padding: 15px; background-color: #f8f9fa;">
              <!-- Messages will be loaded here -->
            </div>
            
            <!-- Response Area -->
            <div class="response-area">
              <div class="mb-3">
                <label class="form-label fw-bold">AI Response</label>
                <textarea id="conversationResponse" class="form-control" rows="3" placeholder="AI-generated response will appear here..."></textarea>
              </div>
              <div class="d-flex gap-2">
                <button class="btn btn-success" onclick="regenerateConversationResponse()">
                  <i class="bi bi-arrow-clockwise me-1"></i>Regenerate
                </button>
                <button class="btn btn-primary" onclick="sendConversationResponse()">
                  <i class="bi bi-send me-1"></i>Send Response
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Instagram Auth Modal -->
  <div class="modal fade" id="instagramModal" tabindex="-1" aria-labelledby="instagramModalLabel" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title" id="instagramModalLabel">
            <i class="bi bi-instagram me-2"></i>Connect Instagram Account
          </h5>
          <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>
        <div class="modal-body p-4">
          <div class="text-center mb-4">
            <div class="d-inline-flex align-items-center justify-content-center" style="width: 80px; height: 80px; background: linear-gradient(45deg, #E1306C, #F56040); border-radius: 50%;">
              <i class="bi bi-instagram text-white" style="font-size: 2.5rem;"></i>
            </div>
            <h6 class="mt-3 text-muted">Securely connect your Instagram business account</h6>
          </div>
          
          <form id="authForm">
            <div class="mb-3">
              <label for="username" class="form-label fw-bold">
                <i class="bi bi-person me-2"></i>Username
              </label>
              <input type="text" class="form-control" id="username" placeholder="your_username" required>
            </div>
            <div class="mb-3">
              <label for="password" class="form-label fw-bold">
                <i class="bi bi-lock me-2"></i>Password
              </label>
              <input type="password" class="form-control" id="password" placeholder="••••••••" required>
            </div>
            <div class="mb-3" id="twoFactor" style="display: none;">
              <label for="twoFactorCode" class="form-label fw-bold">
                <i class="bi bi-shield-check me-2"></i>2FA Code
              </label>
              <input type="text" class="form-control" id="twoFactorCode" placeholder="123456">
              <div class="form-text">Enter the 6-digit code from your authenticator app</div>
            </div>
            <button type="submit" class="btn btn-instagram">
              <i class="bi bi-link-45deg me-2"></i>Connect Account
            </button>
          </form>
          
          <div id="authStatus" class="mt-3 text-center"></div>
          
          <div class="mt-4 p-3 bg-light rounded">
            <small class="text-muted">
              <i class="bi bi-shield-lock me-2"></i>
              Your credentials are encrypted and never stored. We use them only to establish a secure connection with Instagram.
            </small>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    let allMessages = [];
    let selectedId = null;
    let isConnected = false;

    // Handle auth form submission
    document.getElementById('authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const twoFactorCode = document.getElementById('twoFactorCode').value;
      const authStatus = document.getElementById('authStatus');
      const submitBtn = e.target.querySelector('button[type="submit"]');
      
      // Show loading state
      const startTime = Date.now();
      submitBtn.innerHTML = '<i class="bi bi-hourglass-split me-2"></i>Connecting...';
      submitBtn.disabled = true;
      
      // Show progress indicator
      authStatus.innerHTML = '<div class="alert alert-info"><i class="bi bi-hourglass-split me-2"></i>Connecting to Instagram... This may take 10-30 seconds.</div>';
      
      try {
        const res = await fetch('/api/unipile/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, twoFactorCode })
        });
        const data = await res.json();
        
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        
        if (res.status === 202) {
          document.getElementById('twoFactor').style.display = 'block';
          authStatus.innerHTML = \`<div class="alert alert-info"><i class="bi bi-info-circle me-2"></i>2FA required! Enter the 6-digit code from your authenticator app. <small>(took \${elapsed}s)</small></div>\`;
          submitBtn.innerHTML = '<i class="bi bi-shield-check me-2"></i>Verify Code';
        } else if (data.success) {
          authStatus.innerHTML = \`<div class="alert alert-success"><i class="bi bi-check-circle me-2"></i>Instagram connected successfully! <small>(took \${elapsed}s)</small></div>\`;
          updateConnectionStatus(true);
          setTimeout(() => {
            bootstrap.Modal.getInstance(document.getElementById('instagramModal')).hide();
          }, 1500);
        } else {
          authStatus.innerHTML = \`<div class="alert alert-danger"><i class="bi bi-exclamation-triangle me-2"></i>\${data.error || 'Authentication failed'} <small>(took \${elapsed}s)</small></div>\`;
        }
      } catch (error) {
        authStatus.innerHTML = \`<div class="alert alert-danger"><i class="bi bi-exclamation-triangle me-2"></i>\${error.message}</div>\`;
      } finally {
        submitBtn.innerHTML = '<i class="bi bi-link-45deg me-2"></i>Connect Account';
        submitBtn.disabled = false;
      }
    });

    function updateConnectionStatus(connected) {
      isConnected = connected;
      const statusElement = document.getElementById('connectionStatus');
      const connectBtn = document.getElementById('connectBtn');
      const logoutBtn = document.getElementById('logoutBtn');
      const testBtn = document.getElementById('testMessageBtn');
      
      if (connected) {
        statusElement.innerHTML = '<i class="bi bi-check-circle me-2"></i>Connected';
        statusElement.className = 'connection-status status-connected';
        connectBtn.style.display = 'none';
        logoutBtn.style.display = 'inline-block';
        testBtn.style.display = 'inline-block';
      } else {
        statusElement.innerHTML = '<i class="bi bi-x-circle me-2"></i>Not Connected';
        statusElement.className = 'connection-status status-disconnected';
        connectBtn.style.display = 'inline-block';
        logoutBtn.style.display = 'none';
        testBtn.style.display = 'none';
      }
    }

    async function sendTestMessage() {
      console.log('Sending test message...');
      try {
        const response = await fetch('/api/test-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            text: 'Hello! What are your hours today?', 
            sender: 'test_customer_' + Date.now()
          })
        });
        const data = await response.json();
        console.log('Test message sent:', data);
        loadMessages(); // Refresh the message list
      } catch (error) {
        console.error('Error sending test message:', error);
      }
    }

    async function logoutInstagram() {
      if (!confirm('Are you sure you want to logout? This will disconnect your Instagram account.')) {
        return;
      }
      
      console.log('Logging out...');
      try {
        const response = await fetch('/api/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        
        const data = await response.json();
        
        if (response.ok) {
          updateConnectionStatus(false);
          alert('Successfully logged out!');
          console.log('Logout successful');
          
          // Clear any cached messages
          allMessages = [];
          allConversations = [];
          loadMessages();
          if (currentView === 'conversations') {
            loadConversations();
          }
        } else {
          alert('Failed to logout: ' + (data.error || 'Unknown error'));
          console.error('Logout failed:', data.error);
        }
      } catch (error) {
        console.error('Error during logout:', error);
        alert('Error during logout: ' + error.message);
      }
    }

    // View switching
    let currentView = 'inbox';
    let allConversations = [];
    let currentConversation = null;
    
    function switchView(view) {
      currentView = view;
      document.getElementById('inboxTab').classList.toggle('active', view === 'inbox');
      document.getElementById('conversationsTab').classList.toggle('active', view === 'conversations');
      document.getElementById('messageList').style.display = view === 'inbox' ? 'block' : 'none';
      document.getElementById('conversationList').style.display = view === 'conversations' ? 'block' : 'none';
      
      if (view === 'conversations') {
        loadConversations();
      }
      
      // Hide conversation view when switching views
      closeConversation();
    }
    
    async function loadConversations() {
      const res = await fetch('/api/conversations');
      allConversations = await res.json();
      renderConversationList();
    }
    
    function renderConversationList() {
      const list = document.getElementById('conversationList');
      list.innerHTML = allConversations.map(conv => {
        const lastMessage = conv.messages[conv.messages.length - 1];
        const preview = lastMessage ? lastMessage.text.substring(0, 50) + '...' : 'No messages';
        const time = new Date(conv.last_message_time).toLocaleString();
        
        return \`
          <div class="list-group-item" onclick="openConversation('\${conv.conversation_id}')">
            <div class="d-flex justify-content-between">
              <h6 class="mb-1">\${conv.platform} — \${conv.user}</h6>
              <small>\${time}</small>
            </div>
            <p class="mb-1">\${preview}</p>
            <small class="text-muted">\${conv.messages.length} messages</small>
          </div>
        \`;
      }).join('');
    }
    
    async function openConversation(chatId) {
      const res = await fetch(\`/api/conversations/\${chatId}\`);
      currentConversation = await res.json();
      
      document.getElementById('mainPanel').classList.add('d-none');
      document.getElementById('conversationView').classList.remove('d-none');
      
      document.getElementById('conversationTitle').textContent = \`\${currentConversation.platform} — \${currentConversation.user}\`;
      document.getElementById('conversationInfo').textContent = \`\${currentConversation.messages.length} messages\`;
      
      renderChatMessages();
      
      // Generate AI response for the last customer message
      const lastCustomerMessage = [...currentConversation.messages].reverse().find(m => m.sender === 'customer');
      if (lastCustomerMessage) {
        document.getElementById('conversationResponse').value = await generateAIResponse(lastCustomerMessage.text, currentConversation.platform);
      }
    }
    
    function renderChatMessages() {
      const container = document.getElementById('chatMessages');
      container.innerHTML = currentConversation.messages.map(msg => {
        const isOutgoing = msg.sender === 'bot';
        const time = new Date(msg.timestamp).toLocaleTimeString();
        
        return \`
          <div class="chat-message \${isOutgoing ? 'outgoing' : 'incoming'}">
            <div class="message-bubble \${isOutgoing ? 'outgoing' : 'incoming'}">
              \${msg.text}
            </div>
            <div class="message-time">\${time}</div>
          </div>
        \`;
      }).join('');
      
      // Scroll to bottom
      container.scrollTop = container.scrollHeight;
    }
    
    function closeConversation() {
      currentConversation = null;
      document.getElementById('conversationView').classList.add('d-none');
      document.getElementById('mainPanel').classList.remove('d-none');
    }
    
    async function regenerateConversationResponse() {
      if (!currentConversation) return;
      
      const lastCustomerMessage = [...currentConversation.messages].reverse().find(m => m.sender === 'customer');
      if (lastCustomerMessage) {
        document.getElementById('conversationResponse').value = 'Generating...';
        document.getElementById('conversationResponse').value = await generateAIResponse(lastCustomerMessage.text, currentConversation.platform);
      }
    }
    
    async function sendConversationResponse() {
      if (!currentConversation) return;
      
      const responseText = document.getElementById('conversationResponse').value;
      if (!responseText) return;
      
      try {
        // Send directly using conversation_id instead of looking for original message
        const response = await fetch('/api/send-conversation-response', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            conversation_id: currentConversation.conversation_id,
            chat_id: currentConversation.chat_id,
            finalText: responseText 
          })
        });
        
        if (response.ok) {
          // Refresh conversation to show new message
          await openConversation(currentConversation.conversation_id);
          document.getElementById('conversationResponse').value = '';
          
          // Refresh conversations list
          if (currentView === 'conversations') {
            loadConversations();
          }
        } else {
          const errorData = await response.json();
          alert('Failed to send message: ' + (errorData.error || 'Unknown error'));
        }
      } catch (error) {
        console.error('Error sending response:', error);
        alert('Error sending message');
      }
    }
    
    // Helper function to generate AI responses in frontend
    async function generateAIResponse(text, platform) {
      try {
        const response = await fetch('/api/generate-response', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, platform })
        });
        
        if (response.ok) {
          const data = await response.json();
          return data.response;
        } else {
          return 'Error generating response';
        }
      } catch (error) {
        console.error('Error generating AI response:', error);
        return 'Error generating response';
      }
    }

    async function loadMessages() {
      const res = await fetch('/api/messages');
      allMessages = await res.json();
      renderMessageList();
      if (selectedId) renderMainPanel(selectedId);
    }

    function renderMessageList() {
      const list = document.getElementById('messageList');
      list.innerHTML = '';
      if (allMessages.length === 0) {
        list.innerHTML = '<div class="p-3 text-muted">No messages yet</div>';
        return;
      }
      allMessages.forEach(m => {
        const item = document.createElement('button');
        item.className = 'list-group-item list-group-item-action';
        item.textContent = m.platform + ' — ' + m.user;
        item.onclick = () => {
          selectedId = m.id;
          renderMainPanel(m.id);
        };
        list.appendChild(item);
      });
    }

    function renderMainPanel(id) {
      const msg = allMessages.find(m => m.id === id);
      if (!msg) return;
      const panel = document.getElementById('mainPanel');
      panel.innerHTML = \`
        <div class="message-card p-4">
          <h5>\${msg.platform} — \${msg.user}</h5>
          <p><strong>Message:</strong> \${msg.text}</p>
          <textarea id="resp-\${msg.id}" class="form-control mb-3" rows="4">\${msg.aiResponse}</textarea>
          <div class="d-flex mb-3">
            <button class="btn btn-secondary me-2" onclick="regenerate('\${msg.id}')">♻️ Regenerate</button>
            <button class="btn btn-primary" onclick="sendResponse('\${msg.id}')">📤 Send Response</button>
          </div>
          <h6>History</h6>
          <ul class="list-group">\${msg.history.map(h => '<li class="list-group-item">' + h.action + '</li>').join('')}</ul>
        </div>
      \`;
    }

    async function regenerate(id) {
      await fetch('/api/regenerate/' + id, { method: 'POST' });
      loadMessages();
    }

    async function sendResponse(id) {
      const text = document.getElementById('resp-' + id).value;
      await fetch('/api/send/' + id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ finalText: text })
      });
      selectedId = null;
      loadMessages();
    }

    // Check session status on page load
    async function checkSessionStatus() {
      try {
        const response = await fetch('/api/session-status');
        const data = await response.json();
        if (data.connected) {
          updateConnectionStatus(true);
          console.log('Session restored from server');
        }
      } catch (error) {
        console.error('Error checking session status:', error);
      }
    }

    checkSessionStatus(); // Check if already connected
    loadMessages();
    setInterval(loadMessages, 30000); // Poll every 30 seconds instead of 5
  </script>
</body>
</html>`);
});

// Start server
// Load session on startup
if (loadSession()) {
  console.log('🔄 Previous session restored successfully');
} else {
  console.log('🆕 Starting with fresh session');
}

app.listen(7655, () => console.log('🚀 Server running on http://localhost:7655'));