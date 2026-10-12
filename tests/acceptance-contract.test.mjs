import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateAction } from '../host/security.mjs';
import { registerPaseoBridge } from '../host/adapter.mjs';

const selection = {
  action: 'acceptance', providers: ['claude'],
  models: { claude: 'claude-selected-model' }, modes: { claude: 'selected-mode' },
};

test('protected acceptance action accepts the actual GUI model/mode selection', () => {
  const validated = validateAction(selection);
  assert.deepEqual(validated, selection);
});

test('protected acceptance bridge forwards model/mode selection to its actual manager', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-acceptance-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const routes = new Map();
  const app = { get(route, fn) { routes.set(`GET ${route}`, fn); }, post(route, fn) { routes.set(`POST ${route}`, fn); }, use() {} };
  let received;
  const manager = {
    acceptance: async input => { received = input; return { checkedAt: new Date().toISOString(), providers: [] }; },
    status: async () => ({ schemaVersion: 1, providers: [], daemon: {} }),
    shutdown: async () => {}, cancelPending() {},
  };
  const lifecycle = registerPaseoBridge(app, { dataDir: root, home: root, port: 9899, allowedOrigins: ['https://fixture.invalid'], manager, nativeRequest: async () => null, getInstalledPluginRecord: () => null });
  t.after(() => lifecycle.shutdown());
  const receipt = await new Promise(resolve => {
    const response = {
      statusCode: 200,
      setHeader() {},
      status(status) { this.statusCode = status; return this; },
      json(value) { resolve({ status: this.statusCode, value }); return this; },
    };
    routes.get('POST /api/paseo-bridge')({ headers: { origin: 'https://fixture.invalid', 'sec-fetch-site': 'same-origin' }, body: selection }, response);
  });
  assert.equal(receipt.status, 202);
  assert.equal(receipt.value.operation.action, 'acceptance');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, { providers: selection.providers, models: selection.models, modes: selection.modes });
});
