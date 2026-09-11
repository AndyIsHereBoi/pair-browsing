// Import storage service
import { conversationStorage } from './storage.js';

// Store active connections
const ports = new Map();

// Track active window for each port
const portWindows = new Map();
const activeRuns = new Map();

const BASE_SYSTEM_PROMPT = "You are a helpful browser assistant. Understand the user's request and either answer directly or use a browser tool to act on the page. When the user's request implies a browser action (click, type, fill, scroll, navigate, search), perform it using the available tools rather than asking redundant questions. If the request is a question or statement, just reply conversationally. Only refuse or avoid an action when the user explicitly forbids that specific action. Keep responses short and to the point; never use emojis, markdown, or decorative formatting. Do not restate what you can do or ask redundant clarifications.";

// Helper function to send messages to sidebar
async function sendDebugMessage(port, message) {
  // Get debug mode setting
  const { debug_mode } = await chrome.storage.local.get({ debug_mode: false });

  if (debug_mode) {
    sendSidebarMessage(port, message);
  }
}

async function sendSidebarMessage(port, message) {
  if (port) {
    port.postMessage({
      type: "ASSISTANT_MESSAGE",
      message
    });
  }
}

function sendNotification(port, message) {
  if (port) {
    port.postMessage({
      type: "NOTIFICATION",
      message
    });
  }
}

// Notify the sidebar that a tool has started executing.
function sendToolStart(port, actionData, sequence) {
  if (port) {
    // Bundle the call's arguments (everything except the action name and label).
    const args = {};
    for (const key of Object.keys(actionData || {})) {
      if (key !== "action" && key !== "description") {
        args[key] = actionData[key];
      }
    }
    port.postMessage({
      type: "TOOL_START",
      tool: actionData.action,
      description: actionData.description || "",
      args,
      sequence,
    });
  }
}

// Format a tool-call's return value for feeding back to the model (kept short
// so it doesn't blow up the context on big results).
function formatToolResult(actionData, result, error = null) {
  const name = actionData?.action || "tool";
  const label = actionData?.description || name;
  if (error) {
    return `- ${label}: ERROR ${error.message || String(error)}`;
  }
  const out = result && typeof result === "object" && !Array.isArray(result)
    ? { ...result }
    : result;
  if (out && typeof out === "object" && "result" in out && out.result && typeof out.result === "object" && "value" in out.result) {
    // run_script returns { success, result: { value } } — surface the value.
    return `- ${label}: ${safeJson(out.result.value)}`;
  }
  return `- ${label}: ${safeJson(out)}`;
}

function safeJson(value) {
  try {
    if (value === undefined) return "undefined";
    const str = JSON.stringify(value);
    return str ? str.slice(0, 1500) : String(value);
  } catch (e) {
    return String(value).slice(0, 1500);
  }
}

// Notify the sidebar that a tool finished (or failed).
function sendToolEnd(port, actionData, success) {
  if (port) {
    port.postMessage({
      type: "TOOL_END",
      tool: actionData.action,
      success: !!success,
    });
  }
}

// Clear AI conversation history
async function clearAIHistory() {
  await conversationStorage.clearHistory();
  console.log('AI conversation history cleared');
}

// Update conversation history
async function updateHistory(newEntry) {
  try {
    await conversationStorage.addEntry(newEntry);
    console.log('History updated:', newEntry);
  } catch (error) {
    console.error('Failed to update history:', error);
  }
}
// Reset session state
async function resetSession(port) {
  // Clear conversation history
  clearAIHistory();
  
  // Notify sidebar that reset is complete
  port.postMessage({
    type: "SESSION_RESET",
    success: true
  });
  
  console.log('Session reset complete');
}

class ScreenshotManager {
  constructor() {
    this.debugMode = false;
    this.pendingScreenshot = null;
  }

  async initialize() {
    const { debug_mode } = await chrome.storage.local.get({ debug_mode: false });
    this.debugMode = debug_mode;
  }

  // The agent requested a screenshot via log_image; keep it for the next request.
  setScreenshot(url) {
    this.pendingScreenshot = url || null;
  }

  // Return (and clear) the screenshot the agent explicitly requested.
  takePendingScreenshot() {
    const url = this.pendingScreenshot;
    this.pendingScreenshot = null;
    return url;
  }

  async captureScreenshot(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) {
      throw new Error('Tab not found');
    }
    
    // Capture the screenshot
    const screenshotUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    console.log('Screenshot captured successfully');
    
    return screenshotUrl;
  }

  async sendDebugScreenshot(port, screenshotUrl) {
    if (!this.debugMode) return;
    if (!port) return;
    port.postMessage({
      type: "DEBUG_SCREENSHOT",
      imageUri: screenshotUrl
    });
  }
}

// Shared manager so log_image can stash a screenshot that promptAI consumes.
const screenshotManager = new ScreenshotManager();

async function promptAI(prompt, tabId, port = null, stepCounter = 0, retryCounter = 0, runControl = null) {
  await screenshotManager.initialize();

  const maxSteps = 10;
  const maxRetries = 5;

  try {
    if (runControl?.stopped) throw new Error('Request stopped');
    console.log('[Pair Browsing] promptAI started', {
      prompt,
      tabId,
      stepCounter,
      retryCounter,
    });
    // Get interactive elements via CDP (crosses into iframes natively)
    const domResult = await getDomTool(tabId);
    const stringifiedInteractiveElements = domResult.dom;
    if (runControl?.stopped) throw new Error('Request stopped');
    console.log('[Pair Browsing] page markup collected', {
      characters: stringifiedInteractiveElements?.length || 0,
      lines: stringifiedInteractiveElements?.split('\n').length || 0,
    });

    // Only include a screenshot if the agent explicitly requested one (via log_image).
    const screenshotUrl = screenshotManager.takePendingScreenshot();
    if (runControl?.stopped) throw new Error('Request stopped');
    if (screenshotUrl) await screenshotManager.sendDebugScreenshot(port, screenshotUrl);

    console.log('[Pair Browsing] calling AI provider with fresh page content');
    const response = await sendPromptAndScreenshotToServer(
      prompt,
      screenshotUrl,
      stringifiedInteractiveElements,
      port,
      runControl
    );
    console.log("AI service response received:", response);

    if (response.success) {
      const responseData = parseProviderResponse(response.response);
      await updateHistory({
        role: "assistant",
        content: response.response,
        reasoning: response.reasoning || "",
      });

      console.log("Parsed response data:", responseData);

      // If there are no real browser actions (only done, or just text), treat as a conversational reply.
      const realActions = responseData.actions.filter((action) => action.action !== 'done');
      if (!realActions.length) {
        if (responseData.text) sendSidebarMessage(port, responseData.text);
        return { success: true, response, isDone: true };
      }

      if (responseData.text) sendSidebarMessage(port, responseData.text);
      sendNotification(port, "Task started");

      // Create action handler instance
      const actionHandler = new ActionHandler(tabId, port);

      // Capture each tool's return value so it can be fed back to the model.
      const toolResults = [];

      // Execute actions sequentially with proper waiting
      const totalActions = responseData.actions.length;
      for (let i = 0; i < totalActions; i++) {
        const actionData = responseData.actions[i];

        // The `done` action is a terminator — show it as "Task completed".
        if (actionData.action === 'done') {
          const displayData = {
            ...actionData,
            action: 'Task completed',
            description: actionData.description || 'Task completed',
          };
          sendToolStart(port, displayData, { current: i + 1, total: totalActions });
          await actionHandler.handleAction(actionData);
          sendToolEnd(port, displayData, true);
          sendNotification(port, `Task completed: ${actionData.description}`);
          return { success: true, response, isDone: true };
        }

        // Show the tool as running in the sidebar.
        sendToolStart(port, actionData, { current: i + 1, total: totalActions });

        // Wait for the action to complete
        let actionSuccess = false;
        try {
          const result = await actionHandler.handleAction(actionData);
          actionSuccess = true;
          toolResults.push(formatToolResult(actionData, result));
        } catch (error) {
          console.error('Action failed:', error);
          toolResults.push(formatToolResult(actionData, null, error));
          throw error;
        } finally {
          sendToolEnd(port, actionData, actionSuccess);
        }
      }

      // Fetch the fresh page state so the agent can continue.
      stepCounter++;
      if (stepCounter >= maxSteps) {
        console.warn('Max steps reached');
        return { success: false, error: 'Max steps reached' };
      }
      sendNotification(port, `Step: ${stepCounter}`);

      // Only include a screenshot if the agent explicitly requested one.
      const resultScreenshotUrl = screenshotManager.takePendingScreenshot();
      const resultDomResult = await getDomTool(tabId);
      const resultStringifiedInteractiveElements = resultDomResult.dom;

      // Persist the tool-call results so they're part of the model's context on
      // the next request (including recursive continuation turns).
      if (toolResults.length) {
        await updateHistory({
          role: "tool",
          content: `Results from your previous tool calls:\n${toolResults.join('\n')}`,
        });
      }

      // Feed the previous tool-call results back to the model so it can use them
      // (e.g. read the returned value from a run_script search).
      const resultsText = toolResults.length
        ? `\n\nResults from your previous tool calls:\n${toolResults.join('\n')}`
        : '';

      const continuationPrompt =
        `<task>${prompt}</task>\n\nYou have already inspected the page and taken actions toward this task. ` +
        `Do NOT re-plan from scratch or repeat reasoning you have already done. ` +
        `${resultsText}` +
        `Inspect the CURRENT page state, note what you already accomplished, and take only the next action that gets you closer to completing the task. ` +
        `If the task is already complete, return a "done" action now. ` +
        `Avoid re-deriving the same plan; act decisively and keep taking actions until finished, then return "done".`;
      const evaluationResponse = await sendPromptAndScreenshotToServer(
        continuationPrompt,
        resultScreenshotUrl,
        resultStringifiedInteractiveElements,
        port,
        runControl
      );

      if (evaluationResponse.success) {
        const continuationData = parseProviderResponse(evaluationResponse.response);
        if (continuationData.text) sendSidebarMessage(port, continuationData.text);

        // If the agent returned a `done` action (or no real actions), the task is complete.
        const actions = continuationData.actions || [];
        const hasDone = actions.some((action) => action.action === 'done');
        const realActions = actions.filter((action) => action.action !== 'done');
        if (hasDone || !realActions.length) {
          if (port) sendNotification(port, `Task complete.`);
          return { success: true, response };
        }

        // Otherwise, execute the next round of actions and keep going.
        const nextHandler = new ActionHandler(tabId, port);
        const nextToolResults = [];
        for (let i = 0; i < realActions.length; i++) {
          const actionData = realActions[i];
          sendToolStart(port, actionData, { current: i + 1, total: realActions.length });
          let actionSuccess = false;
          try {
            const result = await nextHandler.handleAction(actionData);
            actionSuccess = true;
            nextToolResults.push(formatToolResult(actionData, result));
          } catch (error) {
            console.error('[Pair Browsing] continuation action failed:', error);
            nextToolResults.push(formatToolResult(actionData, null, error));
            throw error;
          } finally {
            sendToolEnd(port, actionData, actionSuccess);
          }
        }

        // Persist this round's tool results so the recursive continuation also
        // has them in context.
        if (nextToolResults.length) {
          await updateHistory({
            role: "tool",
            content: `Results from your previous tool calls:\n${nextToolResults.join('\n')}`,
          });
        }

        return await promptAI(prompt, tabId, port, stepCounter, retryCounter, runControl);
      }

      return { success: true, response };
    }

    return { success: true, response };
  } catch (error) {
    console.error('[Pair Browsing] promptAI failed', {
      message: error.message,
      stack: error.stack,
    });
    return { success: false, error: error.message };
  }
}

function parseProviderResponse(responseText) {
  const text = String(responseText || '').trim();
  if (!text) return { actions: [], text: '' };

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && Array.isArray(parsed.actions)) {
      return {
        actions: parsed.actions || [],
        text: parsed.current_state?.memory || '',
        state: parsed.current_state || null,
      };
    }
  } catch (error) {
    // Not JSON; treat as natural language.
  }

  return { actions: [], text, state: null };
}

function validateAutomationPlan(responseText) {
  const responseData = parseAutomationPlanJson(responseText);
  const allowedActions = new Set([
    "click",
    "fill",
    "list_tabs",
    "connect_to_tab",
    "create_tab",
    "close_tab",
    "get_snapshot",
    "get_element_by_ref",
    "get_dom",
    "get_page_html",
    "get_element_attributes",
    "clear_input",
    "search_google",
    "go_to_url",
    "go_back",
    "scroll_down",
    "scroll_up",
    "send_keys",
    "run_script",
    "log_image",
    "wait_for_page_load",
    "done",
  ]);

  if (!responseData.current_state || !Array.isArray(responseData.actions)) {
    throw new Error("DeepSeek returned a response without current_state and actions.");
  }

  const invalidAction = responseData.actions.find(
    (action) =>
      !action ||
      typeof action.action !== "string" ||
      !allowedActions.has(action.action) ||
      typeof action.description !== "string" ||
      (action.action === "fill" &&
        (typeof action.ref !== "string" || typeof action.value !== "string")) ||
      (action.action === "click" && typeof action.ref !== "string")
  );
  if (invalidAction) {
    throw new Error("DeepSeek returned an action without a valid action name and description.");
  }
  return responseData;
}

function parseAutomationPlanJson(responseText) {
  const cleanedResponse = String(responseText || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(cleanedResponse);
  } catch (firstError) {
    const jsonCandidates = extractJsonObjects(cleanedResponse);
    for (const candidate of jsonCandidates.reverse()) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && parsed.current_state && Array.isArray(parsed.actions)) {
          return parsed;
        }
      } catch (error) {
        // Try the next complete JSON object in the response.
      }
    }
    throw new Error(`DeepSeek returned invalid JSON: ${firstError.message}`);
  }
}

function extractJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function getDeepSeekHistory(aiHistory) {
  return aiHistory
    .slice(-8)
    .filter((message) => {
      if (message.role !== "assistant") return true;
      try {
        validateAutomationPlan(message.content);
        return true;
      } catch (error) {
        console.warn("[Pair Browsing][DeepSeek] ignoring malformed history entry");
        return false;
      }
    });
}

function compactDomMarkup(markup, task, maxElements = 120) {
  const taskTerms = new Set(
    (task || "")
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g) || []
  );
  const markupLines = String(markup || "").split("\n");

  // Break the tree into "groups": an anchor (a line with a ref) plus any deeper
  // non-ref child lines (e.g. url:/src:) that belong to it.
  const groups = [];
  let current = null;
  for (const rawLine of markupLines) {
    const depth = (rawLine.match(/^ */) || [""])[0].length;
    if (/\[ref=/.test(rawLine)) {
      const normalizedLine = rawLine.toLowerCase();
      const score = [...taskTerms].reduce(
        (total, term) => total + (normalizedLine.includes(term) ? 1 : 0),
        0
      );
      current = { anchor: rawLine.replace(/"([^"]{61})[^"]*"/g, '"$1..."'), children: [], score, position: groups.length, depth };
      groups.push(current);
    } else if (current && depth > current.depth) {
      // Attribute child line belonging to the current anchor.
      current.children.push(rawLine);
    }
  }

  const selected = groups
    .slice()
    .sort((left, right) => right.score - left.score || left.position - right.position)
    .slice(0, maxElements)
    .sort((left, right) => left.position - right.position);

  const result = [];
  for (const group of selected) {
    result.push(group.anchor);
    result.push(...group.children);
  }
  const omittedCount = groups.length - selected.length;
  if (omittedCount > 0) {
    result.push(`[${omittedCount} lower-priority elements omitted; use the listed refs only]`);
  }
  return result.join("\n");
}

// Handle connection from sidebar
chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name === "sidebar") {
    // Preserve the current chat: only "New Chat" (RESET_SESSION) clears it.
    // Restore the persisted display history so reopening the panel shows the chat.
    try {
      const displayHistory = await conversationStorage.getDisplayHistory();
      if (port) {
        port.postMessage({ type: "LOAD_HISTORY", history: displayHistory });
      }
    } catch (error) {
      console.error('[Pair Browsing] failed to load display history', error);
    }

    // Store the port with a unique ID
    const portId = Date.now().toString();
    ports.set(portId, port);
    
    // Get and store the current window ID for this port
    chrome.windows.getCurrent().then(window => {
      portWindows.set(portId, window.id);
    });
    
    port.onDisconnect.addListener(async () => {
      const runControl = activeRuns.get(port);
      if (runControl) {
        runControl.stopped = true;
        runControl.disconnected = true;
        runControl.abortController?.abort();
        activeRuns.delete(port);
        console.log('[Pair Browsing] sidebar closed; cancelled active request');
      }
      const windowId = portWindows.get(portId);
      ports.delete(portId);
      portWindows.delete(portId);
      console.log(`Port disconnected: ${portId}`);
    });

    port.onMessage.addListener(async (message) => {
      console.log('Received message in background:', message);
      if (message.type === "PROMPT_AI") {
        if (activeRuns.has(port)) {
          port.postMessage({
            type: "ASSISTANT_MESSAGE",
            message: "A request is already processing. Stop it before sending another message.",
          });
          return;
        }
        const runControl = { stopped: false, abortController: null };
        activeRuns.set(port, runControl);
        const runKey = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        startKeepAlive(runKey);

        try {
        // Get the window ID for this port
        const portId = Array.from(ports.entries()).find(([id, p]) => p === port)?.[0];
        const windowId = portWindows.get(portId);
        
        // Get the active tab in the correct window
        const [tab] = await chrome.tabs.query({ active: true, windowId });
        if (!tab) {
          port.postMessage({
            type: "AI_RESPONSE",
            success: false,
            error: "No active tab found in the current window"
          });
          return;
        }

        const result = await promptAI(
          message.prompt,
          tab.id,
          port,
          0,
          0,
          runControl
        );
        if (!runControl.disconnected) {
          port.postMessage({
            type: "AI_RESPONSE",
            success: result.success,
            serverResponse: result.success ? result.response : undefined,
            error: result.success ? undefined : result.error,
          });
        }
        } catch (error) {
          console.error('[Pair Browsing] request failed', error);
          if (!runControl.disconnected) {
            port.postMessage({ type: "AI_RESPONSE", success: false, error: error.message });
          }
        } finally {
          activeRuns.delete(port);
          stopKeepAlive(runKey);
        }
      } else if (message.type === "STOP_AI") {
        const runControl = activeRuns.get(port);
        if (runControl) {
          runControl.stopped = true;
          runControl.abortController?.abort();
          sendNotification(port, "Stopping request...");
        }
      } else if (message.type === "SAVE_DISPLAY") {
        // Persist a user prompt or assistant reply for chat restore on reopen.
        try {
          await conversationStorage.addDisplayEntry({
            role: message.role,
            content: message.content,
          });
        } catch (error) {
          console.error('[Pair Browsing] failed to save display entry', error);
        }
      } else if (message.type === "RESET_SESSION") {
        await resetSession(port);
      }
    });
  }
});

// Initialize side panel behavior when extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  // Configure the side panel to open when the action button is clicked
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('Failed to set panel behavior:', error));
});

// Function to send prompt + screenshot to AI provider
async function sendPromptAndScreenshotToServer(prompt, base64Screenshot, stringifiedInteractiveElements = null, port = null, runControl = null) {
  console.log('[Pair Browsing] AI request starting', {
    prompt,
    markupCharacters: stringifiedInteractiveElements?.length || 0,
    hasScreenshot: Boolean(base64Screenshot),
  });
  
  // Get provider and settings from storage
  const { provider } = await chrome.storage.local.get({ provider: 'lmstudio' });
  console.log('[Pair Browsing] selected provider:', provider);

  await updateHistory({ role: 'user', content: prompt, elements: stringifiedInteractiveElements, screenshot: base64Screenshot });

  let response;
  try {
    if (provider === 'deepseek') {
      console.log('[Pair Browsing] dispatching to DeepSeek');
      response = await sendToDeepSeek(port, true, true, runControl);
      console.log('DeepSeek Response:', response);
    } else {
      console.log('[Pair Browsing] dispatching to LM Studio');
      response = await sendToLMStudio(port, runControl);
      console.log('LM Studio Response:', response);
    }
  } catch (error) {
    console.error('AI service error:', error);
    throw error;
  }

  return response;
}

const humanizeDelay = () => {
  // Regular range 100-500ms. ~5% chance 500-700ms.
  if (Math.random() < 0.05) return 500 + Math.round(Math.random() * 200);
  return 100 + Math.round(Math.random() * 400);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Short friendly label the model MUST put in each call's `description`.
const SHORT_LABEL_HINT =
  'A short, descriptive, present-tense label for THIS specific action (2-4 words), shown to the user in the UI. Examples: "Press this", "Check element", "Switch toggle", "Open profile", "Read page". Do NOT just repeat the tool name (e.g. do not write "Run script" for run_script).';

const BROWSER_TOOL_DEFINITIONS = [
  ["list_tabs", "List open browser tabs with id, title, url, and active state.", { description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["connect_to_tab", "Attach the debugger to a tab for control.", { tabId: { type: "number" }, description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["create_tab", "Create a new browser tab, optionally at a URL.", { url: { type: "string" }, description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["close_tab", "Close a browser tab.", { tabId: { type: "number" }, description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["get_snapshot", "Get an accessibility/DOM snapshot of the connected page with element references.", { description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["get_element_by_ref", "Resolve a snapshot element reference to its details.", { ref: { type: "string" }, description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["get_dom", "Return a nested accessibility snapshot of the connected page. Each element is shown as `- <type> \"name\" [ref=1]` where ref is a simple sequential number counting elements top-to-bottom (plus optional url/src/focusable attributes). Use the given [ref=N] number with click/fill/get_element_attributes.", { description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["get_page_html", "Return the raw page HTML (document.documentElement.outerHTML, truncated) so you can read the exact markup the page is serving. Use this before writing a run_script when you need to know the real DOM structure, selectors, or data present in the HTML.", { description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["get_element_attributes", "Return all attributes (e.g. src, href, alt) of an element by its [ref=...] id. Use this to extract an image URL or link target.", { ref: { type: "string" }, description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["click", "Click or toggle an element by its [ref=...] id. Prefer using the run_script tool with your own JavaScript to click or toggle elements when you can write a selector.", { ref: { type: "string" }, description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["fill", "Fill an input or code editor with a value.", { ref: { type: "string" }, value: { type: "string" }, description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["clear_input", "Clear an input-like element using select-all then delete.", { ref: { type: "string" }, description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["send_keys", "Send keyboard keys to the active/focused element to move the cursor and edit text precisely. Separate keys with spaces; prefix with ctrl+ / shift+ / alt+ for combos. Supports a single key press or a SEQUENCE, e.g. \"Backspace Backspace ArrowLeft Home Delete ctrl+Backspace End Enter\". Recognized key names: Backspace, Delete, Enter, Tab, Space, ArrowLeft/Right/Up/Down (or Left/Right/Up/Down), Home, End, PageUp, PageDown, Escape, and single characters (a, B, !). Use fill to type a whole field's text; use clear_input to empty it.", { keys: { type: "string", description: SHORT_LABEL_HINT } }],
  ["run_script", "Run a custom JavaScript script on the page and return its result. Use this to click, scroll, select, toggle, open links, or extract data with your own code. Before writing a script that targets page content, first call get_page_html to fetch the raw HTML so you know the real structure/selectors — unless you are targeting a specific element you already have a ref/selector for. For entering text into inputs/editors, use the fill or send_keys tools instead. ALWAYS give a specific `description` for what this script does", { script: { type: "string", description: "The JavaScript to run. Use an immediately-invoked / async body; the last expression's value is returned (JSON-serialized)." }, description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["scroll_down", "Scroll the page down.", { amount: { type: "number" }, description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["scroll_up", "Scroll the page up.", { amount: { type: "number" }, description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["go_to_url", "Navigate the connected tab to a URL.", { url: { type: "string" }, description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["go_back", "Go back in browser history.", { description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["search_google", "Open Google search with a query.", { query: { type: "string" }, description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["log_image", "Capture and log a screenshot of the page for visual inspection.", { description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["wait_for_page_load", "Wait for the page to be ready and network to settle.", { description: { type: "string", description: SHORT_LABEL_HINT } }],
  ["done", "Mark the task complete.", { description: { type: "string", description: SHORT_LABEL_HINT } }],
].map(([name, description, properties]) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required: Object.keys(properties).filter((key) => key !== "amount"),
      additionalProperties: false,
    },
  },
}));

const TOOL_CALL_INSTRUCTION = "You may call browser tools to act on the page. Decide yourself whether the user's message needs a tool call or a plain reply. If a tool call is needed, call it directly without asking. Use done when the requested task is complete. Do not call check, submit, or run if the user explicitly forbade it. Never use emojis, markdown, or decorative formatting. Keep replies short and direct. PREFER the run_script tool with your own JavaScript for page actions like clicking, scrolling, selecting elements, opening links, or extracting data (e.g. link hrefs). For entering text into inputs or editors, use the fill or send_keys tools instead of scripting. EVERY tool call MUST include a short friendly `description` label for what you're doing (e.g. 'Press this', 'Check element', 'Switch toggle', 'Open profile') — never repeat the raw tool name.";

// --- CDP browser agent core ------------------------------------------------
const cdp = {
  sessions: new Map(),
  refs: new Map(),

  async attach(tabId) {
    const refCount = this.refs.get(tabId) || 0;
    if (refCount > 0) {
      this.refs.set(tabId, refCount + 1);
      return;
    }
    await chrome.debugger.attach({ tabId }, "1.3");
    this.sessions.set(tabId, true);
    this.refs.set(tabId, 1);
  },

  async detach(tabId) {
    const refCount = this.refs.get(tabId) || 0;
    if (refCount <= 1) {
      this.refs.delete(tabId);
      if (this.sessions.has(tabId)) {
        try {
          await chrome.debugger.detach({ tabId });
        } finally {
          this.sessions.delete(tabId);
        }
      }
    } else {
      this.refs.set(tabId, refCount - 1);
    }
  },

  async send(tabId, method, params = {}) {
    try {
      return await chrome.debugger.sendCommand({ tabId }, method, params);
    } catch (error) {
      throw new Error(`CDP ${method} failed: ${error.message}`);
    }
  },
};

chrome.debugger?.onDetach?.addListener(({ tabId }) => {
  cdp.sessions.delete(tabId);
  cdp.refs.delete(tabId);
});

async function withCdp(tabId, fn) {
  await cdp.attach(tabId);
  try {
    return await fn();
  } finally {
    await cdp.detach(tabId);
  }
}

// MV3 service workers can be terminated while awaiting non-extension work (e.g.
// a long fetch to LM Studio), which silently kills in-flight runs. Periodically
// invoking an extension API resets the idle timer so an active run stays alive.
const keepAliveIntervals = new Map();
function startKeepAlive(key) {
  stopKeepAlive(key);
  keepAliveIntervals.set(
    key,
    setInterval(async () => {
      try { await chrome.runtime.getPlatformInfo(); } catch (e) {}
    }, 10000)
  );
}
function stopKeepAlive(key) {
  const id = keepAliveIntervals.get(key);
  if (id) {
    clearInterval(id);
    keepAliveIntervals.delete(key);
  }
}

async function listTabsTool() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.active })),
  };
}

async function connectToTabTool(tabId) {
  return withCdp(tabId, async () => {
    await cdp.send(tabId, "DOM.enable");
    await cdp.send(tabId, "Runtime.enable");
    await cdp.send(tabId, "Page.enable");
    await cdp.send(tabId, "Input.enable").catch(() => {});
    return { success: true, tabId };
  });
}

async function createTabTool(url = "") {
  const tab = await chrome.tabs.create({ url: url || "about:blank" });
  return { tabId: tab.id, url: tab.url };
}

async function closeTabTool(tabId) {
  await chrome.tabs.remove(tabId);
  cdp.sessions.delete(tabId);
  return { success: true };
}

// Build a nested, accessibility-snapshot-style tree of the page. Each node gets a
// sequential integer `ref` (1, 2, 3, ...) counting top-to-bottom in DOM order,
// which tools resolve by re-walking the same traversal and picking the Nth node.
const PB_TREE_SCRIPT = String.raw`(() => {
  const MAX_NODES = 400;
  const MAX_DEPTH = 14;
  const lines = [];
  let refCounter = 0;

  const typeOf = (el) => {
    const role = el.getAttribute && el.getAttribute('role');
    if (role) return role;
    const t = el.tagName.toLowerCase();
    if (t === 'a' && el.href) return 'link';
    if (t === 'button') return 'button';
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return 'combobox';
    if (t === 'img') return 'img';
    if (t === 'input') {
      const kind = el.getAttribute('type');
      if (kind === 'checkbox') return 'checkbox';
      if (kind === 'radio') return 'radio';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'nav') return 'navigation';
    if (t === 'main') return 'main';
    if (t === 'form') return 'form';
    if (t === 'header') return 'banner';
    if (t === 'footer') return 'contentinfo';
    if (t === 'ul' || t === 'ol') return 'list';
    if (t === 'li') return 'listitem';
    if (t === 'p') return 'paragraph';
    if (t === 'dialog') return 'dialog';
    return 'generic';
  };

  const nameOf = (el) => {
    const a = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('value') || el.getAttribute('title'));
    if (a && String(a).trim()) return String(a).trim().replace(/\s+/g, ' ').slice(0, 60);
    const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
    return t.slice(0, 60);
  };

  const isInteresting = (el) => {
    const t = el.tagName.toLowerCase();
    const role = el.getAttribute && el.getAttribute('role');
    if (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('tabindex'))) return true;
    if (['a','button','input','textarea','select','img','nav','main','form','header','footer','ul','ol','li','p','dialog','summary','label'].includes(t)) return true;
    if (role || /^h[1-6]$/.test(t)) return true;
    return false;
  };

  const extrasFor = (el) => {
    const out = [];
    if (typeof el.tabIndex === 'number' && el.tabIndex >= 0) out.push('focusable');
    if (el.getAttribute && el.getAttribute('aria-checked')) out.push(' checked:' + el.getAttribute('aria-checked'));
    return out.length ? ' [' + out.join(' ') + ']' : '';
  };

  const childLinesFor = (el) => {
    const out = [];
    const href = el.href || (el.getAttribute && el.getAttribute('href')) || '';
    const src = el.currentSrc || (el.getAttribute && el.getAttribute('src')) || '';
    if (href && href !== '#') out.push('- /url: "' + String(href).slice(0, 140) + '"');
    if (src) out.push('- /src: "' + String(src).slice(0, 140) + '"');
    return out;
  };

  const indent = (depth) => '  '.repeat(Math.max(0, depth));

  const emit = (el, depth) => {
    if (refCounter >= MAX_NODES || depth > MAX_DEPTH) return;
    if (isInteresting(el)) {
      refCounter++;
      const name = nameOf(el);
      lines.push(indent(depth) + '- ' + typeOf(el) + ' "' + name + '" [ref=' + refCounter + ']' + extrasFor(el));
      for (const cl of childLinesFor(el)) {
        lines.push(indent(depth + 1) + cl);
      }
    }
  };

  const walkChildren = (parent, depth) => {
    if (parent) {
      const kids = Array.from(parent.children || []);
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        emit(child, depth);
        if (refCounter >= MAX_NODES || depth + 1 > MAX_DEPTH) return;
        if (child.tagName.toLowerCase() === 'iframe') {
          try { if (child.contentDocument) walkChildren(child.contentDocument.documentElement || child.contentDocument.body, depth + 1); } catch (e) {}
        } else if (child.children && child.children.length) {
          walkChildren(child, depth + 1);
        }
      }
    }
  };

  walkChildren(document.documentElement, 0);
  return lines.join('\n');
})()`;

async function getDomTool(tabId) {
  return withCdp(tabId, async () => {
  await cdp.send(tabId, "Runtime.enable");
  const result = await cdp.send(tabId, "Runtime.evaluate", {
    expression: PB_TREE_SCRIPT,
    returnByValue: true,
  });
  return { dom: result?.result?.value || "" };
  });
}

// Return the raw page HTML (outerHTML), truncated to keep the context practical.
async function getPageHtmlTool(tabId) {
  return withCdp(tabId, async () => {
  await cdp.send(tabId, "Runtime.enable");
  const result = await cdp.send(tabId, "Runtime.evaluate", {
    expression: `(() => { const html = document.documentElement.outerHTML || ''; return (html.length > 200000) ? html.slice(0, 200000) + '\\n[truncated ' + (html.length - 200000) + ' chars]' : html; })()`,
    returnByValue: true,
  });
  return { html: result?.result?.value || "" };
  });
}

// Build an expression that resolves the element at the integer `ref` (1-based,
// counting interesting elements top-to-bottom, mirroring PB_TREE_SCRIPT) and then
// runs `body` with `el` in scope. `body` should be a function body (without the
// surrounding braces) returning a value.
function refDrillExpression(ref, body) {
  const target = parseInt(String(ref).replace(/^r/i, ''), 10);
  const isInterestingSrc = `(el) => { const t = el.tagName.toLowerCase(); const role = el.getAttribute && el.getAttribute('role'); if (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('tabindex'))) return true; if (['a','button','input','textarea','select','img','nav','main','form','header','footer','ul','ol','li','p','dialog','summary','label'].includes(t)) return true; if (role || /^h[1-6]$/.test(t)) return true; return false; }`;
  return `(() => { if (!Number.isFinite(${target}) || ${target} < 1) return null; ` +
    `const isInteresting = ${isInterestingSrc}; let counter = 0; let found = null; ` +
    `const walk = (parent) => { if (found || !parent) return; const kids = Array.from(parent.children || []); for (let i = 0; i < kids.length; i++) { const child = kids[i]; if (isInteresting(child)) { counter++; if (counter === ${target}) { found = child; return; } } if (child.tagName.toLowerCase() === 'iframe') { try { if (child.contentDocument) { walk(child.contentDocument.documentElement || child.contentDocument.body); if (found) return; } } catch (e) {} } else if (child.children && child.children.length) { walk(child); if (found) return; } } }; ` +
    `walk(document.documentElement); if (!found) return null; const el = found; return (${body}); })()`;
}

async function resolveRef(tabId, ref) {
  const result = await evaluate(tabId, refDrillExpression(ref, `(() => { const r = el.getBoundingClientRect(); return { found: true, tag: el.tagName.toLowerCase(), x: r.x + r.width/2, y: r.y + r.height/2, visible: r.width>0 && r.height>0, text: (el.textContent||'').trim().slice(0,80) }; })()`));
  return result || { found: false };
}

async function getElementAttributesTool(tabId, ref) {
  return withCdp(tabId, async () => {
  await cdp.send(tabId, "Runtime.enable");
  const res = await resolveRef(tabId, ref);
  if (!res || !res.found) throw new Error("No element at ref " + ref);
  const attrs = await evaluate(
    tabId,
    refDrillExpression(ref, `(() => { const out = { tag: el.tagName.toLowerCase(), ref: ${JSON.stringify(String(ref))} }; for (const attr of el.attributes) out[attr.name] = attr.value; if (el.currentSrc) out.currentSrc = el.currentSrc; return out; })()`)
  );
  if (!attrs) throw new Error("No element at ref " + ref);
  return { element: attrs };
  });
}

async function getElementByRefTool(tabId, ref) {
  return withCdp(tabId, async () => {
  const res = await resolveRef(tabId, ref);
  if (!res || !res.found) throw new Error("No element at ref " + ref);
  return { success: true, element: res };
  });
}

async function evaluate(tabId, expression) {
  return withCdp(tabId, async () => {
  await cdp.send(tabId, "Runtime.enable");
  const result = await cdp.send(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.result?.value;
  });
}

// Run an arbitrary user/AI-supplied script on the page and return a serializable result.
async function runScript(tabId, script) {
  return withCdp(tabId, async () => {
    await cdp.send(tabId, "Runtime.enable");
    // Wrap so the script can be an expression or a series of statements, and the
    // result is JSON-stringified (safe to send back over the port).
    const expression = `
      (async () => {
        ${script}
      })()
    `;
    const resp = await cdp.send(tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const exception = resp?.exceptionDetails?.text;
    if (exception) {
      return { error: exception };
    }
    const value = resp?.result?.value;
    return { value: value === undefined ? null : value };
  });
}

async function runScriptTool(tabId, script) {
  if (!script || !String(script).trim()) {
    throw new Error("run_script requires a non-empty 'script' argument.");
  }
  const result = await runScript(tabId, String(script));
  return { success: !result.error, result };
}

async function getSnapshotTool(tabId) {
  // Return the same nested ref-tree as get_dom, so [ref=...] ids are usable by
  // the other tools right away.
  return getDomTool(tabId);
}

async function clickTool(tabId, ref) {
  return withCdp(tabId, async () => {
  await cdp.send(tabId, "Runtime.enable");
  const res = await resolveRef(tabId, ref);
  if (!res || !res.found) throw new Error("No element at ref " + ref);
  const x = res.x, y = res.y;
  await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return { success: true, ref, tag: res.tag };
  });
}

async function clearElementTool(tabId, ref) {
  return withCdp(tabId, async () => {
  const focused = await evaluate(
    tabId,
    refDrillExpression(ref, `(() => { try { el.focus(); el.click && el.click(); return true; } catch(e){ return false; } })()`)
  );
  if (!focused) throw new Error("No editable element at ref " + ref);
  await sleep(200);
  // Select all + delete
  await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
  await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
  await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete" });
  await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete" });
  return { success: true, cleared: true };
  });
}

async function humanizedType(tabId, text) {
  for (const char of String(text)) {
    await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: char });
    await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", text: char });
    await sleep(humanizeDelay());
  }
}

async function fillTool(tabId, ref, value) {
  return withCdp(tabId, async () => {
    await clearElementTool(tabId, ref);
    await humanizedType(tabId, value);
    return { success: true, filled: true };
  });
}

// Map a key name to CDP key/code. Printable single chars map to themselves.
const KEY_DEFS = {
  enter: { key: "Enter", code: "Enter" },
  return: { key: "Enter", code: "Enter" },
  tab: { key: "Tab", code: "Tab" },
  space: { key: " ", code: "Space" },
  backspace: { key: "Backspace", code: "Backspace" },
  delete: { key: "Delete", code: "Delete" },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft" },
  arrowright: { key: "ArrowRight", code: "ArrowRight" },
  arrowup: { key: "ArrowUp", code: "ArrowUp" },
  arrowdown: { key: "ArrowDown", code: "ArrowDown" },
  left: { key: "ArrowLeft", code: "ArrowLeft" },
  right: { key: "ArrowRight", code: "ArrowRight" },
  up: { key: "ArrowUp", code: "ArrowUp" },
  down: { key: "ArrowDown", code: "ArrowDown" },
  home: { key: "Home", code: "Home" },
  end: { key: "End", code: "End" },
  pageup: { key: "PageUp", code: "PageUp" },
  pagedown: { key: "PageDown", code: "PageDown" },
  escape: { key: "Escape", code: "Escape" },
  esc: { key: "Escape", code: "Escape" },
};
const KEY_MOD_MAP = { ctrl: 2, control: 2, shift: 8, alt: 1 };

// One editable movement/action maps to a sequence of physical key events, so a
// single send_keys call can express edits like "ctrl+Backspace ArrowLeft Home
// Delete". Combos use "+" (ctrl+Backspace); separate keys are space-separated.
function parseKeyTokens(raw) {
  const tokens = [];
  for (const token of String(raw || "").split(/\s+/).filter(Boolean)) {
    if (token.includes("+")) {
      tokens.push(token.split("+"));
    } else {
      tokens.push([token]);
    }
  }
  return tokens;
}

async function sendKeysTool(tabId, keys) {
  return withCdp(tabId, async () => {
  await cdp.send(tabId, "Input.enable").catch(() => {});
  const combos = parseKeyTokens(keys);
  for (const combo of combos) {
    let modifiers = 0;
    let keyPart = "";
    // With a combo like ctrl+Backspace the non-modifier part may be several chars
    // (a named key), so keep its original spelling. For a lone token it is a key
    // name or a single printable character (case preserved).
    for (const part of combo) {
      const p = String(part).trim();
      if (KEY_MOD_MAP[p.toLowerCase()] !== undefined) {
        modifiers |= KEY_MOD_MAP[p.toLowerCase()];
      } else {
        keyPart = p;
      }
    }
    if (!keyPart) keyPart = String(combo[combo.length - 1]);
    const def = KEY_DEFS[keyPart.toLowerCase()];
    const isPrintable = String(keyPart).length === 1 && !def;
    const key = def ? def.key : (String(keyPart).length === 1 ? keyPart : keyPart);
    const code = def ? def.code : undefined;
    if (def) {
      await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: def.key, code: def.code, modifiers });
      await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: def.key, code: def.code, modifiers });
    } else {
      const text = isPrintable ? keyPart : undefined;
      await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, text });
      await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
    }
    await sleep(humanizeDelay());
  }
  return { success: true };
  });
}

async function scrollTool(tabId, amount) {
  return withCdp(tabId, async () => {
    await cdp.send(tabId, "Runtime.evaluate", {
      expression: `window.scrollBy(0, ${amount || window.innerHeight})`,
    });
    return { success: true };
  });
}

async function navigateTool(tabId, url) {
  return withCdp(tabId, async () => {
    await cdp.send(tabId, "Page.navigate", { url });
    return { success: true };
  });
}

async function goBackTool(tabId) {
  return withCdp(tabId, async () => {
    await chrome.tabs.goBack(tabId);
    return { success: true };
  });
}

async function searchGoogleTool(tabId, query) {
  return navigateTool(tabId, `https://www.google.com/search?q=${encodeURIComponent(query)}`);
}

async function logImageTool(tabId) {
  const shot = await withCdp(tabId, async () => {
    await cdp.send(tabId, "Page.enable");
    return cdp.send(tabId, "Page.captureScreenshot", { format: "png" });
  });
  if (shot?.data) {
    // Store the screenshot so the AI can "see" it on its next request.
    const url = `data:image/png;base64,${shot.data}`;
    screenshotManager.setScreenshot(url);
    return { success: true, image: true };
  }
  return { success: false };
}

async function waitForPageLoadTool(tabId) {
  return withCdp(tabId, async () => {
    await sleep(1200);
    await cdp.send(tabId, "Runtime.evaluate", { expression: `document.readyState` });
    return { success: true };
  });
}

function toolCallsToAutomationResponse(toolCalls, content = "") {
  const actions = toolCalls.map((toolCall) => {
    const name = toolCall.function?.name || toolCall.name;
    let argumentsObject = toolCall.function?.arguments || toolCall.arguments || {};
    if (typeof argumentsObject === "string") {
      try {
        argumentsObject = JSON.parse(argumentsObject);
      } catch (error) {
        argumentsObject = {};
      }
    }
    return {
      action: name,
      ...argumentsObject,
      description: argumentsObject.description || `Execute ${name}`,
    };
  });

  return JSON.stringify({
    current_state: {
      evaluation_previous_goal: "Unknown",
      memory: content || "",
      next_goal: "",
    },
    actions,
  });
}

function messageToAutomationResponse(message) {
  const content = message?.content || "";
  const toolCalls = message?.tool_calls || [];
  if (toolCalls.length > 0) return toolCallsToAutomationResponse(toolCalls, content);
  return content;
}

async function sendToDeepSeek(
  port = null,
  allowNoThinkingFallback = true,
  useStreaming = true,
  runControl = null
) {
  const {
    deepseek_api_key,
    deepseek_reasoning_mode,
    system_prompt,
  } = await chrome.storage.local.get({
    deepseek_api_key: "",
    deepseek_reasoning_mode: "standard",
    system_prompt: "",
  });

  console.log('[Pair Browsing][DeepSeek] preparing request', {
    model: 'deepseek-v4-flash',
    reasoningMode: deepseek_reasoning_mode,
    fallbackAllowed: allowNoThinkingFallback,
    useStreaming,
  });
  if (!deepseek_api_key) {
    throw new Error(
      "DeepSeek API key not set. Please set your API key in the extension options."
    );
  }

  const aiHistory = await conversationStorage.getAllHistory();
  console.log('[Pair Browsing][DeepSeek] history loaded', {
    historyEntries: aiHistory.length,
  });
  const lastMessage = aiHistory[aiHistory.length - 1];
  const compactMarkup = compactDomMarkup(lastMessage.elements, lastMessage.content);
  const isDefaultSystemPrompt = system_prompt.includes(
    "You are a precise browser automation agent that interacts with websites"
  );
  const deepSeekSystemPrompt = isDefaultSystemPrompt
    ? "You are a helpful browser assistant. Understand the user's request and answer directly or act on the page with browser tools. If the request implies an action, perform it instead of asking redundant questions. Only avoid an action the user explicitly forbade. Keep responses short; never use emojis, markdown, or decorative formatting, and do not ask redundant clarifications."
    : BASE_SYSTEM_PROMPT;
  const repairInstruction = allowNoThinkingFallback
    ? ""
    : "\nUse a browser tool for the next action. Answer in natural language.";
  const messages = getDeepSeekHistory(aiHistory.slice(0, -1)).map((message) => {
    // Feed the model's own prior reasoning and tool results back as context.
    let content = message.content;
    if (message.role === "assistant" && message.reasoning) {
      content = `<reasoning from your previous turn>${message.reasoning}</reasoning>\n\n${content}`;
    } else if (message.role === "tool") {
      content = `[Tool results]\n${content}`;
    }
    return { role: message.role === "assistant" ? "assistant" : "user", content };
  });

  messages.push({
    role: "user",
    content: `
Your task is: ${lastMessage.content}
Interactive elements from the page DOM:
${compactMarkup}

This is a DOM-only request. No screenshot is available. Do not infer visual details that are not represented in the interactive elements.
`,
  });

  const requestBody = {
    model: "deepseek-v4-flash",
    messages: [
      {
        role: "system",
        content: `${BASE_SYSTEM_PROMPT}${repairInstruction}\n\n${TOOL_CALL_INSTRUCTION} You are operating without a screenshot. Use PAGE CONTEXT and DOM elements only; do not infer visual details. If an answer cannot be established from the supplied context, leave that field untouched rather than inventing an answer.`,
      },
      ...messages,
    ],
    max_tokens: {
      standard: 4096,
      low: 8192,
      high: 12288,
      max: 16384,
    }[deepseek_reasoning_mode] || 4096,
    tools: BROWSER_TOOL_DEFINITIONS,
    tool_choice: "required",
    stream: useStreaming,
  };

  if (deepseek_reasoning_mode === "standard" || !allowNoThinkingFallback) {
    requestBody.thinking = { type: "disabled" };
  } else if (["low", "high", "max"].includes(deepseek_reasoning_mode)) {
    requestBody.thinking = { type: "enabled" };
    requestBody.reasoning_effort = deepseek_reasoning_mode;
  }

  console.log('[Pair Browsing][DeepSeek] request details', {
    thinking: requestBody.thinking,
    reasoningEffort: requestBody.reasoning_effort || null,
    maxTokens: requestBody.max_tokens,
    messageCount: requestBody.messages.length,
    systemCharacters: requestBody.messages[0].content.length,
    userCharacters: requestBody.messages[requestBody.messages.length - 1].content.length,
    requestCharacters: JSON.stringify(requestBody).length,
  });

  const abortController = new AbortController();
  if (runControl) runControl.abortController = abortController;
  // Longer timeout for thinking modes so reasoning + tool calls aren't cut off.
  const timeoutMs = ["low", "high", "max"].includes(deepseek_reasoning_mode) ? 120000 : 45000;
  const streamTimeout = setTimeout(() => {
    console.warn('[Pair Browsing][DeepSeek] stream timeout reached');
    abortController.abort();
  }, timeoutMs);

  let response;
  try {
    response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deepseek_api_key}`,
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });
  } catch (error) {
    clearTimeout(streamTimeout);
    console.error('[Pair Browsing][DeepSeek] request failed before headers', {
      message: error.message,
      aborted: abortController.signal.aborted,
    });
    if (runControl?.stopped) {
      throw new Error('Request stopped');
    }
    if (allowNoThinkingFallback) {
      sendNotification(port, "DeepSeek streaming request failed. Retrying with a normal response...");
      return sendToDeepSeek(port, false, false, runControl);
    }
    throw error;
  }

  console.log('[Pair Browsing][DeepSeek] response headers received', {
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get('content-type'),
  });

  if (!response.ok) {
    clearTimeout(streamTimeout);
    const errorData = await response.json().catch(() => null);
    console.error('[Pair Browsing][DeepSeek] API error', {
      status: response.status,
      statusText: response.statusText,
      errorData,
    });
    throw new Error(
      `DeepSeek API error: ${response.statusText}${
        errorData ? " - " + JSON.stringify(errorData) : ""
      }`
    );
  }

  if (!response.body) {
    clearTimeout(streamTimeout);
    throw new Error("DeepSeek returned no response body.");
  }

  if (!useStreaming) {
    clearTimeout(streamTimeout);
    const data = await response.json();
    const responseContent = messageToAutomationResponse(data.choices?.[0]?.message);
    console.log('[Pair Browsing][DeepSeek] non-stream response received', {
      responseCharacters: responseContent?.length || 0,
      finishReason: data.choices?.[0]?.finish_reason || null,
    });
    if (!responseContent?.trim()) {
      throw new Error("DeepSeek returned an empty non-stream response.");
    }
    const reasoning =
      data.choices?.[0]?.message?.reasoning_content ||
      data.choices?.[0]?.message?.reasoning ||
      "";
    return { response: responseContent.trim(), reasoning: reasoning.trim(), success: true };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseContent = "";
  let reasoningContent = "";
  const toolCalls = [];

  const emitStream = (text, reasoning = false) => {
    console.log(`[Pair Browsing][DeepSeek][${reasoning ? 'reasoning' : 'content'}]`, text);
    if (port && text) {
      port.postMessage({ type: "AI_STREAM", text, reasoning });
    }
  };

  // Stream tool-call names as the agent types them (each unique tool once).
  const emittedToolNames = new Set();
  const onToolCall = (name) => {
    const trimmed = String(name || "").trim();
    if (trimmed && !emittedToolNames.has(trimmed)) {
      emittedToolNames.add(trimmed);
      if (port) port.postMessage({ type: "TOOL_START", tool: trimmed, description: "" });
    }
  };

  const appendReasoning = (text) => { reasoningContent += text; };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        processDeepSeekStreamLine(line, emitStream, (text) => {
          responseContent += text;
        }, toolCalls, onToolCall, appendReasoning);
      }
    }
  } catch (error) {
    console.error('[Pair Browsing][DeepSeek] stream read failed', {
      message: error.message,
      responseCharacters: responseContent.length,
    });
    if (runControl?.stopped) {
      throw new Error('Request stopped');
    }
    if (allowNoThinkingFallback) {
      sendNotification(port, "DeepSeek reasoning did not finish in 45 seconds. Retrying without thinking...");
      clearTimeout(streamTimeout);
      return sendToDeepSeek(port, false, false, runControl);
    }
    throw error;
  } finally {
    clearTimeout(streamTimeout);
  }

  if (buffer.trim()) {
    processDeepSeekStreamLine(buffer, emitStream, (text) => {
      responseContent += text;
    }, toolCalls, onToolCall, appendReasoning);
  }

  if (toolCalls.length > 0) {
    responseContent = toolCallsToAutomationResponse(toolCalls, responseContent);
  }

  console.log('[Pair Browsing][DeepSeek] stream complete', {
    responseCharacters: responseContent.length,
    responsePreview: responseContent.slice(0, 500),
  });

  if (typeof responseContent !== "string" || !responseContent.trim()) {
    console.error('[Pair Browsing][DeepSeek] empty final content');
    if (runControl?.stopped) {
      throw new Error('Request stopped');
    }
    if (allowNoThinkingFallback) {
      sendNotification(port, "Reasoning used the response budget before producing JSON. Retrying without thinking...");
      return sendToDeepSeek(port, false, false, runControl);
    }
    throw new Error("DeepSeek returned an empty response. Try sending the request again.");
  }

  return {
    response: responseContent.trim(),
    reasoning: reasoningContent.trim(),
    success: true,
  };
}

function processDeepSeekStreamLine(line, emitStream, appendContent, toolCalls = [], onToolCall = null, appendReasoning = null) {
  const dataPrefix = line.match(/^data:\s*/i);
  if (!dataPrefix) return;
  const payload = line.slice(dataPrefix[0].length).trim();
  if (payload === "[DONE]") return;

  try {
    const parsedPayload = JSON.parse(payload);
    const delta = parsedPayload.choices?.[0]?.delta;
    console.debug('[Pair Browsing][DeepSeek] SSE chunk', {
      deltaKeys: delta ? Object.keys(delta) : [],
      finishReason: parsedPayload.choices?.[0]?.finish_reason || null,
    });
    const reasoningText =
      delta?.reasoning_content ||
      delta?.reasoning ||
      delta?.thinking ||
      delta?.analysis;
    if (reasoningText) {
      emitStream(reasoningText, true);
      if (appendReasoning) appendReasoning(reasoningText);
    }
    if (delta?.content) {
      appendContent(delta.content);
      emitStream(delta.content);
    }
    for (const toolCall of delta?.tool_calls || []) {
      const index = toolCall.index ?? toolCalls.length;
      if (!toolCalls[index]) {
        toolCalls[index] = {
          id: toolCall.id,
          type: "function",
          function: { name: "", arguments: "" },
        };
      }
      if (toolCall.id) toolCalls[index].id = toolCall.id;
      if (toolCall.function?.name) toolCalls[index].function.name += toolCall.function.name;
      if (toolCall.function?.arguments) toolCalls[index].function.arguments += toolCall.function.arguments;

      // Emit the tool name to the sidebar as soon as it starts streaming in.
      const nameSoFar = toolCalls[index].function.name;
      if (nameSoFar && onToolCall) onToolCall(nameSoFar);
    }
  } catch (error) {
    console.warn('[Pair Browsing][DeepSeek] ignoring malformed SSE chunk', {
      error: error.message,
      payload,
    });
  }
}

function normalizeChatHistory(history) {
  const messages = [];

  for (const message of history) {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "tool") continue;

    let content = typeof message.content === "string" ? message.content : "";
    let role = message.role;
    if (message.role === "assistant" && message.reasoning) {
      content = `<reasoning from your previous turn>${message.reasoning}</reasoning>\n\n${content}`;
    } else if (message.role === "tool") {
      // Tool results are read-only context, surfaced to the model as a user turn.
      role = "user";
      content = `[Tool results]\n${content}`;
    }
    const previous = messages[messages.length - 1];

    if (previous && previous.currentRole === role) {
      // Insert an empty placeholder with the opposite role to enforce alternation.
      const placeholderRole = role === "user" ? "assistant" : "user";
      messages.push({
        role: placeholderRole,
        content: "*empty message*",
        currentRole: placeholderRole,
      });
    }

    messages.push({ role, content, currentRole: role });
  }

  return messages.map(({ currentRole, ...rest }) => rest);
}

async function sendToLMStudio(port = null, runControl = null) {
  const { lmstudio_endpoint, lmstudio_model, lmstudio_manual_model, lmstudio_manual_model_name } = await chrome.storage.local.get({
    lmstudio_endpoint: "http://localhost:1234",
    lmstudio_model: "",
    lmstudio_manual_model: false,
    lmstudio_manual_model_name: "",
  });

  console.log("Preparing LM Studio request");

  const aiHistory = await conversationStorage.getAllHistory();
  console.log('[Pair Browsing][LM Studio] history loaded', { entries: aiHistory.length });
  // get the last message from the history
  const lastMessage = aiHistory[aiHistory.length - 1];
  // loop through the history messages except for the last one and add them to the messages array
  let messages = normalizeChatHistory(aiHistory.slice(0, -1));

  // add the last message to the messages array with role alternation
  const lastHistoryRole = messages[messages.length - 1]?.role;
  if (lastHistoryRole === "user") {
    messages.push({ role: "assistant", content: "*empty message*" });
  }
  // Compact the page snapshot so the request stays within the model's context
  // window (LM Studio models are often loaded with small n_ctx, e.g. 8192).
  const compactMarkup = compactDomMarkup(lastMessage.elements, lastMessage.content, 80);
  // Build the user message content; only include the image if a screenshot exists.
  const userContent = [
    {
      type: "text",
      text: `
Your task is: ${lastMessage.content}
Interactive elements:
${compactMarkup}
`,
    },
  ];
  if (lastMessage.screenshot) {
    userContent.push({ type: "image_url", image_url: { url: lastMessage.screenshot } });
  }
  messages.push({ role: "user", content: userContent });

  const LMSTUDIO_API_ENDPOINT = `${lmstudio_endpoint.replace(/\/$/, '')}/v1/chat/completions`;
  const requestBody = {
    model: lmstudio_manual_model ? lmstudio_manual_model_name : lmstudio_model,
    messages: [
      {
        role: "system",
        content: `${BASE_SYSTEM_PROMPT}\n\n${TOOL_CALL_INSTRUCTION}`,
      },
      ...messages,
    ],
    max_tokens: 8192,
    tools: BROWSER_TOOL_DEFINITIONS,
    tool_choice: "required",
    stream: true,
  };

  console.log("LM Studio request roles:", requestBody.messages.map(({ role }) => role));
  console.log("LM Studio tool request details:", {
    model: requestBody.model,
    toolNames: requestBody.tools.map(({ function: tool }) => tool.name),
    promptCharacters: JSON.stringify(requestBody.messages).length,
  });

  console.log("Sending request to LM Studio API");

  const abortController = new AbortController();
  if (runControl) runControl.abortController = abortController;
  const streamTimeout = setTimeout(() => {
    console.warn('[Pair Browsing][LM Studio] stream timeout reached');
    abortController.abort();
  }, 180000);

  try {
    // Retrying helps with transient failures. Reasoning models (e.g. Qwen3) with
    // tool_choice "required" can burn their whole output budget and return an
    // EMPTY response — so on that specific failure we retry with relaxed settings
    // (no forced tool call, more output tokens) so it can at least answer in text.
    const isEmptyResponse = (err) => /empty response|no content, tools, or reasoning/.test(err?.message || "");
    const maxRetries = 3;
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let body = requestBody;
      if (attempt > 0 && isEmptyResponse(lastError)) {
        body = {
          ...requestBody,
          tool_choice: "auto",
          max_tokens: 16384,
        };
      }
      try {
        return await streamLMStudio(port, runControl, abortController, body, LMSTUDIO_API_ENDPOINT, streamTimeout);
      } catch (error) {
        if (runControl?.stopped || abortController.signal.aborted) {
          throw error;
        }
        lastError = error;
        console.warn(`[Pair Browsing][LM Studio] attempt ${attempt + 1}/${maxRetries + 1} failed:`, error.message);
        if (attempt < maxRetries) {
          const timedOut = /abort|timed? ?out/i.test(error?.message || "");
          const relaxed = isEmptyResponse(error) ? " (retrying without forced tool call)" : "";
          const reason = timedOut ? "no response within the time limit" : error.message;
          sendNotification(port, `LM Studio ${reason}${relaxed}. Retrying (${attempt + 1}/${maxRetries})...`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    }
    if (lastError && /abort/i.test(lastError?.message || "")) {
      lastError = new Error("LM Studio did not respond within the time limit (the local model may still be loading or its context is too small).");
    }
    throw lastError || new Error('LM Studio request failed');
  } finally {
    clearTimeout(streamTimeout);
    if (runControl && runControl.abortController === abortController) {
      runControl.abortController = null;
    }
  }
}

async function streamLMStudio(port, runControl, abortController, requestBody, LMSTUDIO_API_ENDPOINT, streamTimeout) {
  console.log("[Pair Browsing][LM Studio] fetch =>", LMSTUDIO_API_ENDPOINT);
  // Allow up to 90s for the first streamed byte. A local 27B model generating a
  // tool-call JSON can take a while before emitting its first token; a shorter
  // timeout would abort valid requests with "BodyStreamBuffer was aborted".
  const connectSignal =
    typeof AbortSignal.any === "function"
      ? AbortSignal.any([abortController.signal, AbortSignal.timeout(90000)])
      : abortController.signal;
  const response = await fetch(LMSTUDIO_API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // LM Studio may not require authorization.
    },
    body: JSON.stringify(requestBody),
    signal: connectSignal,
  });

  console.log("Received response from LM Studio API");
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    console.error("LM Studio API error:", errorData);
    throw new Error(
      `LM Studio API error: ${response.statusText}${
        errorData ? " - " + JSON.stringify(errorData) : ""
      }`
    );
  }

  if (!response.body) {
    throw new Error("LM Studio did not return a streaming response.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  const toolCalls = [];

  const emitStream = (text, reasoningFlag = false) => {
    if (port && text) port.postMessage({ type: "AI_STREAM", text, reasoning: reasoningFlag });
  };

  // Stream tool-call names as the agent types them (each unique tool once).
  const emittedToolNames = new Set();
  const onToolCall = (name) => {
    const trimmed = String(name || "").trim();
    if (trimmed && !emittedToolNames.has(trimmed)) {
      emittedToolNames.add(trimmed);
      if (port) port.postMessage({ type: "TOOL_START", tool: trimmed, description: "" });
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta || {};
        // Capture reasoning/thinking if the model (e.g. Qwen3) streams it.
        const reasoningText =
          delta?.reasoning_content || delta?.reasoning || delta?.thinking || delta?.analysis;
        if (reasoningText) {
          reasoning += reasoningText;
          emitStream(reasoningText, true);
        }
        if (delta.content) {
          content += delta.content;
          emitStream(delta.content);
        }
        for (const toolCall of delta.tool_calls || []) {
          const index = toolCall.index ?? toolCalls.length;
          if (!toolCalls[index]) {
            toolCalls[index] = { id: toolCall.id, type: "function", function: { name: "", arguments: "" } };
          }
          if (toolCall.id) toolCalls[index].id = toolCall.id;
          if (toolCall.function?.name) toolCalls[index].function.name += toolCall.function.name;
          if (toolCall.function?.arguments) toolCalls[index].function.arguments += toolCall.function.arguments;

          // Emit the tool name to the sidebar as soon as it starts streaming in.
          const nameSoFar = toolCalls[index].function.name;
          if (nameSoFar) onToolCall(nameSoFar);
        }
      } catch (error) {
        console.debug("Ignoring malformed LM Studio stream chunk", error);
      }
    }
  }

  console.log("LM Studio stream complete");
  const reasoningText = reasoning.trim();
  const responseContent = content.trim();

  // If the model produced nothing (no text, no tool calls, no reasoning), treat
  // it as a failure so `sendToLMStudio` can retry / surface an error, instead of
  // silently returning an empty success that leaves the chat with no reply.
  if (!responseContent && toolCalls.length === 0 && !reasoningText) {
    throw new Error("LM Studio returned an empty response (no content, tools, or reasoning).");
  }

  if (toolCalls.length > 0) {
    return {
      response: toolCallsToAutomationResponse(toolCalls, content),
      reasoning: reasoningText,
      success: true,
    };
  }
  return {
    response: responseContent,
    reasoning: reasoningText,
    success: true,
  };
}

class ActionHandler {
  constructor(tabId, port) {
    this.tabId = tabId;
    this.port = port;
  }

  async handleAction(actionData) {
    const actionMap = {
      list_tabs: async () => listTabsTool(),
      connect_to_tab: async (args) => connectToTabTool(args?.tabId || this.tabId),
      create_tab: async ({ url }) => createTabTool(url),
      close_tab: async ({ tabId }) => closeTabTool(tabId),
      get_snapshot: async () => getSnapshotTool(this.tabId),
      get_element_by_ref: async ({ ref }) => getElementByRefTool(this.tabId, ref),
      get_dom: async () => getDomTool(this.tabId),
      get_page_html: async () => getPageHtmlTool(this.tabId),
      get_element_attributes: async ({ ref }) => getElementAttributesTool(this.tabId, ref),
      click: async ({ ref }) => clickTool(this.tabId, ref),
      fill: async ({ ref, value }) => fillTool(this.tabId, ref, value),
      clear_input: async ({ ref }) => clearElementTool(this.tabId, ref),
      send_keys: async ({ keys }) => sendKeysTool(this.tabId, keys),
      scroll_down: async ({ amount }) => scrollTool(this.tabId, amount),
      scroll_up: async ({ amount }) => scrollTool(this.tabId, -amount),
      go_to_url: async ({ url }) => navigateTool(this.tabId, url),
      go_back: async () => goBackTool(this.tabId),
      search_google: async ({ query }) => searchGoogleTool(this.tabId, query),
      run_script: async ({ script }) => runScriptTool(this.tabId, script),
      log_image: async () => logImageTool(this.tabId),
      wait_for_page_load: async () => waitForPageLoadTool(this.tabId),
      done: this.handleDone.bind(this)
    };

    const handler = actionMap[actionData.action];
    if (!handler) {
      throw new Error(`Unknown action type: ${actionData.action}`);
    }

    const response = await handler(actionData);
    
    // CDP-based page stabilization
    try {
      await evaluate(this.tabId, `document.readyState`);
    } catch (error) {
      // ignore if evaluation fails
    }
    await new Promise(resolve => setTimeout(resolve, 800));
    
    return response;
  }

  async handleDone({ description }) {
    sendDebugMessage(this.port, `Task completed: ${description}`);
    return { success: true, isDone: true };
  }
}

