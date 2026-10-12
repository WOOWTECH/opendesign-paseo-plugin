import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createManager, OnboardingNotStarted } from '../src/manager.mjs';
import { sourceRoot } from '../src/runtime-context.mjs';

function fixture(t, { onboarding, runtime: override } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-runtime-'));
  const home = path.join(root, 'home'), dataDir = path.join(root, 'data');
  fs.mkdirSync(home); fs.mkdirSync(dataDir);
  let running = false;
  const calls = [];
  const runtime = async (context, action, input, options) => {
    calls.push(action);
    if (override) { const value = await override(context, action, input, options); if (value !== undefined) return value; }
    if (action === 'enable') running = true;
    if (action === 'disable') running = false;
    if (action === 'pair') return { url: 'https://app.paseo.sh/?ticket=PRIVATE_PAIR_FIXTURE' };
    if (action === 'models') return { provider: input.provider, enabled: true, status: 'ready', models: [{ id: 'model-1', label: 'Model 1' }] };
    if (action === 'createchat' || action === 'continue') return { agentId: input.agentId || 'owned_agent_1', provider: 'codex', model: 'model-1', reply: 'New reply', status: 'completed' };
    return { installed: true, version: '0.11.2', phase: running ? 'running' : 'disabled', daemon: { owned: true, running, reachable: running }, providers: [{ provider: 'claude', enabled: true, status: 'ready' }] };
  };
  const supervisor = { start: async () => { calls.push('start-supervisor'); }, stop: async () => { calls.push('stop-supervisor'); } };
  const options = { home, dataDir, packageRoot: sourceRoot, env: { PATH: process.env.PATH }, onboarding };
  const manager = createManager(options, { runtime, supervisor });
  t.after(async () => { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { manager, root, home, dataDir, calls, options, runtime, supervisor };
}

test('manual pause persists across a fresh manager and restore starts no daemon', async t => {
  const f = fixture(t);
  await f.manager.enable(); await f.manager.disable();
  const next = createManager(f.options, { runtime: f.runtime, supervisor: f.supervisor });
  const before = f.calls.length;
  const value = await next.restore();
  assert.equal(value.desiredEnabled, false);
  assert.equal(value.phase, 'disabled');
  assert.deepEqual(f.calls.slice(before), ['status']);
});

test('shutdown cancels recovery and stops owned processes while preserving enable intent', async t => {
  const f = fixture(t);
  await f.manager.enable();
  assert.deepEqual(await f.manager.shutdown(), { desiredEnabled: true, stopped: true });
  const record = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'paseo/bridge.json')));
  assert.equal(record.desiredEnabled, true); assert.equal(record.recoveryArmed, false);
  const next = createManager(f.options, { runtime: f.runtime, supervisor: f.supervisor });
  await next.restore();
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'paseo/bridge.json'))).recoveryArmed, true);
  assert.equal(f.calls.filter(action => action === 'start-supervisor').length, 2);
});

test('lifecycle mutations serialize while concurrent reads coalesce independently', async t => {
  let releaseEnable, releaseStatus, enteredEnable;
  const entered = new Promise(resolve => { enteredEnable = resolve; });
  const gate = new Promise(resolve => { releaseEnable = resolve; });
  let blockRead = true, count = 0;
  const readGate = new Promise(resolve => { releaseStatus = resolve; });
  const f = fixture(t, { runtime: async (_, action) => {
    if (action === 'enable') { enteredEnable(); await gate; }
    if (action === 'status' && blockRead) { count++; await readGate; return { installed: false, phase: 'starting' }; }
  } });
  const enable = f.manager.enable(); await entered;
  const disable = f.manager.disable();
  const a = f.manager.status(), b = f.manager.status();
  releaseStatus();
  assert.deepEqual(await a, await b); assert.equal(count, 1);
  assert.equal(f.calls.includes('disable'), false);
  blockRead = false; releaseEnable();
  await enable; await disable;
  assert.equal((await f.manager.status()).desiredEnabled, false);
  assert.ok(f.calls.indexOf('enable') < f.calls.indexOf('disable'));
});

test('known conversation checkpoint survives a fallible callback and is reused', async t => {
  let created = 0, callbacks = 0;
  const f = fixture(t, { onboarding: { ensure: async ({ remember, known }) => {
    callbacks++;
    if (!known.conversationId) {
      created++; remember({ projectId: 'project_1' }); remember({ conversationId: 'conversation_1', url: '/project/project_1?conversationId=conversation_1' });
      throw new Error('Private provider error fixture');
    }
    assert.equal(known.projectId, 'project_1'); assert.equal(known.conversationId, 'conversation_1'); assert.equal(known.initialized, false);
    return { projectId: known.projectId, conversationId: known.conversationId, url: known.url };
  } } });
  await assert.rejects(f.manager.ensureOnboarding(), { code: 'ONBOARDING_INITIALIZATION_FAILED' });
  const record = await f.manager.ensureOnboarding();
  assert.equal(record.id, 'conversation_1'); assert.equal(record.projectId, 'project_1'); assert.equal(created, 1); assert.equal(callbacks, 2);
  assert.equal(record.initialized, true); assert.equal(record.code, null);
  await f.manager.enable();
  assert.equal(created, 1); assert.equal(callbacks, 2);
});

test('partial project checkpoint resumes using known project without a second project', async t => {
  let calls = 0, projects = 0;
  const f = fixture(t, { onboarding: { ensure: async ({ remember, known }) => {
    calls++;
    if (!known.projectId) { projects++; remember({ projectId: 'project_2' }); throw new Error('HTTP failed after project creation'); }
    assert.equal(known.projectId, 'project_2');
    remember({ conversationId: 'conversation_2' });
    return { projectId: known.projectId, conversationId: 'conversation_2', url: '/project/project_2' };
  } } });
  await assert.rejects(f.manager.ensureOnboarding());
  assert.equal((await f.manager.ensureOnboarding()).conversationId, 'conversation_2');
  assert.equal(calls, 2); assert.equal(projects, 1);
});

test('unknown creation result prevents automatic duplicate while proven noncreation permits retry', async t => {
  let calls = 0;
  const f = fixture(t, { onboarding: async () => { calls++; throw new Error('Unknown creation result'); } });
  await assert.rejects(f.manager.ensureOnboarding());
  await assert.rejects(f.manager.ensureOnboarding(), { code: 'ONBOARDING_RECONCILIATION_REQUIRED' });
  assert.equal(calls, 1);
  const g = fixture(t, { onboarding: async () => { throw new OnboardingNotStarted(); } });
  await assert.rejects(g.manager.ensureOnboarding());
  assert.equal(JSON.parse(fs.readFileSync(path.join(g.dataDir, 'paseo/onboarding.json'))).creation, 'retryable');
});

test('only bridge-created chat IDs can be continued and private chat input is rejected', async t => {
  const f = fixture(t); await f.manager.enable();
  await assert.rejects(f.manager.continueChat({ agentId: 'other_agent_1', message: 'Continue' }), { code: 'AGENT_NOT_OWNED' });
  await assert.rejects(f.manager.createChat({ provider: 'codex', message: 'https://app.paseo.sh/?ticket=secret' }), { code: 'INVALID_MESSAGE' });
  const created = await f.manager.createChat({ provider: 'codex', message: 'Hello' });
  assert.equal((await f.manager.continueChat({ agentId: created.agentId, message: 'Second turn' })).reply, 'New reply');
});

test('status uses an explicit DTO and authorization is independent of CLI readiness', async t => {
  const f = fixture(t, { runtime: async (_, action) => action === 'status' ? { schemaVersion: 1, version: '0.11.2', installed: true, phase: 'running', daemon: { running: true, reachable: true, owned: true }, token: 'PRIVATE_FIXTURE', state: { apiKey: 'PRIVATE_FIXTURE' }, providers: [{ provider: 'claude', status: 'ready', enabled: true, credentialPresent: true, authorizationUrl: 'PRIVATE_FIXTURE' }] } : undefined });
  const value = await f.manager.status();
  assert.equal(JSON.stringify(value).includes('PRIVATE_FIXTURE'), false);
  assert.equal(value.providers[0].authentication, 'needs_chat_verification');
  assert.equal(value.providers[0].chatVerified, false);
});

test('operation failure exposes a fixed code and retains desired enable intent for recovery', async t => {
  const f = fixture(t, { runtime: async (_, action) => { if (action === 'enable') throw Object.assign(new Error('Provider token PRIVATE_FIXTURE'), { code: 'tenant-secret-code' }); } });
  await assert.rejects(f.manager.enable(), { code: 'RUNTIME_FAILED', message: 'RUNTIME_FAILED' });
  const value = await f.manager.status();
  assert.equal(value.desiredEnabled, true); assert.equal(value.operation.status, 'error'); assert.equal(value.operation.code, 'RUNTIME_FAILED');
  assert.equal(JSON.stringify(value).includes('PRIVATE_FIXTURE'), false);
});

test('lifecycle cancellation aborts active work and invalidates queued enables/restores', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { runtime: async (_, action, input, { signal }) => {
    if (action === 'acceptance') {
      enter();
      await new Promise((resolve, reject) => { gate.then(resolve); signal.addEventListener('abort', () => reject({ code: 'OPERATION_ABORTED' }), { once: true }); });
      return { providers: [], passed: false };
    }
  } });
  await f.manager.enable();
  const active = f.manager.acceptance({ providers: ['claude'] }); active.catch(() => {}); await entered;
  const queuedEnable = f.manager.enable(), queuedRestore = f.manager.restore(); queuedEnable.catch(() => {}); queuedRestore.catch(() => {});
  try {
    f.manager.cancelQueuedOperations();
    await assert.rejects(active, { code: 'OPERATION_ABORTED' });
    await assert.rejects(queuedEnable, { code: 'OPERATION_ABORTED' });
    await assert.rejects(queuedRestore, { code: 'OPERATION_ABORTED' });
    await f.manager.disable();
    assert.equal((await f.manager.status()).desiredEnabled, false);
    assert.equal(f.calls.filter(action => action === 'enable').length, 1);
  } finally { release(); await Promise.allSettled([active, queuedEnable, queuedRestore]); }
});
