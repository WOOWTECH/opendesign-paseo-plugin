import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeContext, sourceRoot } from '../src/runtime-context.mjs';
import { installProviders, providerRelease, PI_REPAIR, providerEnvironment } from '../src/provider-install.mjs';
import { chatResult } from '../vendor/pi-paseo/src/chat-result.mjs';
import { usingAcceptanceAgent } from '../vendor/pi-paseo/src/acceptance-agent.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-provider-')), home = path.join(root, 'home'), dataDir = path.join(root, 'data'); fs.mkdirSync(home); fs.mkdirSync(dataDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return runtimeContext({ home, dataDir, packageRoot: sourceRoot, env: { PATH: '/usr/bin:/bin', OD_API_TOKEN: 'host-token-fixture' } });
}

test('missing providers install exact pins in persistent user data, repair Pi before CLI, publish stable launchers', async t => {
  const context = fixture(t), calls = [], installed = new Set();
  const discover = command => command === 'claude' ? '/existing/claude' : command === 'npm' ? '/usr/bin/npm' : installed.has(command) ? command : null;
  const run = async (command, args, options) => {
    calls.push({ command, args });
    assert.equal(Object.hasOwn(options.env, 'OD_API_TOKEN'), false); assert.equal(options.env.HOME, context.home);
    if (command === '/usr/bin/npm') {
      assert.equal(args.includes('--global'), false); assert.equal(args.includes('-g'), false);
      const root = args[args.indexOf('--prefix') + 1];
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
      const provider = manifest.name.replace('opendesign-paseo-', '');
      assert.equal(root, providerRelease(context, provider));
      assert.equal(manifest.dependencies[provider === 'pi' ? '@earendil-works/pi-coding-agent' : '@openai/codex'], provider === 'pi' ? '1.0.0' : '0.162.1');
      const bin = path.join(root, 'node_modules/.bin', provider); fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, '# fixture'); installed.add(bin);
      if (provider === 'pi') {
        assert.deepEqual(manifest.overrides, { 'minimatch@10': { 'brace-expansion': PI_REPAIR } });
        fs.mkdirSync(path.join(root, 'node_modules/brace-expansion'), { recursive: true }); fs.writeFileSync(path.join(root, 'node_modules/brace-expansion/package.json'), JSON.stringify({ version: PI_REPAIR }));
        const sdk = path.join(root, 'node_modules/@earendil-works/pi-coding-agent'); fs.mkdirSync(path.join(sdk, 'node_modules/minimatch'), { recursive: true });
        fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0' }));
        fs.writeFileSync(path.join(sdk, 'node_modules/minimatch/package.json'), JSON.stringify({ name: 'minimatch', version: '10.2.6' }));
        const brace = path.join(sdk, 'node_modules/brace-expansion'); fs.cpSync(path.join(sourceRoot, 'node_modules/brace-expansion'), brace, { recursive: true });
        const old = JSON.parse(fs.readFileSync(path.join(brace, 'package.json'))); old.version = '5.0.9'; fs.writeFileSync(path.join(brace, 'package.json'), JSON.stringify(old));
      }
      fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: provider === 'pi' ? { 'node_modules/brace-expansion': { version: PI_REPAIR } } : {} }));
      return '';
    }
    assert.deepEqual(args, ['--version']);
    if (command.endsWith('/pi')) assert.equal(JSON.parse(fs.readFileSync(path.join(providerRelease(context, 'pi'), 'node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json'))).version, PI_REPAIR);
    return command.endsWith('/pi') ? '1.0.0' : 'codex-cli 0.162.1';
  };
  await installProviders(context, { discover, run });
  assert.equal(calls.filter(call => call.command === '/usr/bin/npm').length, 2);
  for (const provider of ['codex', 'pi']) assert.equal(fs.readlinkSync(path.join(context.home, '.local/bin', provider)), path.join(providerRelease(context, provider), 'node_modules/.bin', provider));
  assert.ok(providerEnvironment(context).PATH.includes(path.join(context.home, '.local/bin')));
  assert.equal(fs.existsSync(path.join(context.home, '.claude')), false);
});

test('failed or nested Pi brace repair prevents the first Pi CLI invocation', async t => {
  const context = fixture(t); let invoked = false;
  const discover = command => ['claude', 'codex'].includes(command) ? '/existing/' + command : command === 'npm' ? '/usr/bin/npm' : null;
  await assert.rejects(installProviders(context, { discover, run: async (command, args) => {
    if (command !== '/usr/bin/npm') { invoked = true; return '1.0.0'; }
    const root = args[args.indexOf('--prefix') + 1];
    fs.mkdirSync(path.join(root, 'node_modules/brace-expansion'), { recursive: true }); fs.writeFileSync(path.join(root, 'node_modules/brace-expansion/package.json'), JSON.stringify({ version: PI_REPAIR }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/brace-expansion': { version: PI_REPAIR }, 'node_modules/dependency/node_modules/brace-expansion': { version: '5.0.5' } } }));
    return '';
  } }), { code: 'PROVIDER_REPAIR_FAILED' });
  assert.equal(invoked, false);
});

test('an existing tenant launcher is preserved even when broken and never installed globally', async t => {
  const context = fixture(t);
  await installProviders(context, { discover: name => ['claude', 'codex', 'pi'].includes(name) ? '/existing/' + name : null, run: () => assert.fail('existing commands must be preserved') });
  assert.equal(fs.existsSync(context.toolsDir), false);
});

test('second turn needs a fresh timeline cursor even when bounded window/text are unchanged', async () => {
  let entries = [{ turnId: 'turn1', seqStart: 1, seqEnd: 2, item: { type: 'assistant_message', text: 'same reply' } }];
  const client = { waitForFinish: async () => ({ status: 'idle' }), fetchAgentTimeline: async () => ({ entries }) };
  const previous = JSON.stringify(['turn1', 1, 2, undefined]);
  const stale = await chatResult(client, 'owned_agent', 'codex', 'model', 1000, previous);
  assert.equal(stale.status, 'error'); assert.equal(stale.reply, '');
  entries = [{ ...entries[0], turnId: 'turn2', seqStart: 3, seqEnd: 4 }];
  const fresh = await chatResult(client, 'owned_agent', 'codex', 'model', 1000, previous);
  assert.equal(fresh.status, 'completed'); assert.equal(fresh.reply, 'same reply');
});

test('acceptance cleanup archives only its created agent, including failed verification, and retains history', async () => {
  const archived = [], row = {};
  const client = { createAgent: async () => ({ id: 'created_acceptance_agent' }), archiveAgent: async id => { archived.push(id); return { archivedAt: new Date().toISOString() }; } };
  await assert.rejects(usingAcceptanceAgent(client, { title: 'owned check' }, row, async () => { throw new Error('verification failed'); }));
  assert.deepEqual(archived, ['created_acceptance_agent']); assert.deepEqual(row.cleanup, { archived: true }); assert.equal(row.agentId, 'created_acceptance_agent');
});
