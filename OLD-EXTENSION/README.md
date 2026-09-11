# Pair Browsing - AI-Powered Browser Assistant

A Chrome extension that provides an AI-powered assistant to help you navigate and interact with web pages through natural language commands.

## Quick Demo
[![Pair Browsing Demo](https://img.youtube.com/vi/yEKWRmQASDo/maxresdefault.jpg)]([https://www.youtube.com/watch?v=yEKWRmQASDo] "Pair Browsing Demo")

## Features

- 🤖 Natural Language Control: Interact with web pages using simple text commands
- 🖱️ Visual Cursor: See where the AI assistant is clicking with an animated cursor
- 🔍 Smart Element Detection: Automatically identifies and interacts with clickable elements
- ⌨️ Form Filling: Fill out forms and input fields with natural language instructions
- 📜 Content Extraction: Extract page content in various formats (text, markdown)
- 🔄 Navigation: Search Google, navigate to URLs, and go back in history
- ⬆️ Scrolling: Control page scrolling with natural commands
- ⚡ AI Providers: Support for local LM Studio and DeepSeek API tool calling

## Available Actions

1. **Click**: Click on any interactive element on the page
2. **Fill**: Input text into form fields
3. **Search Google**: Perform Google searches directly
4. **Navigate**: Go to specific URLs or go back in history
5. **Scroll**: Scroll the page up or down
6. **Send Keys**: Send keyboard inputs to active elements
7. **Extract Content**: Get page content as text or markdown

## Installation

1. Clone this repository or download the source code
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked" and select the directory containing the extension files

## Configuration

1. Click the extension icon in Chrome to open the options page
2. Choose LM Studio (local) or DeepSeek API
3. Configure the API settings:

### For LM Studio:
- Start the OpenAI-compatible local server
- Enter the endpoint and loaded model name

### For DeepSeek API:
- Enter your DeepSeek API key
- Choose Standard mode for fastest responses or Thinking mode with low, high, or maximum reasoning effort
- DeepSeek is DOM-only in this extension. Screenshots are not sent, so visual layout and image-only controls are unavailable.

## Usage

1. Click the extension icon to open the sidebar
2. Type your command in natural language (e.g., "Click the login button" or "Fill the email field with example@email.com")
3. The AI assistant will:
   - Analyze the page structure
   - Identify relevant elements
   - Execute the requested action
   - Provide visual feedback with the cursor

## Debug Mode

Enable debug mode in the options page to:
- View captured screenshots in the chat
- See detailed logging information
- Help troubleshoot interactions

## Examples

Here are some example commands you can try:

- "Click the sign up button"
- "Fill the username field with johndoe"
- "Search for Chrome extensions"
- "Scroll down one page"
- "Go back to the previous page"
- "Extract the main content as markdown"

## Requirements

- Google Chrome browser
- LM Studio or DeepSeek API access
- Active internet connection

## Technical Details

The extension consists of:
- Content Script: Handles page interactions and element detection
- Background Script: Manages AI communication and extension state
- Sidebar Interface: Provides the chat interface for user commands
- Options Page: Allows configuration of AI providers and settings

## Privacy & Security

- API keys are stored locally in Chrome storage
- Screenshots are only used for AI analysis and are not stored
- No data is collected or stored outside of your browser

## Troubleshooting

If the extension isn't working as expected:
1. Check if your API key is correctly configured
2. Ensure you have an active internet connection
3. Try refreshing the page
4. Check the browser console for error messages
5. Enable debug mode for more detailed logging

## License

This project is licensed under the MIT License - see the LICENSE file for details. 
