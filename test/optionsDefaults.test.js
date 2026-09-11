import fs from 'fs/promises';
import assert from 'node:assert';
import test from 'node:test';
import vm from 'node:vm';

const filePath = new URL('../options.js', import.meta.url);

test('options.js exposes expected DEFAULT_OPTIONS values', async () => {
  let content = await fs.readFile(filePath, 'utf8');
  // expose the constant on the global object so we can inspect it
  content = content.replace(
    'const DEFAULT_OPTIONS = {',
    'globalThis.DEFAULT_OPTIONS = {'
  );

  const context = {
    chrome: { storage: { local: { get: async () => ({}), set: () => {} } } },
    document: {
      getElementById: () => ({
        addEventListener() {},
        value: '',
        checked: false,
        style: {},
      }),
      addEventListener() {},
    },
  };
  vm.createContext(context);
  vm.runInContext(content, context);

  const defaults = context.DEFAULT_OPTIONS;

  assert.strictEqual(defaults.provider, 'lmstudio');
  assert.strictEqual(defaults.lmstudio_endpoint, 'http://localhost:1234');
  assert.strictEqual(defaults.deepseek_reasoning_mode, 'standard');
  assert.strictEqual(defaults.lmstudio_model, '');
  assert.strictEqual(defaults.lmstudio_manual_model, false);
});
