import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runtimeContext, sourceRoot } from '../src/runtime-context.mjs';
import { callRuntime } from '../src/runtime-client.mjs';
import { createAuthFlow, officialAuthorizationUrl } from '../src/auth-flow.mjs';
import { publicStatus, publicAcceptance, publicModels, publicChat, redactText } from '../src/public-dto.mjs';
import { ensureNativeOnboarding, onboardingRecord } from '../src/onboarding.mjs';
import { executeRuntimeJob } from '../src/runtime-worker.mjs';
import { providerEnvironment } from '../src/provider-install.mjs';
import {validateAction} from '../host/security.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createNativeMcp} from '../bin/mcp.mjs';

function fixture(t, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-security-')), home = path.join(root, 'home'), dataDir = path.join(root, 'data');
  fs.mkdirSync(home); fs.mkdirSync(dataDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return runtimeContext({ home, dataDir, packageRoot: sourceRoot, env: { PATH: process.env.PATH, ...env } });
}

test('tenant worker environment strips web/host secrets and foreign controls while preserving tenant provider keys', t => {
  const context = fixture(t, { OD_API_TOKEN: 'host-token-fixture', PI_WEB_PASSWORD: 'web-password-fixture', AUTH_SECRET: 'session-secret-fixture', OPEN_DESIGN_TOKEN: 'other-host-fixture', PASEO_HOST: 'http://foreign', PI_PASEO_STATE_DIR: '/foreign', NODE_OPTIONS: '--require=/foreign', ANTHROPIC_API_KEY: 'tenant-key-fixture' });
  for (const key of ['OD_API_TOKEN', 'PI_WEB_PASSWORD', 'AUTH_SECRET', 'OPEN_DESIGN_TOKEN', 'PASEO_HOST', 'NODE_OPTIONS']) assert.equal(Object.hasOwn(context.env, key), false, key);
  assert.equal(context.env.ANTHROPIC_API_KEY, 'tenant-key-fixture');
  assert.equal(context.env.PI_PASEO_STATE_DIR, path.join(context.dataDir, 'paseo'));
  assert.equal(context.env.PI_PASEO_RUNTIME_DIR, path.join(context.dataDir, 'paseo/packages/runtime'));
  assert.equal(context.env.HOME, context.home);
});

test('Pi without auth.json retains tenant Anthropic authorization and requires chat verification rather than declaring login required', async t => {
  const context = fixture(t, { ANTHROPIC_API_KEY: 'tenant-anthropic-fixture', OD_API_TOKEN: 'host-token-fixture' });
  assert.equal(providerEnvironment(context).ANTHROPIC_API_KEY, 'tenant-anthropic-fixture');
  assert.equal(fs.existsSync(path.join(context.env.PI_CODING_AGENT_DIR, 'auth.json')), false);
  const value = await executeRuntimeJob(context, { action: 'status' }, { status: async () => ({ phase: 'running', providers: [{ provider: 'pi', status: 'ready', enabled: true }], daemon: { owned: true, running: true, reachable: true } }) });
  const pi = value.providers.find(row => row.provider === 'pi');
  assert.equal(pi.credentialPresent, false); assert.equal(pi.authentication, 'needs_chat_verification');
  for (const secret of ['tenant-anthropic-fixture', 'host-token-fixture', 'ANTHROPIC_API_KEY']) assert.equal(JSON.stringify(value).includes(secret), false);
});

test('provider homes cannot escape tenant HOME and redirected state paths fail closed', t => {
  const context = fixture(t);
  assert.throws(() => runtimeContext({ ...context, env: { CODEX_HOME: '/foreign' } }), { code: 'INVALID_PROVIDER_HOME' });
  assert.throws(() => runtimeContext({ ...context, env: { CLAUDE_CONFIG_DIR: '/foreign' } }), { code: 'INVALID_PROVIDER_HOME' });
  const link = path.join(context.dataDir, 'redirect'); fs.symlinkSync(context.home, link);
  assert.throws(() => runtimeContext({ home: context.home, dataDir: link, packageRoot: sourceRoot, env: {} }), { code: 'UNSAFE_SYMLINK' });
});

test('real concurrent status workers remain tenant-isolated without changing the host environment', async t => {
  const a = fixture(t), b = fixture(t);
  fs.mkdirSync(a.stateDir); fs.mkdirSync(b.stateDir);
  fs.writeFileSync(path.join(a.stateDir, 'state.json'), JSON.stringify({ phase: 'disabled', desiredEnabled: false }));
  fs.writeFileSync(path.join(b.stateDir, 'state.json'), JSON.stringify({ phase: 'error', desiredEnabled: true }));
  const before = process.env.PI_PASEO_STATE_DIR;
  const [left, right] = await Promise.all([callRuntime(a, 'status'), callRuntime(b, 'status')]);
  assert.equal(left.phase, 'disabled'); assert.equal(right.phase, 'error');
  assert.equal(process.env.PI_PASEO_STATE_DIR, before);
  assert.equal(Object.hasOwn(left, 'state'), false);
});

test('public DTO excludes raw paths/auth state and chat redacts pairing/provider credentials', () => {
  const snapshot = publicStatus({ state: { token: 'private-value', installationId: 'private-id' }, pairingUrl: 'https://app.paseo.sh/?ticket=private', daemon: { pid: 10, listen: '127.0.0.1:1234', running: true, owned: false, reachable: true } });
  assert.equal(JSON.stringify(snapshot).includes('private'), false); assert.equal(snapshot.daemon.ready, false); assert.equal(Object.hasOwn(snapshot.daemon, 'pid'), false);
  const chat = publicChat({ agentId: 'owned_agent', provider: 'codex', model: 'model', status: 'completed', reply: 'tenant-secret-fixture https://app.paseo.sh/?ticket=PAIR sk-1234567890abcdefghijklmnopqrstuvwxyz api_key=raw-secret' }, { OPENAI_API_KEY: 'tenant-secret-fixture' });
  for (const secret of ['tenant-secret-fixture', '?ticket', 'sk-123456', 'raw-secret']) assert.equal(chat.reply.includes(secret), false);
  assert.equal(redactText('Ordinary discussion of API tokens'), 'Ordinary discussion of API tokens');
});

test('official bracketed model variants survive worker/repeated catalogs and body forwarding with plain redacted labels',async t=>{
  const context=fixture(t,{OPENROUTER_API_KEY:'tenant-model-label-fixture'}),variant='claude-opus-4-8[1m]';
  const raw={provider:'claude',models:[
    {id:'claude-opus-4-8',label:'Claude Opus 4.8'},
    {id:variant,label:'Claude Opus 4.8（1M context）— 官方 tenant-model-label-fixture',defaultThinkingOptionId:'medium',thinkingOptions:[{id:'medium',label:'中等（建議） tenant-model-label-fixture',isDefault:true}]},
  ]};
  const receipt=await executeRuntimeJob(context,{action:'models',input:{provider:'claude'}},{listModels:async()=>raw});
  for(const value of [receipt,publicModels(receipt,context.env)]){
    assert.deepEqual(value.models.map(model=>model.id),['claude-opus-4-8',variant]);
    assert.equal(value.models[1].label,'Claude Opus 4.8（1M context）— 官方 [redacted]');
    assert.equal(value.models[1].thinkingOptions[0].label,'中等（建議） [redacted]');
    assert.equal(JSON.stringify(value).includes('tenant-model-label-fixture'),false);
  }
  const body={action:'acceptance',providers:['claude'],models:{claude:receipt.models[1].id},modes:{claude:'default'}};
  assert.deepEqual(validateAction(body),body);
  let forwarded;
  const server=createNativeMcp({models:async()=>receipt,createChat:async input=>{forwarded=input;return{provider:input.provider,model:input.model,status:'completed',reply:'Synthetic test only'};}},{env:context.env});
  const client=new Client({name:'bracketed-model-fixture',version:'1'}),[left,right]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});await Promise.all([server.connect(left),client.connect(right)]);
  const listing=await client.listTools();assert.equal(listing.tools.find(tool=>tool.name==='paseo_createchat').inputSchema.properties.model.type,'string');
  const catalog=JSON.parse((await client.callTool({name:'paseo_models',arguments:{provider:'claude'}})).content[0].text);
  const response=await client.callTool({name:'paseo_createchat',arguments:{provider:'claude',model:catalog.models[1].id,message:'Synthetic forwarding check'}});
  assert.notEqual(response.isError,true);assert.equal(forwarded.model,variant);assert.equal(JSON.parse(response.content[0].text).model,variant);
  const chat=publicChat({agentId:'owned_variant_fixture',provider:'claude',model:variant,status:'completed',reply:'Synthetic test only'},context.env);assert.equal(chat.model,variant);
  const verified=publicAcceptance({passed:false,providers:[{provider:'claude',model:variant,passed:false}]});assert.equal(verified.providers[0].model,variant);
  const invalid=publicModels({provider:'claude',models:[{id:'claude\ninvalid'},{id:'claude<script>'},{id:'x'.repeat(301)}]});assert.deepEqual(invalid.models,[]);
});

test('protected acceptance retains a failed Pi row through worker and repeated status DTO boundaries, including redacted errors', async t => {
  const context = fixture(t);
  for (const [rawCode, expectedCode] of [['PROVIDER_AUTH_REQUIRED', 'PROVIDER_AUTH_REQUIRED'], ['PRIVATE_PROVIDER_ERROR_FIXTURE', 'RUNTIME_FAILED']]) {
    const raw = { checkedAt: '2026-10-12T00:00:00.000Z', passed: false, providers: [
      { provider: 'claude', passed: true, firstReply: true, followup: true, model: 'claude-haiku-4-5', modeId: 'default', agentId: 'owned_claude_fixture', cleanup: { archived: true } },
      { provider: 'pi', passed: false, firstReply: false, followup: false, model: 'openrouter/anthropic/claude-haiku-4.5', code: rawCode,
        cleanup: { archived: false }, rawError: 'private-provider-output-fixture', credentials: 'private-credential-fixture', authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=private-fixture' },
    ] };
    const receipt = await executeRuntimeJob(context, { action: 'acceptance', input: { providers: ['claude', 'pi'] } }, { acceptance: async () => raw });
    const workerStatus = await executeRuntimeJob(context, { action: 'status' }, { status: async () => ({ phase: 'running', state: { acceptance: raw } }) });
    for (const value of [receipt, publicAcceptance(receipt), workerStatus.lastVerification, publicStatus(workerStatus).lastVerification]) {
      assert.equal(value.passed, false); assert.deepEqual(value.providers.map(row => row.provider), ['claude', 'pi']);
      assert.equal(value.providers[0].passed, true); assert.equal(value.providers[0].cleanup.archived, true);
      assert.equal(value.providers[1].passed, false); assert.equal(value.providers[1].code, expectedCode);
      for (const secret of ['private-provider-output-fixture', 'private-credential-fixture', 'private-fixture', 'PRIVATE_PROVIDER_ERROR_FIXTURE']) assert.equal(JSON.stringify(value).includes(secret), false);
    }
  }
});

test('official authorization URLs reject spoofed host/userinfo/custom port', () => {
  assert.equal(officialAuthorizationUrl('https://auth.openai.com/device?code=FIXTURE', 'codex'), 'https://auth.openai.com/device?code=FIXTURE');
  for (const url of ['https://auth.openai.com.evil.invalid/device', 'https://user@auth.openai.com/device', 'https://auth.openai.com:1234/device']) assert.equal(officialAuthorizationUrl(url, 'codex'), null);
  assert.equal(officialAuthorizationUrl('https://claude.ai/oauth/authorize?state=FIXTURE', 'claude'), 'https://claude.ai/oauth/authorize?state=FIXTURE');
});

test('protected login flow exposes transient typed URL/code, public status does not, cancellation clears them', async t => {
  const context = fixture(t); let child, launchedEnv;
  const flow = createAuthFlow(context, { discover: () => '/tenant/codex', settleMs: 5, launch: (_, args, options) => {
    assert.deepEqual(args, ['login', '--device-auth']); launchedEnv = options.env;
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
    queueMicrotask(() => child.stdout.write('Authorize https://auth.openai.com/device with ABCD-EFGH\nPrivate raw error fixture'));
    return child;
  } });
  t.after(() => flow.dispose());
  const protectedValue = await flow.login('start', 'codex');
  assert.equal(protectedValue.phase, 'awaiting_authorization'); assert.equal(protectedValue.deviceCode, 'ABCD-EFGH'); assert.equal(protectedValue.authorizationUrl, 'https://auth.openai.com/device');
  assert.equal(JSON.stringify(flow.publicStatus()).includes('https://'), false); assert.equal(JSON.stringify(flow.publicStatus()).includes('ABCD-EFGH'), false);
  assert.equal(Object.hasOwn(launchedEnv, 'OD_API_TOKEN'), false);
  await flow.login('cancel', 'codex'); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await flow.login('status', 'codex')).phase, 'cancelled'); assert.equal(JSON.stringify(await flow.login('status', 'codex')).includes('https://'), false);
});

test('existing Claude auth is never replaced; unknown providers stay redacted', async t => {
  const context = fixture(t); fs.mkdirSync(context.env.CLAUDE_CONFIG_DIR); const authFile = path.join(context.env.CLAUDE_CONFIG_DIR, '.credentials.json'); fs.writeFileSync(authFile, 'Existing tenant file fixture');
  const flow = createAuthFlow(context, { launch: () => assert.fail('must not launch when auth exists') });
  assert.equal((await flow.login('start', 'claude')).phase, 'credential_present'); assert.equal(fs.readFileSync(authFile, 'utf8'), 'Existing tenant file fixture');
  await assert.rejects(flow.login('start', 'PRIVATE_PROVIDER'), { code: 'INVALID_PROVIDER', message: 'INVALID_PROVIDER' });
});

test('login flow deadline clears transient auth material and terminates the owned login', async t => {
  const context = fixture(t); let kills = 0;
  const flow = createAuthFlow(context, { discover: () => '/tenant/codex', timeoutMs: 15, settleMs: 1, launch: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { kills++; queueMicrotask(() => child.emit('close', null)); };
    queueMicrotask(() => child.stdout.write('https://auth.openai.com/device ABCD-EFGH'));
    return child;
  } });
  await flow.login('start', 'codex'); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await flow.login('status', 'codex')).phase, 'expired'); assert.equal(kills, 1);
  assert.equal(JSON.stringify(await flow.login('status', 'codex')).includes('ABCD-EFGH'), false);
});

test('bounded onboarding closes late checkpoints and keeps unknown creation pending', async t => {
  const context = fixture(t); let remember;
  await assert.rejects(ensureNativeOnboarding(context, { ensure: async options => { remember = options.remember; await new Promise(() => {}); } }, { timeoutMs: 15 }), { code: 'ONBOARDING_INITIALIZATION_FAILED' });
  assert.throws(() => remember({ conversationId: 'late_conversation' }), { code: 'OPERATION_ABORTED' });
  assert.equal(onboardingRecord(context).creation, 'pending');
  assert.equal(onboardingRecord(context).conversationId, undefined);
});
