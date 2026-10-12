import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNativeMcp, nativeTools } from '../bin/mcp.mjs';
import { sourceRoot, runtimeContext } from '../src/runtime-context.mjs';

async function connected(t, manager) {
  const server = createNativeMcp(manager, { env: { OPENAI_API_KEY: 'tenant-key-fixture' } });
  const client = new Client({ name: 'runtime-tests', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('native MCP exposes exactly safe status/models/createchat/continue tools', async t => {
  const client = await connected(t, { status: async () => ({ phase: 'disabled' }) });
  const listing = await client.listTools();
  assert.deepEqual(listing.tools.map(tool => tool.name), ['paseo_status', 'paseo_models', 'paseo_createchat', 'paseo_continue']);
  assert.equal(nativeTools.some(tool => /pair|login|secret/.test(tool.name)), false);
  const result = await client.callTool({ name: 'paseo_pair', arguments: {} });
  assert.equal(result.isError, true); assert.equal(JSON.parse(result.content[0].text).code, 'INVALID_TOOL_INPUT');
});

test('MCP removes protected auth fields, redacts secret-bearing strings and emits only safe error categories', async t => {
  const client = await connected(t, {
    status: async () => ({ phase: 'running', authorizationUrl: 'https://auth.openai.com/?code=PRIVATE', deviceCode: 'PRIVATE', token: 'PRIVATE', state: { raw: 'PRIVATE' }, onboarding: { url: '/project/project1' } }),
    createChat: async () => ({ agentId: 'owned_agent', reply: 'tenant-key-fixture https://app.paseo.sh/?ticket=PRIVATE', status: 'completed' }),
    models: async () => { throw Object.assign(new Error('PRIVATE_PROVIDER_ERROR'), { code: 'Private/provider/error' }); },
  });
  const status = await client.callTool({ name: 'paseo_status', arguments: {} });
  assert.equal(status.content[0].text.includes('PRIVATE'), false); assert.equal(JSON.parse(status.content[0].text).onboarding.url, '/project/project1');
  const chat = await client.callTool({ name: 'paseo_createchat', arguments: { provider: 'codex', message: 'Hello' } });
  assert.equal(chat.content[0].text.includes('tenant-key-fixture'), false); assert.equal(chat.content[0].text.includes('?ticket'), false);
  const error = await client.callTool({ name: 'paseo_models', arguments: { provider: 'codex' } });
  assert.equal(error.isError, true); assert.deepEqual(JSON.parse(error.content[0].text), { code: 'RUNTIME_FAILED' });
  const injection = await client.callTool({ name: 'paseo_status', arguments: { authorizationUrl: 'https://evil.invalid' } });
  assert.equal(injection.isError, true);
});

test('real stdio entrypoint initializes and reports disabled state without leaking web credentials', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-mcp-')), home = path.join(root, 'home'), dataDir = path.join(root, 'data'); fs.mkdirSync(home); fs.mkdirSync(dataDir);
  const context = runtimeContext({ home, dataDir, packageRoot: sourceRoot, env: { PATH: process.env.PATH, OD_API_TOKEN: 'host-secret-fixture' } });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(sourceRoot, 'bin/mcp.mjs')], env: context.env, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1' });
  t.after(async () => { await client.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let stderr = ''; transport.stderr?.on('data', data => { stderr += data; });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 4);
  const result = await client.callTool({ name: 'paseo_status', arguments: {} });
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.desiredEnabled, false); assert.equal(value.daemon.running, false);
  assert.equal(result.content[0].text.includes('host-secret-fixture'), false); assert.equal(stderr, '');
});
