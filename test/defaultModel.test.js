import fs from 'fs/promises';
import assert from 'node:assert';
import test from 'node:test';

const filePath = new URL('../background.js', import.meta.url);

 test('background.js uses correct model defaults and automation internals', async () => {
  const content = await fs.readFile(filePath, 'utf8');
  assert.ok(content.includes('deepseek_reasoning_mode: "standard"'));
  assert.ok(content.includes('function compactDomMarkup(markup, task, maxElements = 120)'));
  assert.ok(content.includes('low: 8192'));
  assert.ok(content.includes('You are a helpful browser assistant'));
  assert.ok(content.includes('function validateAutomationPlan(responseText)'));
  assert.ok(content.includes('delta?.reasoning'));
  assert.ok(content.includes("if (actionData.action === 'done')"));
  assert.ok(content.includes('userContent.push({ type: "image_url", image_url: { url: lastMessage.screenshot } })'));
  assert.ok(content.includes('tools: BROWSER_TOOL_DEFINITIONS'));
  assert.ok(content.includes('function normalizeChatHistory(history)'));
  assert.ok(content.includes('BROWSER_TOOL_DEFINITIONS'));
  assert.ok(content.includes('const BASE_SYSTEM_PROMPT ='));
 });
