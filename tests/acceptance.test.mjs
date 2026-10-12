import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptanceConfigTemplate } from '../scripts/acceptance-config.mjs';
import {
  AcceptanceError, parseArgs, privatePath, readPrivateJson, writeEvidence,
  signedInProviders, safeCode, statusEvidence, targetOrigin, bridgeRead,
  verifyConversation, verifyRecovery, catalogEvidence,
  authorizedTarget, guardNativeMutations, PRIVATE_ROOT, boundedClientOperation,
} from '../scripts/verify-deployed.mjs';

test('read-only default and explicit mutation gate before config or SDK access', () => {
  assert.equal(parseArgs([]).phase, 'status');
  assert.equal(parseArgs([]).allowMutation, false);
  assert.throws(() => parseArgs(['--phase', 'chat']), { code: 'ACCEPTANCE_MUTATION_NOT_ALLOWED' });
  assert.equal(parseArgs(['--phase', 'chat', '--allow-mutation']).allowMutation, true);
  assert.throws(() => parseArgs(['--token', 'never-print-this']), { code: 'ACCEPTANCE_INVALID_ARGUMENT' });
  assert.throws(() => parseArgs(['--phase', 'anything']), { code: 'ACCEPTANCE_INVALID_PHASE' });
});

test('config scaffold contains no credentials, authorized provider assumptions, or guessed official selectors', () => {
  const template = acceptanceConfigTemplate();
  assert.deepEqual(template.signedInProviders, []);
  assert.deepEqual(template.authorizedTarget, { baseOrigin: '', workspaceId: '', serviceId: '', namespace: '', release: '' });
  assert.equal(template.official.targetDaemonText, '');
  assert.equal(template.official.connected, '');
  assert.equal(template.official.selectors.archive, '');
  assert.equal(template.native.pluginApi, '/api/plugins/woowtech-paseo');
  assert.ok(template.sdk.clientModule.endsWith('/@getpaseo/cli/dist/utils/client.js'));
  const inspect = value => {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!/password|token|cookie|authorization|pairUrl|credential|username/i.test(key), `Scaffold must omit credential field ${key}`);
      if (child && typeof child === 'object') inspect(child);
    }
  };
  inspect(template);
  template.models.claude = 'local-edit';
  assert.equal(acceptanceConfigTemplate().models.claude, '');
});

test('private configuration rejects public paths, symlinks and broad permissions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-acceptance-private-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, '{"signedInProviders":["claude"]}', { mode: 0o600 });
  assert.deepEqual(readPrivateJson(file, { root }).signedInProviders, ['claude']);
  assert.throws(() => privatePath(path.join(root, '../public.json'), root), { code: 'ACCEPTANCE_PRIVATE_PATH_REQUIRED' });
  fs.symlinkSync(file, path.join(root, 'link.json'));
  assert.throws(() => readPrivateJson(path.join(root, 'link.json'), { root }), { code: 'ACCEPTANCE_UNSAFE_PATH' });
  fs.chmodSync(file, 0o644);
  assert.throws(() => readPrivateJson(file, { root }), { code: 'ACCEPTANCE_PRIVATE_FILE_PERMISSIONS' });
  writeEvidence(path.join(root, 'evidence/check.json'), { passed: true }, root);
  assert.equal(fs.statSync(path.join(root, 'evidence/check.json')).mode & 0o777, 0o600);
});

test('provider presence/auth filenames are insufficient to authorize chat', () => {
  assert.throws(() => signedInProviders({ providers: [{ provider: 'claude', credentialPresent: true }] }), { code: 'ACCEPTANCE_SIGNED_IN_PROVIDERS_REQUIRED' });
  assert.deepEqual(signedInProviders({ signedInProviders: ['claude'] }), ['claude']);
  for (const signedInProvidersValue of [[], ['other'], ['claude', 'claude']]) {
    assert.throws(() => signedInProviders({ signedInProviders: signedInProvidersValue }), { code: 'ACCEPTANCE_SIGNED_IN_PROVIDERS_REQUIRED' });
  }
});

test('evidence drops arbitrary auth/raw error fields and only accepts harness error categories', () => {
  const secret = 'password=example-never-copy';
  const value = statusEvidence({ phase: secret, token: secret, version: secret, providers: [{ provider: 'claude', label: secret, authentication: secret }], daemon: { ready: true, password: secret }, state: { pairUrl: secret } });
  assert.equal(JSON.stringify(value).includes(secret), false);
  assert.equal(safeCode(new Error(secret)), 'ACCEPTANCE_FAILED');
  assert.equal(safeCode({ code: 'ACCEPTANCE_TOKEN_' + secret }), 'ACCEPTANCE_FAILED');
  assert.equal(safeCode(new AcceptanceError('ACCEPTANCE_EXPECTED')), 'ACCEPTANCE_EXPECTED');
});

test('targets reject credentials, HTTP, query tokens and fragments', () => {
  assert.equal(targetOrigin({ base: 'https://example.test/' }), 'https://example.test');
  for (const base of ['http://example.test', 'https://user:pass@example.test/', 'https://example.test/?token=secret', 'https://example.test/#pair']) assert.throws(() => targetOrigin({ base }), { code: 'ACCEPTANCE_INVALID_TARGET' });
});

const fakeTarget = { base: 'https://tenant-a.example.test/', workspaceId: 101, serviceId: 202, namespace: 'acceptance-fixture-a', release: 'acceptance-release-a' };
const approvedTarget = { baseOrigin: 'https://tenant-a.example.test', workspaceId: 101, serviceId: 202, namespace: 'acceptance-fixture-a', release: 'acceptance-release-a' };
test('mutation requires an explicit complete private authorizedTarget and matches every field', () => {
  assert.throws(() => authorizedTarget(fakeTarget, acceptanceConfigTemplate()), { code: 'ACCEPTANCE_AUTHORIZED_TARGET_REQUIRED' });
  assert.doesNotThrow(() => authorizedTarget(fakeTarget, { authorizedTarget: approvedTarget }));
  for (const key of Object.keys(fakeTarget)) assert.throws(() => authorizedTarget({ ...fakeTarget, [key]: key === 'base' ? 'https://other.example.test/' : 'other-target' }, { authorizedTarget: approvedTarget }), { code: 'ACCEPTANCE_AUTHORIZED_TARGET_REQUIRED' });
  for (const key of Object.keys(approvedTarget)) {
    const incomplete = { ...approvedTarget }; delete incomplete[key];
    assert.throws(() => authorizedTarget(fakeTarget, { authorizedTarget: incomplete }), { code: 'ACCEPTANCE_AUTHORIZED_TARGET_REQUIRED' });
  }
  for (const baseOrigin of ['https://tenant-a.example.test/', 'https://tenant-a.example.test:443', 'https://TENANT-a.example.test', 'https://tenant-a.example.test.evil.test', 'https://u:p@tenant-a.example.test']) assert.throws(() => authorizedTarget(fakeTarget, { authorizedTarget: { ...approvedTarget, baseOrigin } }), { code: 'ACCEPTANCE_AUTHORIZED_TARGET_REQUIRED' });
});

test('every SDK mutation rechecks authorization; readonly methods need none', async () => {
  const calls = [], target = { ...fakeTarget }, settings = { authorizedTarget: { ...approvedTarget } };
  const client = guardNativeMutations({
    listProviderModels: async () => ({ models: [] }),
    createWorkspace: async () => { calls.push('workspace'); },
    createAgent: async () => { calls.push('agent'); },
    sendAgentMessage: async () => { calls.push('send'); },
    archiveAgent: async () => { calls.push('archive'); },
  }, target, settings);
  for (const method of ['createWorkspace', 'createAgent', 'sendAgentMessage', 'archiveAgent']) {
    await client[method]();
    target.serviceId = 303;
    assert.throws(() => client[method](), { code: 'ACCEPTANCE_AUTHORIZED_TARGET_REQUIRED' });
    await client.listProviderModels();
    target.serviceId = fakeTarget.serviceId;
  }
  assert.deepEqual(calls, ['workspace', 'agent', 'send', 'archive']);
  const reader = guardNativeMutations({ listProviderModels: async () => ({ models: [] }) }, {}, {});
  assert.deepEqual(await reader.listProviderModels(), { models: [] });
});

test('private root defaults to HOME and rejects relative overrides at the file boundary', () => {
  const expected = process.env.OPENDESIGN_PASEO_ACCEPTANCE_PRIVATE_ROOT ?? path.join(os.homedir(), '.private', 'opendesign-paseo');
  assert.equal(PRIVATE_ROOT, expected);
  assert.throws(() => privatePath('/tmp/fake-config.json', 'relative-root'), { code: 'ACCEPTANCE_PRIVATE_ROOT_REQUIRED' });
});

test('SDK operations have a deadline and close their own client on timeout', async () => {
  let closed = 0;
  const client = { close: async () => { closed++; } };
  await assert.rejects(boundedClientOperation(client, () => new Promise(() => {}), 10), { code: 'ACCEPTANCE_NATIVE_SDK_TIMEOUT' });
  assert.equal(closed, 1);
  assert.equal(await boundedClientOperation(client, async () => 'finished', 100), 'finished');
});

test('bridge status uses GET without redirects and never puts auth into URL', async () => {
  const value = await bridgeRead('https://example.test', { username: 'user', password: 'sensitive-value' }, 'status', {}, async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(String(url).includes('sensitive-value'), false);
    assert.equal(url.pathname, '/api/paseo-bridge');
    assert.ok(options.headers.Authorization.startsWith('Basic '));
    return { ok: true, text: async () => '{"phase":"running"}' };
  });
  assert.equal(value.phase, 'running');
  await assert.rejects(bridgeRead('https://example.test', { username: 'u', password: 'p' }, 'status', {}, async () => { throw new Error('raw-token'); }), { code: 'ACCEPTANCE_BRIDGE_UNREACHABLE' });
});

function sdkFixture({ fresh = true, archiveFails = false, firstStatus = 'idle', providerError = false } = {}) {
  const calls = [], marker = 'OD_TEST_MARKER';
  let turn = 1;
  return {
    calls, marker,
    async listProviderModels(provider) { calls.push(['catalog', provider]); return { models: [{ id: 'test-model', isDefault: true }] }; },
    async getProvidersSnapshot() { return { entries: [{ provider: 'claude', defaultModeId: 'default', modes: [{ id: 'default' }] }] }; },
    async createWorkspace(options) { calls.push(['workspace', options]); return { workspace: { id: 'test-workspace' } }; },
    async createAgent(options) { calls.push(['create', options]); return { id: 'owned-acceptance-agent' }; },
    async waitForFinish() { return { status: firstStatus }; },
    async fetchAgentTimeline(id) {
      calls.push(['timeline', id]);
      return { entries: [{ turnId: fresh ? `turn-${turn}` : 'same-turn', seqStart: fresh ? turn : 1, seqEnd: fresh ? turn : 1, timestamp: '2026-10-12T00:00:00Z', item: { type: 'assistant_message', text: providerError ? 'Authentication required. Please sign in.' : marker } }] };
    },
    async sendAgentMessage(id, message) { calls.push(['followup', id, message]); turn++; },
    async archiveAgent(id) { calls.push(['archive', id]); if (archiveFails) throw new Error('unfiltered-server-token'); return { archivedAt: '2026-10-12T00:00:01Z' }; },
  };
}
const config = { authorizedTarget: approvedTarget, signedInProviders: ['claude'], models: { claude: 'test-model' }, modes: { claude: 'default' }, sdk: { cwd: '/dedicated/test-workspace' } };

const testConversation = (client, settings, provider, options = {}) => verifyConversation(client, settings, provider, { target: fakeTarget, ...options });

test('two SDK turn calls accept identical text only with a new timeline cursor; archives own agent', async () => {
  const client = sdkFixture();
  const result = await testConversation(client, { ...config, agentIdsToArchive: ['existing-user-agent'] }, 'claude', { marker: client.marker });
  assert.equal(result.passed, true);
  assert.equal(result.freshCursor, true);
  assert.equal(result.firstReply, true);
  assert.equal(result.followup, true);
  assert.equal(result.cleanup.archived, true);
  assert.deepEqual(client.calls.filter(call => call[0] === 'archive'), [['archive', 'owned-acceptance-agent']]);
  assert.equal(client.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(client.calls.filter(call => call[0] === 'followup').length, 1);
  assert.equal(client.calls.find(call => call[0] === 'create')[1].modeId, 'default');
  assert.equal(JSON.stringify(result).includes(client.marker), false);
  assert.equal(result.transcript.length, 2);
});

test('a stale assistant in a constant-size timeline cannot count as follow-up', async () => {
  const client = sdkFixture({ fresh: false });
  const result = await testConversation(client, config, 'claude', { marker: client.marker });
  assert.equal(result.passed, false);
  assert.equal(result.firstReply, true);
  assert.equal(result.followup, false);
  assert.equal(result.code, 'ACCEPTANCE_FOLLOWUP_NOT_FRESH');
  assert.equal(result.cleanup.archived, true);
});

test('unsigned provider / invalid model and mode fail before creating agents or workspaces', async () => {
  const client = sdkFixture();
  assert.equal((await testConversation(client, config, 'pi')).code, 'ACCEPTANCE_PROVIDER_NOT_SIGNED_IN');
  assert.equal((await testConversation(client, { ...config, models: { claude: 'missing' } }, 'claude')).code, 'ACCEPTANCE_INVALID_MODEL');
  assert.equal((await testConversation(client, { ...config, modes: { claude: 'missing' } }, 'claude')).code, 'ACCEPTANCE_INVALID_MODE');
  assert.equal(client.calls.some(call => ['workspace', 'create', 'archive', 'followup'].includes(call[0])), false);
});

test('timeouts and provider auth replies retain failed result and archive only the created agent', async () => {
  for (const options of [{ firstStatus: 'timeout' }, { providerError: true }]) {
    const client = sdkFixture(options);
    const result = await testConversation(client, config, 'claude', { marker: client.marker });
    assert.equal(result.passed, false);
    assert.equal(result.cleanup.archived, true);
    assert.equal(result.code, options.providerError ? 'ACCEPTANCE_PROVIDER_AUTH_REQUIRED' : 'ACCEPTANCE_PROVIDER_TIMEOUT');
    assert.equal(client.calls.some(call => call[0] === 'followup'), false);
    assert.deepEqual(client.calls.filter(call => call[0] === 'archive'), [['archive', 'owned-acceptance-agent']]);
  }
});

test('cleanup failure prevents passing even when both turns succeeded', async () => {
  const client = sdkFixture({ archiveFails: true });
  const result = await testConversation(client, config, 'claude', { marker: client.marker });
  assert.equal(result.firstReply, true);
  assert.equal(result.followup, true);
  assert.equal(result.passed, false);
  assert.equal(result.code, 'ACCEPTANCE_CLEANUP_FAILED');
  assert.equal(JSON.stringify(result).includes('unfiltered-server-token'), false);
});

test('catalog acceptance uses actual SDK lists and rejects empty catalogs', async () => {
  assert.equal((await catalogEvidence(sdkFixture(), 'claude')).modelCount, 1);
  assert.equal((await catalogEvidence({ listProviderModels: async () => ({ models: [] }), getProvidersSnapshot: async () => ({ entries: [] }) }, 'pi')).passed, false);
});

test('recovery requires stable readiness, enabled intent and same onboarding over multiple samples', async () => {
  const expectations = { recovery: { expectedEnabled: false, expectedReady: false, expectedOnboardingId: 'original-onboarding', intervalMs: 1, samples: 3 } };
  let calls = 0;
  const snapshot = { providers: [], phase: 'disabled', desiredEnabled: false, daemon: { ready: false, running: false, reachable: false }, onboarding: { id: 'original-onboarding' } };
  assert.equal((await verifyRecovery(async () => { calls++; return snapshot; }, expectations)).passed, true);
  assert.equal(calls, 3);
  const changed = await verifyRecovery(async () => ({ ...snapshot, onboarding: { id: 'new-conversation' } }), expectations);
  assert.equal(changed.passed, false);
  assert.equal(JSON.stringify(changed).includes('original-onboarding'), false);
  assert.equal((await verifyRecovery(async () => ({ ...snapshot, daemon: { ready: false, running: true, reachable: false } }), expectations)).passed, false);
  await assert.rejects(verifyRecovery(async () => snapshot, {}), { code: 'ACCEPTANCE_RECOVERY_EXPECTATIONS_REQUIRED' });
});

test('setup default selectors correspond to actual GUI IDs', () => {
  const html = fs.readFileSync(new URL('../ui/setup.html', import.meta.url), 'utf8');
  for (const id of ['main', 'enable', 'disable', 'provider', 'model', 'mode', 'models', 'pair', 'pair-link', 'pair-panel', 'acceptance', 'test-result', 'provider-claude', 'provider-codex', 'provider-pi']) assert.ok(html.includes(`id="${id}"`), `GUI contract missing ${id}`);
  assert.equal(fs.readFileSync(new URL('../scripts/browser-acceptance.py', import.meta.url), 'utf8').includes('woowtech-paseo'), true);
});
