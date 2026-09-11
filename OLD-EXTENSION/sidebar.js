// sidebar.js

const sendBtn = document.getElementById("sendBtn");
const stopBtn = document.getElementById("stopBtn");
const newChatBtn = document.getElementById("newChatBtn");
const optionsBtn = document.getElementById("optionsBtn");
const promptInput = document.getElementById("prompt");
const messagesDiv = document.getElementById("messages");
const thinkingSelect = document.getElementById("thinkingSelect");
const queueEl = document.getElementById("messageQueue");

let port = null;
let requestActive = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
const messageQueue = [];

// Available DeepSeek thinking levels shown in the dropdown.
const THINKING_LEVELS = ["standard", "low", "high", "max"];

// Reference to the assistant message element currently receiving streamed text.
let streamingMsgEl = null;
let streamingContentEl = null;

// Tool activity tracking (names of tool items currently awaiting completion).
let toolActivityEl = null;
const runningToolIds = new Set();

// Reasoning rendered as tool-call-style items. Each reasoning burst gets its own
// expanded item; it collapses once that burst ends.
let reasoningActive = false;
let currentReasoningEl = null;
let currentReasoningTextEl = null;

// Raw markdown text accumulating while streaming an assistant reply.
let streamingRawText = '';

// Whether the current turn's assistant reply was already persisted to chat
// history (via ASSISTANT_MESSAGE), so AI_RESPONSE doesn't double-save it.
let assistantPersistedThisTurn = false;

// Function to establish connection
function connectToBackground() {
  try {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      debugLog('Max reconnection attempts reached');
      return false;
    }

    port = chrome.runtime.connect({ name: "sidebar" });
    debugLog('Connected to background script');
    
    // Handle responses from the background script
    port.onMessage.addListener((message) => {
      debugLog('Received message in sidebar: ' + JSON.stringify(message));
      handlePortMessage(message);
    });
    
    // Handle disconnection
    port.onDisconnect.addListener(() => {
      debugLog('Port disconnected, will reconnect on next action');
      port = null;
      reconnectAttempts = 0; // Reset attempts on clean disconnect
    });
    
    return true;
  } catch (error) {
    debugLog('Failed to connect to background: ' + error.message);
    reconnectAttempts++;
    return false;
  }
}

// Ensure connection exists with retry logic
async function ensureConnection() {
  if (!port) {
    // Try to connect
    if (!connectToBackground()) {
      // If connection fails, wait and retry
      await new Promise(resolve => setTimeout(resolve, 1000));
      return connectToBackground();
    }
  }
  return true;
}

// Persist a user prompt or assistant reply so the chat survives reopening the
// panel. Only cleared by "New Chat" (RESET_SESSION).
function persistDisplay(role, content) {
  if (!content) return;
  if (!port) return;
  try {
    port.postMessage({ type: "SAVE_DISPLAY", role, content });
  } catch (error) {
    console.debug('[Pair Browsing][Sidebar] failed to persist display', error);
  }
}

// Create a timestamp element (shared by normal and streaming messages).
function createTimestampEl() {
  const timestampEl = document.createElement("time");
  timestampEl.className = "message-time";
  const now = new Date();
  timestampEl.dateTime = now.toISOString();
  timestampEl.textContent = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return timestampEl;
}

// Escape HTML so AI-provided text can't inject markup.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render a limited, safe subset of Markdown (bold, italic, lists, code, links).
function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(String(text));

  // Fenced code blocks ```lang\n...```
  html = html.replace(/```(\w*)[^\n]*\n?([\s\S]*?)```/g, (_, lang, code) => {
    const body = code.replace(/^\n/, '').replace(/\s+$/, '');
    const codeClass = lang ? ` class="language-${lang}"` : '';
    return `<pre><code${codeClass}>${body}</code></pre>`;
  });

  // Inline code `...`
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // Bold / italic / strikethrough
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  html = html.replace(/~~([^~]+)~~/g, '<s>$1</s>');

  // Block structure: lists + paragraphs
  const lines = html.split('\n');
  const out = [];
  let inUl = false;
  let inOl = false;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const ulMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    const olMatch = line.match(/^\s*\d+[.)]\s+(.+)$/);

    if (ulMatch) {
      flushPara();
      if (!inUl) {
        if (inOl) { out.push('</ol>'); inOl = false; }
        out.push('<ul>');
        inUl = true;
      }
      out.push(`<li>${ulMatch[1]}</li>`);
    } else if (olMatch) {
      flushPara();
      if (!inOl) {
        if (inUl) { out.push('</ul>'); inUl = false; }
        out.push('<ol>');
        inOl = true;
      }
      out.push(`<li>${olMatch[1]}</li>`);
    } else if (line.trim() === '') {
      flushPara();
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
    } else {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
      para.push(line);
    }
  }
  flushPara();
  if (inUl) out.push('</ul>');
  if (inOl) out.push('</ol>');

  return out.join('\n');
}

// Function to display a message in the chat
function addMessage(text, isUser = false) {
  const msgEl = document.createElement("div");
  msgEl.className = `message ${isUser ? 'user-message' : 'assistant-message'}`;
  
  const contentEl = document.createElement("div");
  contentEl.className = "message-content";
  if (isUser) {
    // User messages render as plain (but safe) text.
    contentEl.textContent = text;
  } else {
    // Assistant replies render Markdown.
    contentEl.innerHTML = renderMarkdown(text);
  }

  msgEl.appendChild(contentEl);
  msgEl.appendChild(createTimestampEl());
  messagesDiv.appendChild(msgEl);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  return msgEl;
}

// Always keep the newest content in view.
function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  });
}

// Ensure a streaming assistant message bubble exists.
function ensureStreamingMsg() {
  if (streamingMsgEl) return streamingMsgEl;
  const msgEl = document.createElement("div");
  msgEl.className = "message assistant-message streaming-msg";
  messagesDiv.appendChild(msgEl);
  streamingMsgEl = msgEl;
  return msgEl;
}

// Return (creating if needed) the CURRENT text block into which streamed text
// should be written. Text only ever streams into the newest bottom block, so a
// reasoning/tool item that arrived after text gets a NEW block below it — which
// keeps the output in true chronological order (newest at the bottom).
function getStreamingMessageContent() {
  ensureStreamingMsg();
  if (!streamingContentEl || streamingMsgEl.lastChild !== streamingContentEl) {
    const contentEl = document.createElement("div");
    contentEl.className = "message-content";
    streamingMsgEl.appendChild(contentEl);
    streamingContentEl = contentEl;
    streamingRawText = "";
  }
  scrollToBottom();
  return streamingContentEl;
}

// Finalize the streaming assistant bubble: stop the cursor, and if no text was
// ever streamed (e.g. a tool-only or reasoning-only turn) render the final text
// in a content block. The chronologically-ordered blocks are preserved as-is so
// thinking stays interleaved and the newest text stays at the bottom.
function finalizeStreamingMsg(finalText) {
  if (!streamingMsgEl) return;
  if (streamingMsgEl.querySelectorAll(":scope > .message-content").length === 0) {
    const contentEl = document.createElement("div");
    contentEl.className = "message-content";
    streamingMsgEl.appendChild(contentEl);
    contentEl.innerHTML = renderMarkdown(finalText || "");
  }
  streamingMsgEl.classList.remove("streaming-msg");
  if (!streamingMsgEl.querySelector(":scope > .message-time")) {
    streamingMsgEl.appendChild(createTimestampEl());
  }
}

// Start a new reasoning burst as an expanded tool-call-style item.
function startReasoning() {
  if (reasoningActive) return;
  reasoningActive = true;

  const item = document.createElement("div");
  item.className = "tool-item reasoning-item expanded";

  const status = document.createElement("span");
  status.className = "tool-status running";
  status.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>';

  const name = document.createElement("span");
  name.className = "tool-name";
  name.textContent = "Reasoning";

  const textEl = document.createElement("div");
  textEl.className = "reasoning-text";

  item.appendChild(status);
  item.appendChild(name);
  item.appendChild(textEl);
  insertActivityItem(item);

  // Clicking toggles expand/collapse.
  const toggle = () => item.classList.toggle("expanded");
  item.addEventListener("click", toggle);

  currentReasoningEl = item;
  currentReasoningTextEl = textEl;
  scrollToBottom();
}

// Append reasoning text to the current expanded reasoning item.
function streamThinking(text) {
  startReasoning();
  currentReasoningTextEl.textContent += text;
  currentReasoningTextEl.scrollTop = currentReasoningTextEl.scrollHeight;
  scrollToBottom();
}

// End the current reasoning burst: collapse the item and mark it done.
function finishThinking() {
  if (!reasoningActive) return;
  reasoningActive = false;

  if (currentReasoningEl) {
    const status = currentReasoningEl.querySelector(".tool-status");
    if (status) {
      status.classList.remove("running");
      status.classList.add("done");
      status.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4L19 6"/></svg>';
    }
    // Auto-collapse the reasoning item once this burst ends.
    currentReasoningEl.classList.remove("expanded");
  }
  currentReasoningEl = null;
  currentReasoningTextEl = null;
}

// Reset reasoning and tool state for a fresh turn. The previous turn's items
// are already rendered in their own finalized bubble, so here we only clear the
// tracking state for the NEW turn.
function resetActivityState() {
  toolActivityEl = null;
  runningToolIds.clear();
  reasoningActive = false;
  currentReasoningEl = null;
  currentReasoningTextEl = null;
}

// Append a reasoning/tool item at the END of the streaming bubble. Because new
// text only ever streams into the newest bottom content block (see
// getStreamingMessageContent), a new item that arrives after some text appears
// BELOW that text — keeping the whole turn in chronological order with the
// newest thing always at the bottom.
function insertActivityItem(item) {
  ensureStreamingMsg();
  // Keep the message-time (timestamp) as the very last child, if present.
  const timeEl = streamingMsgEl.querySelector(":scope > .message-time");
  if (timeEl) {
    streamingMsgEl.insertBefore(item, timeEl);
  } else {
    streamingMsgEl.appendChild(item);
  }
  scrollToBottom();
  return item;
}

// Friendly 2-3 word label shown instead of the raw tool name.
function friendlyToolLabel(toolName, description) {
  // Actions whose label reads best as a fixed phrase.
  const staticLabels = {
    go_to_url: "Opened URL",
    search_google: "Searched web",
    done: "Task complete",
    "Task completed": "Completed task",
  };
  if (staticLabels[toolName]) return staticLabels[toolName];

  const verbMap = {
    click: "Clicked",
    fill: "Filled",
    clear_input: "Cleared",
    send_keys: "Typed",
    scroll_down: "Scrolled down",
    scroll_up: "Scrolled up",
    go_back: "Went back",
    list_tabs: "Listed tabs",
    connect_to_tab: "Connected tab",
    create_tab: "Opened tab",
    close_tab: "Closed tab",
    get_dom: "Read page",
    get_snapshot: "Got snapshot",
    get_element_by_ref: "Read element",
    get_element_attributes: "Read element",
    log_image: "Captured image",
    wait_for_page_load: "Waited for page",
  };

  const verb = verbMap[toolName] || friendlyTitle(toolName);

  // Try to lift a short object (up to 2 words) out of the description.
  let cleaned = String(description || "")
    .replace(/^(click|fill|search|navigate|go to|open|scroll|get|type|input|press|close|clear|create|list|capture|wait|check|submit)\w*\b/i, "")
    .replace(/^(the|a|an|to|at|on|in|with|into)\s+/i, "")
    .replace(/^https?:\/\/\S+/i, "")
    .trim();

  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 2);
  // Drop a trailing joint word so we don't end on "for"/"to"/"in".
  if (words.length && /^(for|to|in|on|at|with|into)$/i.test(words[words.length - 1])) {
    words.pop();
  }
  if (words.length) {
    return `${verb} ${words.join(" ")}`.trim().split(/\s+/).slice(0, 3).join(" ");
  }
  return verb;
}

// Capitalize a raw tool name for a fallback label (e.g. "get_dom" -> "Get dom").
function friendlyTitle(name) {
  return String(name || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Prefer the AI's own short description for this specific call; otherwise fall
// back to the action's friendly verb label.
function resolveToolLabel(toolName, description) {
  const desc = String(description || "").trim();
  // Ignore the generic template fallback ("Execute <name>").
  const isGenericTemplate = /^execute\s+[a-z_]+\s*$/i.test(desc);
  if (desc && !isGenericTemplate) {
    // Use the model's label, keeping it tight (3 words max).
    return desc
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .join(" ");
  }
  return friendlyToolLabel(toolName, description);
}

// Add a tool item with a running spinner (dedupes by name if already running).
// Clicking the item toggles showing the call's arguments.
function addToolItem(toolName, description, args) {
  ensureStreamingMsg();

  // Reuse an existing running item with the same tool (avoid duplicates from
  // the streaming + execution phases).
  const existing = Array.from(
    streamingMsgEl.querySelectorAll(":scope > .tool-item")
  ).find(
    (el) =>
      el.dataset.tool === toolName &&
      el.querySelector(".tool-status")?.classList.contains("running")
  );
  if (existing) {
    if (args && Object.keys(args).length) {
      existing.dataset.args = JSON.stringify(args);
      existing.dataset.hasArgs = "true";
    }
    return existing.querySelector(".tool-status");
  }

  const item = document.createElement("div");
  item.className = "tool-item";
  item.dataset.tool = toolName;
  if (args && Object.keys(args).length) item.dataset.args = JSON.stringify(args);

  const status = document.createElement("span");
  status.className = "tool-status running";
  status.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>';

  const label = resolveToolLabel(toolName, description);
  const name = document.createElement("span");
  name.className = "tool-name";
  name.textContent = label;

  // Secondary hint shows the raw tool name (avoids duplicating the friendly label).
  const desc = document.createElement("span");
  desc.className = "tool-desc";
  desc.textContent = toolName;

  item.appendChild(status);
  item.appendChild(name);
  item.appendChild(desc);

  // Expandable arguments area (click the row to view the full tool-call JSON).
  const argsEl = document.createElement("div");
  argsEl.className = "tool-args";
  item.appendChild(argsEl);
  // Always keep the full args so the dropdown can show the JSON, even when empty.
  const fullArgs = args && typeof args === "object" ? args : {};
  item.dataset.args = JSON.stringify(fullArgs);
  item.dataset.hasArgs = "true";
  item.addEventListener("click", () => {
    const expanded = item.classList.toggle("expanded");
    if (expanded) {
      renderToolArgs(argsEl, JSON.parse(item.dataset.args || "{}"));
    }
  });

  insertActivityItem(item);

  runningToolIds.add(toolName);
  scrollToBottom();
  return status;
}

// Render the full JSON of the tool call's arguments in the dropdown.
function renderToolArgs(container, args) {
  container.textContent = '';
  const pre = document.createElement("pre");
  pre.className = "tool-args-json";
  pre.textContent = JSON.stringify(args || {}, null, 2);
  container.appendChild(pre);
}

// Mark the most recently started (running) tool item of the given name as completed.
function markToolDone(toolName, success) {
  const statuses = streamingMsgEl
    ? Array.from(streamingMsgEl.querySelectorAll(":scope > .tool-item"))
    : [];
  for (let i = statuses.length - 1; i >= 0; i--) {
    const statusEl = statuses[i].querySelector(".tool-status");
    if (statuses[i].dataset?.tool === toolName && statusEl && statusEl.classList.contains("running")) {
      statusEl.classList.remove("running");
      statusEl.classList.add("done");
      statusEl.innerHTML = success
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      runningToolIds.delete(toolName);
      scrollToBottom();
      return;
    }
  }
  runningToolIds.delete(toolName);
}

function setThinking(isThinking) {
  requestActive = isThinking;
  // Keep Send enabled so the user can queue messages while a request is active.
  sendBtn.disabled = false;
  stopBtn.hidden = !isThinking;
  stopBtn.disabled = false;
  if (!isThinking) {
    // Finalize the current streaming message, if any.
    streamingMsgEl = null;
    streamingContentEl = null;
  }
}

function resizePrompt() {
  promptInput.style.height = "auto";
  const availableMessageHeight = messagesDiv.clientHeight;
  const maximumHeight = Math.max(80, Math.floor(availableMessageHeight * 0.5));
  const nextHeight = Math.min(promptInput.scrollHeight, maximumHeight);
  promptInput.style.height = `${nextHeight}px`;
  promptInput.style.overflowY = promptInput.scrollHeight > maximumHeight ? "auto" : "hidden";
}

// Function to log debug messages if debug mode is enabled
async function debugLog(message) {
  const { debug_mode } = await chrome.storage.local.get({ debug_mode: false });
  if (debug_mode) {
    console.log(message);
    // addMessage(message, true);
  }
}

// Show a transient pop-up toast notification; click to dismiss.
function hideNotification() {
  const toast = document.getElementById('toast');
  if (toast) {
    toast.classList.remove('show');
    clearTimeout(toast._timer);
  }
}

function showNotification(text) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.addEventListener('click', hideNotification);
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// Handle messages from background
function handlePortMessage(message) {
  console.log('[Pair Browsing][Sidebar] message from background', message);
  if (message.type === "LOAD_HISTORY") {
    // Restore a previously-saved chat. Only render if the view is empty (a fresh
    // panel load) so reconnects mid-session don't duplicate the on-screen messages.
    if (messagesDiv.children.length === 0 && Array.isArray(message.history)) {
      for (const entry of message.history) {
        if (entry.role === "user") {
          addMessage(entry.content, true);
        } else if (entry.role === "assistant" && entry.content) {
          addMessage(entry.content, false);
        }
      }
    }
  } else if (message.type === "NOTIFICATION") {
    showNotification(message.message);
  } else if (message.type === "AI_STREAM") {
    if (message.reasoning) {
      // Reasoning streams into an expanded tool-call-style "Reasoning" item.
      streamThinking(message.text);
    } else {
      // Content text streams into the assistant message; thinking is complete.
      finishThinking();
      const contentEl = getStreamingMessageContent();
      streamingRawText += message.text;
      contentEl.innerHTML = renderMarkdown(streamingRawText);
      scrollToBottom();
    }
  } else if (message.type === "TOOL_START") {
    // Reasoning burst ended; show the tool item with a loading spinner.
    finishThinking();
    addToolItem(message.tool, message.description, message.args);
  } else if (message.type === "TOOL_END") {
    // Switch the tool item to a check (or X on failure) once it completes.
    markToolDone(message.tool, message.success);
  } else if (message.type === "ASSISTANT_MESSAGE") {
    // Final clean text reply from the agent. If we were streaming into a bubble,
    // keep the chronologically-streamed blocks as-is and just finalize it;
    // otherwise add a normal message.
    finishThinking();
    if (streamingMsgEl) {
      finalizeStreamingMsg(message.message);
      streamingMsgEl = null;
      streamingContentEl = null;
      streamingRawText = '';
      scrollToBottom();
    } else {
      addMessage(message.message, false);
    }
    persistDisplay("assistant", message.message);
    assistantPersistedThisTurn = true;
    setThinking(false);
  } else if (message.type === "DEBUG_SCREENSHOT") {
    addDebugScreenshot(message.imageUri);
  } else if (message.type === "AI_RESPONSE") {
    // Ensure the streaming cursor is removed even if no ASSISTANT_MESSAGE
    // finalized the message (e.g. tool-only responses). Grab the reference
    // before setThinking(false) nulls it out.
    const finalMsgEl = streamingMsgEl;
    streamingRawText = '';
    finishThinking();
    // Remove any tool items that were streamed as "pending" but never actually
    // executed in this turn, so no spinner lingers next to completed tools.
    cleanupStaleTools();
    if (!message.success) {
      addMessage(`Error: ${message.error || 'Unknown error occurred'}`);
    }
    if (finalMsgEl) {
      finalizeStreamingMsg();
      // If no ASSISTANT_MESSAGE carried the reply, persist whatever text was
      // actually streamed so the chat still restores correctly.
      if (!assistantPersistedThisTurn) {
        const blocks = finalMsgEl.querySelectorAll(":scope > .message-content");
        const text = Array.from(blocks)
          .map((b) => b.textContent.trim())
          .filter(Boolean)
          .join("\n");
        if (text) persistDisplay("assistant", text);
      }
    }
    setThinking(false);
    // If messages were queued while busy, send the next one now that we're idle.
    processQueue();
  }
}

// Remove tool items that are still showing a running spinner at the end of a turn
// (these were streamed as pending but never executed).
function cleanupStaleTools() {
  if (!streamingMsgEl) return;
  const stale = Array.from(
    streamingMsgEl.querySelectorAll(":scope > .tool-item")
  ).filter((el) => el.querySelector(".tool-status")?.classList.contains("running"));
  for (const item of stale) {
    item.remove();
  }
  runningToolIds.clear();
}

// Render the queued messages above the message bar.
function renderQueue() {
  if (!queueEl) return;
  queueEl.textContent = '';
  if (messageQueue.length === 0) {
    queueEl.hidden = true;
    return;
  }
  queueEl.hidden = false;
  for (const text of messageQueue) {
    const item = document.createElement("div");
    item.className = "queue-item";
    const dot = document.createElement("span");
    dot.className = "queue-indicator";
    const textEl = document.createElement("span");
    textEl.textContent = text;
    item.appendChild(dot);
    item.appendChild(textEl);
    queueEl.appendChild(item);
  }
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Send a prompt to the background (with retry), inserting it into the chat first if requested.
async function sendMessage(prompt, insertToChat) {
  if (insertToChat) {
    addMessage(prompt, true);
    persistDisplay("user", prompt);
  }
  // Reset the tool-activity, thinking, and reasoning areas for this new turn.
  resetActivityState();
  streamingRawText = '';
  assistantPersistedThisTurn = false;
  setThinking(true);

  for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
    try {
      // Get the current active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        throw new Error('No active tab found');
      }

      // Ensure we have a connection
      if (!await ensureConnection()) {
        throw new Error('Failed to establish connection to background script');
      }

      // Send message through the port
      port.postMessage({
        type: "PROMPT_AI",
        prompt,
        tabId: tab.id
      });
      return;
    } catch (error) {
      if (attempt === MAX_RECONNECT_ATTEMPTS - 1) {
        setThinking(false);
        addMessage(`Error: Failed to send request after ${MAX_RECONNECT_ATTEMPTS} attempts`);
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
}

// If the conversation is idle and there are queued messages, send the next one.
function processQueue() {
  if (requestActive || messageQueue.length === 0) return;
  const next = messageQueue.shift();
  renderQueue();
  sendMessage(next, true);
}

// Handle send: if busy, queue the message above the input bar; otherwise send now.
sendBtn.addEventListener("click", () => {
  const prompt = promptInput.value.replace(/\r\n/g, "\n").trim();
  if (!prompt) return;

  promptInput.value = ''; // Clear input
  resizePrompt();

  if (requestActive) {
    // Queue it right above the message bar until the conversation can accept it.
    messageQueue.push(prompt);
    renderQueue();
    return;
  }
  sendMessage(prompt, true);
});

stopBtn.addEventListener("click", async () => {
  if (!requestActive || !await ensureConnection()) return;
  stopBtn.disabled = true;
  port.postMessage({ type: "STOP_AI" });
});

// Load the saved thinking level from storage and reflect it in the dropdown.
async function loadThinkingLevel() {
  const { deepseek_reasoning_mode } = await chrome.storage.local.get({ deepseek_reasoning_mode: "standard" });
  const level = THINKING_LEVELS.includes(deepseek_reasoning_mode) ? deepseek_reasoning_mode : "standard";
  thinkingSelect.value = level;
}

// Persist the thinking level whenever the dropdown selection changes.
thinkingSelect.addEventListener("change", async () => {
  const level = thinkingSelect.value;
  await chrome.storage.local.set({ deepseek_reasoning_mode: level });
  showNotification(`Thinking level set to ${level}`);
});

// Function to display debug screenshot
function addDebugScreenshot(imageUri) {
  debugLog('Adding debug screenshot to sidebar');
  
  // Create message container with same styling as chat messages
  const msgEl = document.createElement("div");
  msgEl.className = "message assistant-message";
  
  // Create content container
  const contentEl = document.createElement("div");
  contentEl.className = "message-content";
  
  // Add label
  const label = document.createElement("div");
  label.textContent = "Debug: Captured Screenshot";
  label.style.marginBottom = "8px";
  label.style.color = "#666";
  label.style.fontSize = "12px";
  
  // Style the image
  const img = document.createElement("img");
  img.src = imageUri;
  img.className = "debug-screenshot";
  img.style.display = "block";
  
  // Assemble the message
  contentEl.appendChild(label);
  contentEl.appendChild(img);
  msgEl.appendChild(contentEl);
  messagesDiv.appendChild(msgEl);
  
  // Scroll to the new message
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Parse and display an automation plan response
function displayAIResponse(responseData) {
  const state = responseData.current_state;
  if (state?.evaluation_previous_goal) {
    addMessage(`Evaluation: ${state.evaluation_previous_goal}`);
  }
  if (state?.memory) {
    addMessage(`Memory: ${state.memory}`);
  }
  if (state?.next_goal) {
    addMessage(`Next goal: ${state.next_goal}`);
  }

  const actions = Array.isArray(responseData.actions) ? responseData.actions : [];
  if (actions.length === 0) {
    addMessage("No browser actions were returned.");
    return;
  }

  actions.forEach((actionData, index) => {
    if (!actionData?.action) {
      addMessage(`Action ${index + 1}: Invalid action returned.`);
      return;
    }

    addMessage(`Action ${index + 1}/${actions.length}: ${describeAction(actionData)}`);
  });
}

function describeAction(actionData) {
  switch (actionData.action) {
    case "click":
      return `Click element ${actionData.index}: ${actionData.description || ""}`;
    case "fill":
      return `Fill element ${actionData.index} with "${actionData.value || ""}": ${actionData.description || ""}`;
    case "search_google":
      return `Search Google for "${actionData.query || ""}": ${actionData.description || ""}`;
    case "go_to_url":
      return `Navigate to ${actionData.url || ""}: ${actionData.description || ""}`;
    case "go_back":
      return `Go back: ${actionData.description || ""}`;
    case "scroll_down":
    case "scroll_up":
      return `${actionData.action} ${actionData.amount ? `${actionData.amount}px` : "one page"}: ${actionData.description || ""}`;
    case "send_keys":
      return `Send keys "${actionData.keys || ""}": ${actionData.description || ""}`;
    case "done":
      return `Done: ${actionData.description || ""}`;
    case "list_tabs":
      return `List tabs: ${actionData.description || ""}`;
    case "connect_to_tab":
      return `Connect to tab ${actionData.tabId || ""}: ${actionData.description || ""}`;
    case "create_tab":
      return `Create tab${actionData.url ? ` at ${actionData.url}` : ""}: ${actionData.description || ""}`;
    case "close_tab":
      return `Close tab ${actionData.tabId || ""}: ${actionData.description || ""}`;
    case "get_snapshot":
      return `Get page snapshot: ${actionData.description || ""}`;
    case "get_dom":
      return `Get page DOM: ${actionData.description || ""}`;
    case "get_element_attributes":
      return `Get element ${actionData.index ?? ""} attributes: ${actionData.description || ""}`;
    case "clear_input":
      return `Clear input ${actionData.index ?? ""}: ${actionData.description || ""}`;
    case "run_script":
      return `Run script: ${actionData.description || ""}`;
    case "log_image":
      return `Capture page screenshot: ${actionData.description || ""}`;
    case "wait_for_page_load":
      return `Wait for page load: ${actionData.description || ""}`;
    default:
      return `${actionData.action}: ${actionData.description || ""}`;
  }
}

// Add keyboard shortcut handling
promptInput.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    // Plain Enter sends the message.
    e.preventDefault();
    const prompt = promptInput.value.trim();
    if (prompt) {
      sendBtn.click();
    }
    return;
  }

  if (e.key === "Enter" && e.shiftKey) {
    // Shift+Enter inserts a newline.
    requestAnimationFrame(resizePrompt);
  }
});

promptInput.addEventListener("input", resizePrompt);
window.addEventListener("resize", resizePrompt);
resizePrompt();

// Reset button handler
newChatBtn.addEventListener("click", async () => {
  // Clear the messages div
  messagesDiv.innerHTML = '';
  streamingMsgEl = null;
  streamingContentEl = null;
  toolActivityEl = null;
  resetActivityState();
  streamingRawText = '';
  messageQueue.length = 0;
  renderQueue();
  promptInput.value = '';
  resizePrompt();
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      return;
    }
    
    if (await ensureConnection()) {
      port.postMessage({
        type: "RESET_SESSION",
        tabId: tab.id
      });
    }
  } catch (error) {
    console.debug('Failed to reset session:', error);
  }
});

// Options button handler
optionsBtn.addEventListener("click", async () => {
  if (optionsBtn.disabled) return;
  optionsBtn.disabled = true;

  try {
    await chrome.action.openPopup();
  } catch (error) {
    console.debug("[Pair Browsing][Sidebar] action popup unavailable", error);
    addMessage("Settings popup could not open here. Click the Pair Browsing toolbar icon to open settings.");
  } finally {
    setTimeout(() => {
      optionsBtn.disabled = false;
    }, 500);
  }
});

// Initialize connection and UI state when the script loads
connectToBackground();
loadThinkingLevel();
