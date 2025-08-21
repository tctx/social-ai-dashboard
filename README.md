# Social AI Dashboard

A powerful Instagram DM management dashboard with AI-powered responses for social media teams.

## Features

- 🤖 **AI-Powered Responses**: Automatic response generation using OpenAI GPT-4o-mini
- 📱 **Instagram Integration**: Complete Instagram DM management via Unipile API
- 💬 **iMessage-Style Chat View**: Full conversation history with threaded messaging
- 🔄 **Real-time Webhooks**: Instant notification of new DMs
- 🎯 **Dual Interface**: Inbox for new messages + Chats for ongoing conversations
- 🛡️ **Duplicate Prevention**: Smart filtering to prevent duplicate messages
- 🔐 **2FA Support**: Secure Instagram authentication with two-factor authentication

## How It Works

### Inbox Tab
- Shows new, unhandled messages that need responses
- Each message gets an AI-generated suggested response
- Messages disappear from inbox after being handled

### Chats Tab  
- Shows all conversations with users (permanent conversation history)
- Full iMessage-style interface with scrollable history
- Direct response capability without going through inbox
- Messages grouped by user for continuous conversations

## Setup

### Prerequisites
- Node.js 18+
- Instagram Business Account
- Unipile Account (for Instagram API access)
- OpenAI API Key

### Installation

1. **Clone the repository**
   ```bash
   git clone [repository-url]
   cd social-ai-dashboard
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment Setup**
   Create a `.env` file with:
   ```
   OPENAI_API_KEY=your_openai_api_key
   UNIPILE_DSN=your_unipile_domain
   UNIPILE_TOKEN=your_unipile_api_token
   ```

4. **Start the server**
   ```bash
   node app.js
   ```

5. **Setup ngrok for webhooks** (development)
   ```bash
   ngrok http 7655
   ```

6. **Configure Unipile webhook**
   - Set webhook URL to your ngrok URL + `/api/incoming`
   - Subscribe to "message_received" events only

## Usage

1. **Connect Instagram Account**
   - Click "Connect Instagram" button
   - Enter Instagram credentials
   - Complete 2FA if prompted

2. **Handle Incoming DMs**
   - New DMs appear in "Inbox" tab
   - Review AI-generated responses
   - Edit if needed and send

3. **Manage Conversations**
   - Switch to "Chats" tab for ongoing conversations
   - View full message history
   - Send follow-up messages directly

## Architecture

- **Backend**: Node.js with Express
- **Frontend**: Vanilla JavaScript with Bootstrap 5.3.0
- **APIs**: 
  - Unipile for Instagram integration
  - OpenAI for AI response generation
- **Storage**: In-memory (messages and conversations)

## Key Files

- `app.js` - Main application file (server + client code)
- `package.json` - Dependencies and scripts
- `.env` - Environment variables (not tracked)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details
