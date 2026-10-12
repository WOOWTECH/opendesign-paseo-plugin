import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/verify-deployed.mjs', import.meta.url));
const browser = fileURLToPath(new URL('../scripts/browser-acceptance.py', import.meta.url));
const target = { base: 'https://sdk-fixture.example.test', workspaceId: 101, serviceId: 202, namespace: 'sdk-fixture-namespace', release: 'sdk-fixture-release' };
const approved = { baseOrigin: target.base, workspaceId: 101, serviceId: 202, namespace: target.namespace, release: target.release };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-sdk-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'runtime/node_modules/@getpaseo/cli/dist/utils/client.js');
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.writeFileSync(path.resolve(path.dirname(modulePath), '../../package.json'), '{"type":"module","version":"0.11.2"}');
  fs.writeFileSync(modulePath, `
import fs from 'node:fs';
export async function connectToDaemon() {
 fs.writeFileSync(${JSON.stringify(path.join(root, 'sdk-opened'))}, 'fake-sdk-opened');
 let turn=1, marker='';
 return {
  listProviderModels:async()=>({models:[{id:'fixture-model',isDefault:true}]}),
  getProvidersSnapshot:async()=>({entries:['claude','codex','pi'].map(provider=>({provider,defaultModeId:provider==='pi'?null:'default',modes:provider==='pi'?[]:[{id:'default'}]}))}),
  createWorkspace:async()=>({workspace:{id:'fixture-workspace'}}),
  createAgent:async options=>{if(options.provider==='pi'&&Object.hasOwn(options,'modeId'))throw new Error('Pi fixture has no supported modes');marker=options.initialPrompt.match(/Remember ([A-Za-z0-9_]+)\\./)[1];return{id:'fixture-owned-agent'};},
  waitForFinish:async()=>({status:'idle'}),
  fetchAgentTimeline:async()=>({entries:[{turnId:'turn-'+turn,seqStart:turn,seqEnd:turn,timestamp:'2026-10-12T00:00:0'+turn+'Z',item:{type:'assistant_message',text:marker}}]}),
  sendAgentMessage:async()=>{turn++;},
  archiveAgent:async()=>({archivedAt:'2026-10-12T00:00:01Z'}),
  close:async()=>{},
 };
}
`);
  const config = { authorizedTarget: { ...approved }, signedInProviders: ['claude'], models: { claude: 'fixture-model' }, modes: { claude: 'default' }, sdk: { clientModule: modulePath, target: { kind: 'instance', home: path.join(root, 'paseo-home') }, cwd: path.join(root, 'workspace') } };
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value), { mode: 0o600 });
  write('target.json', target); write('acceptance-config.json', config);
  return { root, config, write, env: { ...process.env, OPENDESIGN_PASEO_ACCEPTANCE_PRIVATE_ROOT: root } };
}
async function invoke(f, args) {
  try { return JSON.parse((await run(process.execPath, [cli, ...args], { env: f.env, timeout: 15000 })).stdout); }
  catch (error) { if (error.stdout) return JSON.parse(error.stdout); throw new Error('Portable acceptance fixture failed without safe evidence'); }
}

test('SDK models and chat use target/config only, with absolute root override and no website credentials', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'acceptance-config.json'));
  const missing = await invoke(f, ['--phase', 'models']);
  assert.equal(missing.passed, false);
  assert.equal(missing.code, 'ACCEPTANCE_PRIVATE_CONFIG_UNAVAILABLE');
  assert.equal(fs.existsSync(path.join(f.root, 'sdk-opened')), false);
  f.write('acceptance-config.json', { ...f.config, authorizedTarget: {} });
  const models = await invoke(f, ['--phase', 'models']);
  assert.equal(models.passed, true);
  assert.equal(models.providers.length, 3);
  assert.equal(models.providers.find(row => row.provider === 'pi').modeCount, 0);
  fs.unlinkSync(path.join(f.root, 'sdk-opened'));
  const denied = await invoke(f, ['--phase', 'chat', '--allow-mutation']);
  assert.equal(denied.code, 'ACCEPTANCE_AUTHORIZED_TARGET_REQUIRED');
  assert.equal(fs.existsSync(path.join(f.root, 'sdk-opened')), false);
  f.write('acceptance-config.json', f.config);
  const chat = await invoke(f, ['--phase', 'chat', '--allow-mutation']);
  assert.equal(chat.passed, true, JSON.stringify(chat));
  assert.equal(chat.providers[0].cleanup.archived, true);
  f.write('acceptance-config.json', { ...f.config, signedInProviders: ['pi'], models: { pi: 'fixture-model' }, modes: { pi: '' } });
  const pi = await invoke(f, ['--phase', 'chat', '--allow-mutation']);
  assert.equal(pi.passed, true, JSON.stringify(pi));
  assert.equal(pi.providers[0].provider, 'pi');
  assert.equal(pi.providers[0].firstReply, true);
  assert.equal(pi.providers[0].followup, true);
  assert.equal(pi.providers[0].freshCursor, true);
  assert.equal(pi.providers[0].cleanup.archived, true);
  assert.equal(fs.existsSync(path.join(f.root, 'browser-auth.json')), false);
  assert.equal(fs.statSync(path.join(f.root, 'acceptance-config.json')).mode & 0o777, 0o600);
});

test('SDK mismatch rejects before connector access and Node/Python portable roots agree', async t => {
  const f = fixture(t);
  f.write('target.json', { ...target, serviceId: 303 });
  const denied = await invoke(f, ['--phase', 'chat', '--allow-mutation']);
  assert.equal(denied.code, 'ACCEPTANCE_AUTHORIZED_TARGET_REQUIRED');
  assert.equal(fs.existsSync(path.join(f.root, 'sdk-opened')), false);
  const code = `
import sys,importlib.util,json
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('acceptance',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assert str(m.PRIVATE_ROOT)==sys.argv[2]
try:m.private_path('/tmp/fixture.json',root='relative-root')
except m.AcceptanceError as error:assert error.code=='ACCEPTANCE_PRIVATE_ROOT_REQUIRED'
else:raise AssertionError('relative private root accepted')
print(json.dumps({'passed':True}))
`;
  const result = await run('python3', ['-c', code, browser, f.root], { env: f.env, timeout: 15000 });
  assert.equal(JSON.parse(result.stdout).passed, true);
});
