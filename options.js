// Default configuration
const DEFAULT_OPTIONS = {
  provider: "lmstudio",
  lmstudio_endpoint: "http://localhost:1234",
  lmstudio_model: "",
  lmstudio_manual_model: false,
  lmstudio_manual_model_name: "",
  deepseek_api_key: "",
  deepseek_reasoning_mode: "standard",
  system_prompt: `You are a precise browser automation agent that interacts with websites through structured commands. Your role is to:
1. Analyze the provided webpage screenshot and elements and structure
2. Think through the user's request and identify if you need more than one step to accomplish it. 
3. Determine the most appropriate action based to complete the user's request.
4. Respond with valid JSON containing your action sequence and state assessment

Functions:
1. click: Click on an interactive element by index
2. fill: Input text into a form field by index
3. search_google: Search Google in the current tab
4. go_to_url: Navigate to URLs or go back in history
5. scroll_down: Scroll the page down
6. scroll_up: Scroll the page up
7. send_keys: Send keyboard inputs to the active element
8. done: Mark the task as complete and provide final status

INPUT STRUCTURE:
1. User Request: The user's original request
2. Previous Steps: List of previous steps you have taken. 
3. Interactive Elements: List in the format:
   index[:]<element_type>element_text</element_type>
   - index: Numeric identifier for interaction
   - element_type: HTML element type (button, input, etc.)
   - element_text: Visible text or element description

Example:
33[:]<button>Submit Form</button>
_[:] Non-interactive text


Notes:
- Only elements with numeric indexes are interactive
- _[:] elements provide context but cannot be interacted with

1. RESPONSE FORMAT: You must ALWAYS respond with valid JSON in this exact format:
{
  "current_state": {
    "evaluation_previous_goal": "Success|Failed|Unknown - Analyze the current elements and the image to check if the previous goals/actions are successful like intended by the task. Ignore the action result. The website is the ground truth. Also mention if something unexpected happend like new suggestions in an input field. Shortly state why/why not",
    "memory": "Description of what has been done and what you need to remember until the end of the task",
    "next_goal": "What needs to be done with the next actions. ONLY RETURN THE NEXT GOAL IF THERE IS ONE, OTHERWISE DO NOT INCLUDE IT"
  },
  "actions": [ // an array of actions to perform, each with the following properties:
    {
      "action": "The type of action to perform (click, fill, search_google, go_to_url, go_back, scroll_down, scroll_up, send_keys, done)",
      "index": "The index number of the element to interact with (for click, fill, and send_keys actions)",
      "description": "A clear description of what will be done",
      "value": "The value to fill (for the fill action)",
      "query": "The search query (for the search_google action)",
      "url": "The URL to navigate to (for the go_to_url action)",
      "amount": "The scroll amount in pixels (optional for scroll actions)",
      "keys": "The keys to send (for the send_keys action)",
      "next_prompt": "The next action to perform if any (optional)"
    }
  ],
}

2. ACTIONS: You can specify multiple actions to be executed in sequence. 
   Common action sequences:
   - Form filling: [
       {action: "fill", "index": 1, "text": "username"}},
       {action: "fill", "index": 2, "text": "password"}},
       {action: "click", "index": 3}}
     ]
   - Task completion: [
       {action: "done", "description": "Successfully logged in and extracted profile data"}
     ]

3. ELEMENT INTERACTION:
   - Only use indexes that exist in the provided element list
   - Each element has a unique index number (e.g., "33[:]<button>")
   - Elements marked with "_[:]" are non-interactive (for context only)

4. NAVIGATION & ERROR HANDLING:
   - If no suitable elements exist, use other functions to complete the task
   - If stuck, try alternative approaches
   - Handle popups/cookies by accepting or closing them
   - Use scroll to find elements you are looking for

5. TASK COMPLETION:
   - Use the done action as the last action as soon as the task is complete
   - Don't hallucinate actions
   - If the task requires specific information - make sure to include everything in the done function. This is what the user will see.
   - If you are running out of steps (current step), think about speeding it up, and ALWAYS use the done action as the last action.

6. VISUAL CONTEXT:
   - When an image is provided, use it to understand the page layout
   - Bounding boxes with labels correspond to element indexes
   - Each bounding box and its label have the same color
   - Most often the label is inside the bounding box, on the top right
   - Visual context helps verify element locations and relationships
   - sometimes labels overlap, so use the context to verify the correct element

7. Form filling:
   - Some input fields have autocomplete suggestions. Make sure to include the instructions to select the right element from the suggestion list.
   - If you fill a input field and your action sequence is interrupted, most often a list with suggestions popped up under the field and you need to first select the right element from the suggestion list.
   - Many websites have autocomplete suggestions that you need to select from. make sure you provide the instructions to select the right element and watch for that during the evaluation

8. ACTION SEQUENCING:
   - Actions are executed in the order they appear in the list 
   - Each action should logically follow from the previous one
   - If the page changes after an action, the sequence is interrupted and you get the new state.
   - If content only disappears the sequence continues.
   - Only provide the action sequence until you think the page will change.
   - Try to be efficient, e.g. fill forms at once, or chain actions where nothing changes on the page like saving, extracting, checkboxes...
   - only use multiple actions if it makes sense. 

9. Evaluation:
   - After every task you will receive a screenshot and page structure of the state of the page, you need to evaluate if the task was successful.
   - Most importantly, evaluate the screenshot and see if there are any interruptions or if the task does not look complete. Some examples are autocomplete selections that needs to be chosen, or popups that need to be understood to figure out the best next action.
   - Adjust the next_goal to resolve any issues of the evaluated task before providing a new task.

Remember: Your responses must be valid JSON matching the specified format. Each action in the sequence must be valid. Always end completed tasks with a done action.
`,
  debug_mode: false,
  agent_mode: false,
  cursor_label: "AI Assistant",
};

// Saves options to chrome.storage
function saveOptions(showStatus = true) {
  // Get current values
  const provider = document.getElementById('provider').value || DEFAULT_OPTIONS.provider;
  const lmstudioEndpoint = document.getElementById('lmstudioEndpoint').value || DEFAULT_OPTIONS.lmstudio_endpoint;
  const lmstudioModel = document.getElementById('lmstudioModel').value || DEFAULT_OPTIONS.lmstudio_model;
  const lmstudioManualModel = document.getElementById('lmstudioManualModel').checked;
  const lmstudioManualModelName = document.getElementById('lmstudioManualModelName').value.trim();
  const deepseekKey = document.getElementById('deepseekKey').value || DEFAULT_OPTIONS.deepseek_api_key;
  const deepseekReasoningMode = document.getElementById('deepseekReasoningMode').value || DEFAULT_OPTIONS.deepseek_reasoning_mode;
  const debugMode = document.getElementById('debugMode').checked;
  const agentMode = document.getElementById('agentMode').checked;
  const cursorLabel = document.getElementById('cursorLabel').value || DEFAULT_OPTIONS.cursor_label;

  // Update UI with default values if empty
  if (!document.getElementById('provider').value) document.getElementById('provider').value = DEFAULT_OPTIONS.provider;
  if (!document.getElementById('lmstudioEndpoint').value) document.getElementById('lmstudioEndpoint').value = DEFAULT_OPTIONS.lmstudio_endpoint;
  if (!document.getElementById('cursorLabel').value) document.getElementById('cursorLabel').value = DEFAULT_OPTIONS.cursor_label;

  chrome.storage.local.set(
    {
      provider,
      lmstudio_endpoint: lmstudioEndpoint,
      lmstudio_model: lmstudioModel,
      lmstudio_manual_model: lmstudioManualModel,
      lmstudio_manual_model_name: lmstudioManualModelName,
      deepseek_api_key: deepseekKey,
      deepseek_reasoning_mode: deepseekReasoningMode,
      debug_mode: debugMode,
      agent_mode: agentMode,
      cursor_label: cursorLabel,
    },
    () => {
      if (showStatus) {
        const status = document.getElementById('status');
        status.textContent = 'Options saved.';
        status.style.display = 'block';
        status.className = 'success';
        setTimeout(() => {
          status.style.display = 'none';
        }, 2000);
      }
    }
  );
}

// Restores select box and checkbox state using the preferences
// stored in chrome.storage.
function restoreOptions() {
  chrome.storage.local.get(DEFAULT_OPTIONS, (items) => {
    document.getElementById("provider").value = items.provider;
    document.getElementById("lmstudioEndpoint").value = items.lmstudio_endpoint;
    document.getElementById("lmstudioModel").value = items.lmstudio_model;
    document.getElementById("lmstudioManualModel").checked = items.lmstudio_manual_model;
    document.getElementById("lmstudioManualModelName").value = items.lmstudio_manual_model_name;
    document.getElementById("deepseekKey").value = items.deepseek_api_key;
    document.getElementById("deepseekReasoningMode").value = items.deepseek_reasoning_mode;
    document.getElementById("debugMode").checked = items.debug_mode;
    document.getElementById("agentMode").checked = items.agent_mode;
    document.getElementById("cursorLabel").value = items.cursor_label;
    chrome.storage.local.set({
      provider: items.provider,
      lmstudio_endpoint: items.lmstudio_endpoint,
      lmstudio_model: items.lmstudio_model,
      deepseek_api_key: items.deepseek_api_key,
      deepseek_reasoning_mode: items.deepseek_reasoning_mode,
      debug_mode: items.debug_mode,
      agent_mode: items.agent_mode,
      cursor_label: items.cursor_label,
    });
    updateVisibility();
    updateManualModelVisibility();
    loadLMStudioModels();
  });
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveOptions(false), 300);
}

async function loadLMStudioModels() {
  const endpointInput = document.getElementById('lmstudioEndpoint');
  const modelSelect = document.getElementById('lmstudioModel');
  const endpoint = endpointInput.value || DEFAULT_OPTIONS.lmstudio_endpoint;
  const selectedModel = modelSelect.value;

  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/models`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const models = (data.models || data.data || [])
      .filter((model) => typeof model === 'string' || model.type === 'llm' || !model.type)
      .map((model) => typeof model === 'string'
        ? { key: model, displayName: model }
        : {
            key: model.key || model.id,
            displayName: model.display_name || model.key || model.id,
            loaded: Array.isArray(model.loaded_instances) && model.loaded_instances.length > 0,
          })
      .filter((model) => model.key);

    modelSelect.innerHTML = '';
    const loadedGroup = document.createElement('optgroup');
    loadedGroup.label = 'Currently loaded models';
    const availableGroup = document.createElement('optgroup');
    availableGroup.label = 'Available models';
    models.forEach((model) => {
      const option = document.createElement('option');
      option.value = model.key;
      option.textContent = model.displayName;
      (model.loaded ? loadedGroup : availableGroup).appendChild(option);
    });
    if (loadedGroup.children.length) modelSelect.appendChild(loadedGroup);
    if (availableGroup.children.length) modelSelect.appendChild(availableGroup);

    if (selectedModel && !models.some((model) => model.key === selectedModel)) {
      const option = document.createElement('option');
      option.value = selectedModel;
      option.textContent = `${selectedModel} (saved)`;
      modelSelect.appendChild(option);
    }
    if (selectedModel) modelSelect.value = selectedModel;
  } catch (error) {
    console.warn('Unable to load LM Studio models:', error);
  }
}

// Show/hide provider sections based on selection
function updateVisibility() {
  const provider = document.getElementById('provider').value;
  document.getElementById('lmstudio-section').style.display = provider === 'lmstudio' ? 'block' : 'none';
  document.getElementById('deepseek-section').style.display = provider === 'deepseek' ? 'block' : 'none';
}

function updateManualModelVisibility() {
  document.getElementById('lmstudioManualModelNameGroup').style.display =
    document.getElementById('lmstudioManualModel').checked ? 'block' : 'none';
}

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);
document.getElementById('provider').addEventListener('change', () => {
  updateVisibility();
  if (document.getElementById('provider').value === 'lmstudio') loadLMStudioModels();
});
document.getElementById('lmstudioEndpoint').addEventListener('change', loadLMStudioModels);
document.getElementById('lmstudioManualModel').addEventListener('change', () => {
  updateManualModelVisibility();
  scheduleSave();
});
[
  'provider',
  'lmstudioEndpoint',
  'lmstudioModel',
  'lmstudioManualModelName',
  'deepseekKey',
  'deepseekReasoningMode',
  'debugMode',
  'agentMode',
  'cursorLabel',
].forEach((id) => {
  document.getElementById(id).addEventListener('input', scheduleSave);
  document.getElementById(id).addEventListener('change', scheduleSave);
});
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => saveOptions(false));
}
document.getElementById('openSidebar').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});