import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { providerReplyError, providerTurnError } from '../vendor/pi-paseo/src/provider-reply.mjs';
import { safeChatResult } from '../vendor/pi-paseo/src/safe-chat-result.mjs';
import { usingAcceptanceWorkspace } from '../vendor/pi-paseo/src/acceptance-workspace.mjs';
import { usingAcceptanceAgent } from '../vendor/pi-paseo/src/acceptance-agent.mjs';
import { acceptance, createChat, continueChat, locations } from '../vendor/pi-paseo/src/runtime.mjs';
import { runtimeDirectory } from '../vendor/pi-paseo/src/runtime-layout.mjs';
import { publicAcceptance, publicChat } from '../src/public-dto.mjs';

const privateFixture = 'private-provider-detail-fixture';
const billing = `402 billing_error: This request requires more credits. ${privateFixture}`;
const model = 'openrouter/anthropic/claude-haiku-4.5';
const date = '2026-10-25T09:00:00.000Z';

for (const message of [billing, 'Insufficient credits', 'Your credit balance is too low', 'Payment required', 'insufficient_quota', "You’ve hit your weekly limit"]) {
  test('quota classification: ' + message.split(':')[0], () => {
    assert.equal(providerReplyError(message), 'PROVIDER_QUOTA_EXHAUSTED');
    assert.equal(providerTurnError({ status: 'error', error: message }), 'PROVIDER_QUOTA_EXHAUSTED');
  });
}

test('turn classifier preserves status precedence and never interprets an ordinary number as billing', () => {
  assert.equal(providerTurnError({ status: 'permission', error: billing }), 'PERMISSION_REQUIRED');
  assert.equal(providerTurnError({ status: 'timeout', error: billing }), 'PROVIDER_TIMEOUT');
  assert.equal(providerTurnError({ status: 'idle', error: billing }), null);
  assert.equal(providerTurnError({ status: 'error', error: 'Invalid API key ' + privateFixture }), 'PROVIDER_AUTH_REQUIRED');
  for (const error of ['task 402 failed', privateFixture, '', null, { message: billing }]) {
    assert.equal(providerTurnError({ status: 'error', error }), 'PROVIDER_TURN_FAILED');
  }
  assert.equal(providerReplyError('The answer is 402.'), null);
});

for (const [status, error, expected] of [
  ['error', billing, { status: 'error', code: 'PROVIDER_QUOTA_EXHAUSTED' }],
  ['error', privateFixture, { status: 'error', code: 'PROVIDER_TURN_FAILED' }],
  ['permission', billing, { status: 'permission_required' }],
  ['timeout', billing, { status: 'pending' }],
]) {
  test('chat ' + status + ' returns only a fixed code and empty reply', async () => {
    let waits = 0;
    const client = {
      waitForFinish: async () => { waits++; return { status, error, lastMessage: privateFixture, final: { privateFixture } }; },
      fetchAgentTimeline: () => assert.fail('failed turns must not read or return provider partial output'),
    };
    const result = await safeChatResult(client, 'owned_agent', 'pi', model, 1000);
    assert.deepEqual(result, { agentId: 'owned_agent', provider: 'pi', model, reply: '', ...expected });
    assert.equal(waits, 1);
    assert.equal(JSON.stringify(publicChat(result)).includes(privateFixture), false);
  });
}

test('successful chat retains cursor rules; quota text on an idle turn is suppressed', async () => {
  let text = 'ordinary answer';
  const client = { waitForFinish: async () => ({ status: 'idle' }), fetchAgentTimeline: async () => ({ entries: [{ turnId: 'turn1', seqStart: 1, seqEnd: 2, item: { type: 'assistant_message', text } }] }) };
  assert.equal((await safeChatResult(client, 'owned_agent', 'pi', model, 1000)).reply, text);
  const stale = await safeChatResult(client, 'owned_agent', 'pi', model, 1000, JSON.stringify(['turn1', 1, 2, undefined]));
  assert.equal(stale.status, 'error'); assert.equal(stale.reply, '');
  text = billing;
  const failed = await safeChatResult(client, 'owned_agent', 'pi', model, 1000);
  assert.equal(failed.code, 'PROVIDER_QUOTA_EXHAUSTED'); assert.equal(failed.reply, '');
});

function workspaceFixture(t, overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-acceptance-cleanup-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'shared.txt'); fs.writeFileSync(file, 'peer content');
  const workspace = { id: 'fresh_owned_workspace', projectId: 'same_project', workspaceKind: 'directory', workspaceDirectory: cwd };
  const archived = [], agents = [], row = {}, calls = [];
  const client = {
    createWorkspace: async input => { assert.deepEqual(input, { source: { kind: 'directory', path: cwd } }); return { workspace }; },
    archiveWorkspace: async id => { archived.push(id); return { workspaceId: id, archivedAt: date, error: null }; },
    fetchWorkspaces: async input => { calls.push(input); return { entries: [{ id: 'peer_workspace', workspaceDirectory: cwd }], pageInfo: { hasMore: false, nextCursor: null } }; },
    createAgent: async () => ({ id: 'fresh_owned_agent' }),
    archiveAgent: async id => { agents.push(id); return { archivedAt: date }; },
    ...overrides,
  };
  return { cwd, file, workspace, archived, agents, row, calls, client };
}

for (const failure of [false, true]) {
  test('workspace is archived after ' + (failure ? 'failed' : 'successful') + ' verification, retaining shared files and peer workspace', async t => {
    const h = workspaceFixture(t);
    const run = () => usingAcceptanceWorkspace(h.client, h.cwd, h.row, workspace => usingAcceptanceAgent(h.client, { workspaceId: workspace.id }, h.row, async () => {
      if (failure) throw Object.assign(new Error('PROVIDER_QUOTA_EXHAUSTED'), { code: 'PROVIDER_QUOTA_EXHAUSTED' });
      h.row.passed = true;
    }));
    if (failure) await assert.rejects(run(), { code: 'PROVIDER_QUOTA_EXHAUSTED' }); else await run();
    assert.deepEqual(h.archived, ['fresh_owned_workspace']); assert.deepEqual(h.agents, ['fresh_owned_agent']);
    assert.deepEqual(h.row.workspaceCleanup, { archived: true }); assert.deepEqual(h.row.cleanup, { archived: true });
    assert.equal(fs.readFileSync(h.file, 'utf8'), 'peer content');
  });
}

test('agent creation failure still cleans its freshly created workspace', async t => {
  const h = workspaceFixture(t, { createAgent: async () => { throw new Error(privateFixture); } });
  await assert.rejects(usingAcceptanceWorkspace(h.client, h.cwd, h.row, () => usingAcceptanceAgent(h.client, {}, h.row, () => assert.fail())));
  assert.deepEqual(h.archived, ['fresh_owned_workspace']); assert.deepEqual(h.row.workspaceCleanup, { archived: true });
  assert.equal(JSON.stringify(h.row).includes(privateFixture), false);
});

for (const variant of ['throw', 'error_receipt', 'wrong_id', 'missing_date', 'still_active', 'incomplete_pages', 'agent_cleanup_failed']) {
  test('cleanup failure cannot pass: ' + variant, async t => {
    const h = workspaceFixture(t);
    if (variant === 'throw') h.client.archiveWorkspace = async () => { throw new Error(privateFixture); };
    if (variant === 'error_receipt') h.client.archiveWorkspace = async () => ({ workspaceId: h.workspace.id, archivedAt: date, error: privateFixture });
    if (variant === 'wrong_id') h.client.archiveWorkspace = async () => ({ workspaceId: 'peer_workspace', archivedAt: date });
    if (variant === 'missing_date') h.client.archiveWorkspace = async () => ({ workspaceId: h.workspace.id });
    if (variant === 'still_active') h.client.fetchWorkspaces = async () => ({ entries: [h.workspace], pageInfo: { hasMore: false } });
    if (variant === 'incomplete_pages') h.client.fetchWorkspaces = async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: null } });
    await usingAcceptanceWorkspace(h.client, h.cwd, h.row, async () => { h.row.passed = true; h.row.cleanup = { archived: variant !== 'agent_cleanup_failed' }; });
    assert.equal(h.row.passed, false); assert.deepEqual(h.row.cleanup, { archived: false, code: 'ACCEPTANCE_CLEANUP_FAILED' });
    assert.equal(h.row.code, 'ACCEPTANCE_CLEANUP_FAILED'); assert.equal(JSON.stringify(h.row).includes(privateFixture), false);
    assert.equal(publicAcceptance({ providers: [{ ...h.row, provider: 'pi' }] }).providers[0].passed, false);
  });
}

test('archival confirmation follows pagination rather than trusting the first page', async t => {
  const h = workspaceFixture(t); let pages = 0;
  h.client.fetchWorkspaces = async input => { pages++; assert.equal(input.filter.projectId, 'same_project');
    if (pages === 1) return { entries: [], pageInfo: { hasMore: true, nextCursor: 'page2' } };
    assert.equal(input.page.cursor, 'page2'); return { entries: [h.workspace], pageInfo: { hasMore: false } };
  };
  await usingAcceptanceWorkspace(h.client, h.cwd, h.row, async () => { h.row.passed = true; });
  assert.equal(pages, 2); assert.equal(h.row.workspaceCleanup.archived, false); assert.equal(h.row.passed, false);
});

test('unknown creation and worktree responses never authorize archival or directory removal', async t => {
  const h = workspaceFixture(t);
  h.client.createWorkspace = async () => ({ error: privateFixture });
  await assert.rejects(usingAcceptanceWorkspace(h.client, h.cwd, h.row, () => assert.fail()), { code: 'WORKSPACE_CREATE_FAILED' });
  h.client.createWorkspace = async () => ({ workspace: { ...h.workspace, workspaceKind: 'worktree', worktreeSlug: 'owned_tree' } });
  await assert.rejects(usingAcceptanceWorkspace(h.client, h.cwd, h.row, () => assert.fail()), { code: 'WORKSPACE_CREATE_FAILED' });
  assert.deepEqual(h.archived, []); assert.equal(fs.readFileSync(h.file, 'utf8'), 'peer content');
});

function runtimeFixture(t, failedTurn = 1) {
  const h = workspaceFixture(t), env = {
    HOME: h.cwd, PI_CODING_AGENT_DIR: path.join(h.cwd, 'agent'), PI_PASEO_STATE_DIR: path.join(h.cwd, 'state'),
    PI_PASEO_RUNTIME_DIR: path.join(h.cwd, 'runtime'), PI_PASEO_FLOCK_HELPER: path.resolve('src/flock-helper.py'),
  }, previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const key = 'acceptance_fixture_' + path.basename(h.cwd);
  t.after(() => { delete globalThis[key]; for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const entry = path.join(runtimeDirectory(locations()), 'node_modules/@getpaseo/cli/dist/utils/client.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(entry), 'package.json'), '{"type":"module"}');
  fs.writeFileSync(entry, `export async function connectToDaemon(){return globalThis[${JSON.stringify(key)}];}`);
  let turn = 0, marker = '', sent = 0;
  h.client.close = async () => {};
  h.client.listProviderModels = async () => ({ models: [{ id: model, isDefault: true }] });
  h.client.getProvidersSnapshot = async () => ({ entries: [{ provider: 'pi', modes: [] }] });
  h.client.createAgent = async options => { marker = options.initialPrompt.match(/PI_PASEO_[a-z0-9]+/)?.[0] || 'ordinary'; return { id: 'fresh_owned_agent' }; };
  h.client.waitForFinish = async () => (++turn === failedTurn ? { status: 'error', error: billing, lastMessage: privateFixture } : { status: 'idle' });
  h.client.fetchAgentTimeline = async () => ({ entries: [{ turnId: String(turn), seqStart: turn, seqEnd: turn, item: { type: 'assistant_message', text: marker } }] });
  h.client.sendAgentMessage = async () => { sent++; };
  h.client.fetchAgent = async () => ({ agent: { id: 'fresh_owned_agent', provider: 'pi', model } });
  globalThis[key] = h.client;
  return { ...h, sent: () => sent };
}

for (const failedTurn of [1, 2]) {
  test('actual acceptance classifies failed turn ' + failedTurn + ' and archives only its fresh workspace', async t => {
    const h = runtimeFixture(t, failedTurn);
    const value = await acceptance({ providers: ['pi'], cwd: h.cwd });
    const row = value.providers[0];
    assert.equal(row.code, 'PROVIDER_QUOTA_EXHAUSTED'); assert.equal(row.passed, false);
    assert.equal(row.firstReply, failedTurn === 2); assert.equal(h.sent(), failedTurn === 2 ? 1 : 0);
    assert.deepEqual(h.archived, ['fresh_owned_workspace']); assert.deepEqual(h.agents, ['fresh_owned_agent']);
    assert.equal(row.workspaceCleanup.archived, true); assert.equal(row.cleanup.archived, true);
    assert.equal(JSON.stringify(value).includes(privateFixture), false);
    assert.equal(fs.readFileSync(path.join(h.cwd, 'state/state.json'), 'utf8').includes(privateFixture), false);
    assert.equal(publicAcceptance(value).providers[0].code, 'PROVIDER_QUOTA_EXHAUSTED');
  });
}

for (const action of ['create', 'continue']) {
  test('actual ' + action + ' chat classifies a billing failure without returning raw details', async t => {
    const h = runtimeFixture(t);
    const result = action === 'create' ? await createChat({ provider: 'pi', message: 'check', cwd: h.cwd })
      : await continueChat({ agentId: 'fresh_owned_agent', message: 'check' });
    assert.equal(result.code, 'PROVIDER_QUOTA_EXHAUSTED'); assert.equal(result.status, 'error'); assert.equal(result.reply, '');
    assert.equal(JSON.stringify(result).includes(privateFixture), false);
    assert.deepEqual(h.archived, [], 'normal chat workspace must remain active');
  });
}

for (const cleanupFailed of [false, true]) {
  test('actual successful acceptance requires workspace cleanup: ' + cleanupFailed, async t => {
    const h = runtimeFixture(t, -1);
    if (cleanupFailed) h.client.archiveWorkspace = async () => { throw new Error(privateFixture); };
    const result = await acceptance({ providers: ['pi'], cwd: h.cwd });
    const row = result.providers[0];
    assert.equal(row.firstReply, true); assert.equal(row.followup, true);
    assert.equal(row.passed, !cleanupFailed); assert.equal(row.cleanup.archived, !cleanupFailed);
    assert.equal(row.workspaceCleanup.archived, !cleanupFailed);
    if (cleanupFailed) assert.equal(row.code, 'ACCEPTANCE_CLEANUP_FAILED');
    assert.equal(JSON.stringify(result).includes(privateFixture), false);
    assert.equal(fs.readFileSync(h.file, 'utf8'), 'peer content');
  });
}
