import fs from 'fs/promises';
import assert from 'node:assert';
import test from 'node:test';

const htmlPath = new URL('../options.html', import.meta.url);

test('options.html loads options.js and has key elements', async () => {
  const html = await fs.readFile(htmlPath, 'utf8');
  assert.ok(html.includes('script src="options.js"'));
  assert.ok(html.includes('id="provider"'));
  assert.ok(html.includes('id="lmstudioModel"'));
  assert.ok(html.includes('id="lmstudioManualModel"'));
  assert.ok(html.includes('value="deepseek"'));
  assert.ok(html.includes('id="deepseekReasoningMode"'));
  assert.ok(html.includes('value="standard"'));
  assert.ok(html.includes('Minimal (no thinking)'));
  assert.ok(html.includes('value="max"'));
  assert.ok(html.includes('Screenshots are not sent'));
  assert.ok(!html.includes('id="systemPrompt"'));
  assert.ok(html.includes('id="openSidebar"'));
});
