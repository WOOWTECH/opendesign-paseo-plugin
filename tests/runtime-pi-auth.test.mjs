import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runtimeContext, sourceRoot, safeError } from '../src/runtime-context.mjs';
import { createAuthFlow } from '../src/auth-flow.mjs';
import { runPiOAuth, loadPiOAuth } from '../src/pi-oauth.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-pi-oauth-')), home = path.join(root, 'home'), dataDir = path.join(root, 'data'); fs.mkdirSync(home); fs.mkdirSync(dataDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return runtimeContext({ home, dataDir, packageRoot: sourceRoot, env: { PATH: process.env.PATH, OD_API_TOKEN: 'host-token-fixture', PI_OAUTH_CALLBACK_HOST: '0.0.0.0' } });
}

test('official SDK OAuth callbacks drive protected URL/manual input and official storage merges only the requested provider', async t => {
  const context = fixture(t), notifications = [], rows = new Map([['anthropic', { type: 'oauth', access: 'existing-tenant-fixture' }]]);
  const controller = new AbortController(); let modified = 0;
  const credentials = { type: 'oauth', access: 'new-access-fixture', refresh: 'new-refresh-fixture', expires: 12345, accountId: 'account-fixture' };
  const load = async () => ({
    providerId: 'openai-codex',
    AuthStorage: { create: file => {
      assert.equal(file, path.join(context.home, '.pi/agent/auth.json'));
      return { list: async () => [...rows.keys()].map(providerId => ({ providerId, type: 'oauth' })), modify: async (provider, fn, options) => {
        assert.equal(options.signal, controller.signal); assert.equal(provider, 'openai-codex'); modified++;
        const value = await fn(rows.get(provider)); if (value !== undefined) rows.set(provider, value);
      } };
    } },
    oauth: { login: async interaction => {
      assert.equal(await interaction.prompt({ type: 'select', options: [{ id: 'browser' }, { id: 'device_code' }] }), 'browser');
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=fixture-state' });
      assert.equal(await interaction.prompt({ type: 'manual_code' }), 'http://localhost:1455/auth/callback?code=fixture-code&state=fixture-state');
      return credentials;
    } },
  });
  await runPiOAuth(context, { signal: controller.signal, load, notify: value => notifications.push(value), prompt: async () => 'http://localhost:1455/auth/callback?code=fixture-code&state=fixture-state' });
  assert.equal(modified, 1); assert.deepEqual(rows.get('openai-codex'), credentials); assert.deepEqual(rows.get('anthropic'), { type: 'oauth', access: 'existing-tenant-fixture' });
  assert.equal(notifications.at(-1).phase, 'authorization_completed');
  for (const secret of ['new-access-fixture', 'new-refresh-fixture', 'fixture-code']) assert.equal(JSON.stringify(notifications).includes(secret), false);
});

test('existing Pi OAuth credentials and concurrent tenant credentials are never replaced', async t => {
  const context = fixture(t), signals = new AbortController(); let logins = 0, modifications = 0;
  const existing = { type: 'oauth', access: 'existing-fixture' };
  const notices = [];
  const load = async () => ({ providerId: 'openai-codex', AuthStorage: { create: () => ({ list: async () => [{ providerId: 'openai-codex', type: 'oauth' }], modify: async () => { modifications++; } }) }, oauth: { login: async () => { logins++; } } });
  await runPiOAuth(context, { signal: signals.signal, load, notify: value => notices.push(value) });
  assert.equal(logins, 0); assert.equal(modifications, 0); assert.deepEqual(notices, [{ phase: 'credential_present' }]);
  const concurrent = async () => ({ providerId: 'openai-codex', AuthStorage: { create: () => ({ list: async () => [], modify: async (_, fn) => { assert.equal(await fn(existing), undefined); modifications++; } }) }, oauth: { login: async () => ({ type: 'oauth', access: 'new-fixture' }) } });
  await runPiOAuth(context, { signal: signals.signal, load: concurrent, notify: () => {} }); assert.equal(modifications, 1);
});

test('abort after OAuth returns but before persistence prevents credential writes', async t => {
  const context = fixture(t), controller = new AbortController(); let persisted = false;
  await assert.rejects(runPiOAuth(context, { signal: controller.signal, load: async () => ({ providerId: 'openai-codex', AuthStorage: { create: () => ({ list: async () => [], modify: async () => { persisted = true; } }) }, oauth: { login: async () => { controller.abort(); return { type: 'oauth', access: 'fixture' }; } } }), notify: () => {}, prompt: async () => 'fixture-code' }));
  assert.equal(persisted, false);
});

test('Pi protected flow launches sanitized official SDK worker and completes through stdin without echoing code/tokens', async t => {
  const context = fixture(t); let child, submitted;
  const flow = createAuthFlow(context, { settleMs: 3, launch: (command, args, options) => {
    assert.equal(command, process.execPath); assert.deepEqual(args, [path.join(sourceRoot, 'src/pi-auth-worker.mjs')]);
    assert.equal(options.env.HOME, context.home); assert.equal(options.env.PI_OAUTH_CALLBACK_HOST, '127.0.0.1'); assert.equal(Object.hasOwn(options.env, 'OD_API_TOKEN'), false);
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
    child.stdin.on('data', line => { submitted = JSON.parse(String(line)); child.stdout.write(JSON.stringify({ phase: 'authorization_completed' }) + '\n'); queueMicrotask(() => child.emit('close', 0)); });
    queueMicrotask(() => { child.stdout.write(JSON.stringify({ phase: 'awaiting_authorization', authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=private-state-fixture' }) + '\n'); child.stdout.write(JSON.stringify({ phase: 'awaiting_authorization', requiresCode: true }) + '\n'); });
    return child;
  } });
  t.after(() => flow.dispose());
  const start = await flow.login('start', 'pi'); assert.equal(start.requiresCode, true); assert.ok(start.authorizationUrl); assert.equal(start.inputKind, 'redirect_url_or_code');
  assert.equal(JSON.stringify(flow.publicStatus()).includes('private-state-fixture'), false); assert.equal(JSON.stringify(flow.publicStatus()).includes('requiresCode'), false);
  const code = 'http://localhost:1455/auth/callback?code=private-code-fixture&state=private-state-fixture';
  await assert.rejects(flow.login('complete', 'pi', { code: 'bad\ncode' }), { code: 'INVALID_LOGIN_INPUT' });
  const complete = await flow.login('complete', 'pi', { code });
  assert.deepEqual(submitted, { action: 'complete', code }); assert.equal(complete.phase, 'authorization_completed'); assert.equal(Object.hasOwn(complete, 'authorizationUrl'), false);
  assert.equal(JSON.stringify(flow.publicStatus()).includes('private-code-fixture'), false);
});

test('SDK loader fails closed when the managed pinned package/repair is absent; secret-looking error category is redacted', async t => {
  const context = fixture(t);
  await assert.rejects(loadPiOAuth(context), { code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(safeError({ code: 'PROVIDER_PRIVATE_ACCOUNT_TOKEN_FIXTURE' }).code, 'RUNTIME_FAILED');
});
