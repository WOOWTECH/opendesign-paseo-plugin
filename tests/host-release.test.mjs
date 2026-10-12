import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installHost } from '../scripts/install-host.mjs';
import { preload, verifyRelease } from '../bin/preload.mjs';
import { applyOverlay } from '../host/overlay.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const nativeArgv = ['node', '/app/apps/daemon/bin/od.mjs'];
import {releaseFixture as fixture} from './host-release-fixture.mjs';

test('real install A -> boot A -> install B -> boot B accepts only verified owned hashes and preserves tenant state', async t => {
  const f = fixture(t); f.write(f.home, '.codex/tenant-fixture', 'tenant-owned');
  const first = await f.install(); assert.equal((await f.boot()).applied, true);
  const before = fs.readFileSync(path.join(f.hostRoot, 'apps/daemon/dist/server.js'), 'utf8');
  assert.ok(before.includes(first.releaseRoot));
  f.revision('B'); const second = await f.install(); assert.notEqual(second.releaseRoot, first.releaseRoot);
  assert.equal((await f.boot()).applied, true);
  const after = fs.readFileSync(path.join(f.hostRoot, 'apps/daemon/dist/server.js'), 'utf8');
  assert.ok(after.includes(second.releaseRoot)); assert.ok(!after.includes(first.releaseRoot));
  const loaded = execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(f.hostRoot, 'apps/daemon/dist/server.js')).href)});process.stdout.write('loaded');`], { encoding: 'utf8' });
  assert.equal(loaded, 'loaded');
  assert.equal(fs.readFileSync(path.join(f.home, '.codex/tenant-fixture'), 'utf8'), 'tenant-owned');
});

test('failed B boot restores verified previous A and keeps the original app importable', async t => {
  const f = fixture(t); const first = await f.install(); await f.boot(); f.revision('B'); const second = await f.install(); await f.boot();
  fs.writeFileSync(path.join(second.releaseRoot, 'host/adapter.mjs'), 'rejected source');
  const boot = await f.boot(); assert.equal(boot.fallback, 'previous'); assert.equal(boot.recovered, true);
  assert.equal(f.pointer('current').releaseRoot, first.releaseRoot);
  assert.ok(fs.readFileSync(path.join(f.hostRoot, 'apps/daemon/dist/server.js'), 'utf8').includes(first.releaseRoot));
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(f.hostRoot, 'apps/daemon/dist/server.js')).href)});process.stdout.write('loaded');`], { encoding: 'utf8' }), 'loaded');
});

test('a missing release manifest or damaged in-release originals still recover through independent pinned stock backups', async t => {
  for (const failure of ['manifest', 'original']) {
    const f = fixture(t); const installed = await f.install(); await f.boot();
    if (failure === 'manifest') fs.unlinkSync(path.join(installed.releaseRoot, '.release.json'));
    else fs.writeFileSync(path.join(installed.releaseRoot, 'overlay/apps/daemon/dist/server.js.original'), 'damaged');
    const result = await f.boot(); assert.equal(result.fallback, 'stock');
    for (const [relative, bytes] of Object.entries(f.stocks)) assert.equal(fs.readFileSync(path.join(f.hostRoot, relative), 'utf8'), bytes);
  }
});

test('foreign host hashes are never overwritten during rejection recovery', async t => {
  const f = fixture(t); const installed = await f.install(); await f.boot();
  const target = path.join(f.hostRoot, 'apps/daemon/dist/server.js'); fs.writeFileSync(target, 'foreign tenant edit');
  fs.writeFileSync(path.join(installed.releaseRoot, 'host/adapter.mjs'), 'rejected');
  await assert.rejects(f.boot(), /HOST_EXTERNAL_CHANGE/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'foreign tenant edit');
});

test('reuse rejects extra, missing, changed dependency files and a foreign private flock helper', async t => {
  for (const failure of ['extra', 'missing', 'dependency', 'guard']) {
    const f = fixture(t); const installed = await f.install();
    if (failure === 'extra') fs.writeFileSync(path.join(installed.releaseRoot, 'unlisted.mjs'), 'unknown');
    if (failure === 'missing') fs.unlinkSync(path.join(installed.releaseRoot, 'host/adapter.mjs'));
    if (failure === 'dependency') fs.writeFileSync(path.join(installed.releaseRoot, 'node_modules/@modelcontextprotocol/sdk/package.json'), '{"version":"1.31.0","changed":true}');
    if (failure === 'guard') fs.writeFileSync(path.join(f.base, 'bin/flock-helper.py'), 'foreign helper');
    assert.throws(() => f.install(), /RELEASE_/);
  }
});

test('a failed pointer publication restores owned bootstrap bytes and a pinned prepared release can be retried', async t => {
  const f = fixture(t); const first = await f.install(); await f.boot();
  const helper = path.join(f.base, 'bin/preload.mjs'), before = fs.readFileSync(helper);
  f.revision('B'); fs.appendFileSync(path.join(f.source, 'bin/preload.mjs'), '\n// Test bootstrap revision B.\n');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === path.join(f.base, 'current.json')) throw new Error('CONTROLLED_PUBLICATION_FAILURE'); return rename(from, to); };
  try { assert.throws(() => f.install(), /CONTROLLED_PUBLICATION_FAILURE/); } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(helper), before); assert.equal(f.pointer('current').releaseRoot, first.releaseRoot);
  const prepared = f.pointer('prepared'); assert.notEqual(prepared.releaseRoot, first.releaseRoot);
  assert.equal((await f.boot()).applied, true);
  const retried = await f.install(); assert.equal(retried.reusedPrepared, true); assert.equal(retried.releaseRoot, prepared.releaseRoot); assert.equal((await f.boot()).applied, true);
});

test('failed multi-file transition restores the exact previously active A bytes', async t => {
  const f = fixture(t); const first = await f.install(); await f.boot();
  const firstReceipt = verifyRelease(f.base, f.pointer('current'));
  f.revision('B'); await f.install(); const secondReceipt = verifyRelease(f.base, f.pointer('current'));
  const rename = fs.renameSync; let failed = false;
  fs.renameSync = (from, to) => { if (!failed && to === path.join(f.hostRoot, 'apps/daemon/dist/plugins/installer.js')) { failed = true; throw new Error('CONTROLLED_TRANSITION_FAILURE'); } return rename(from, to); };
  try { assert.throws(() => applyOverlay(secondReceipt, { previousReceipt: firstReceipt }), { code: 'HOST_RECEIPT_INVALID' }); } finally { fs.renameSync = rename; }
  assert.equal(failed, true);
  for (const entry of firstReceipt.entries) assert.deepEqual(fs.readFileSync(path.join(f.hostRoot, entry.relative)), fs.readFileSync(entry.patchedFile));
  assert.ok(fs.readFileSync(path.join(f.hostRoot, 'apps/daemon/dist/server.js'), 'utf8').includes(first.releaseRoot));
});

function installerChild(f, { paused = false, timeout = 5000 } = {}) {
  const entered = path.join(f.temporary, 'copy-entered'), release = path.join(f.temporary, 'copy-release');
  const script = `import fs from 'node:fs';import {installHost} from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/install-host.mjs')).href)};
${paused ? `const copy=fs.cpSync;let waiting=false;fs.cpSync=(...args)=>{if(!waiting){waiting=true;fs.writeFileSync(${JSON.stringify(entered)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}return copy(...args);};` : ''}
try{const result=installHost({source:${JSON.stringify(f.source)},home:${JSON.stringify(f.home)},hostRoot:${JSON.stringify(f.hostRoot)},lockTimeoutMs:${timeout}});process.stdout.write(JSON.stringify({reused:result.reused===true,root:result.releaseRoot}));}catch(error){process.stdout.write(JSON.stringify({code:error.code||'FAILED'}));process.exitCode=1;}`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  let output = ''; child.stdout.on('data', value => { output += value; });
  const exited = once(child, 'exit');
  return { child, exited, entered, release, result: () => JSON.parse(output) };
}
async function waitEntered(child) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(child.entered) && child.child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(child.entered), true, 'Controlled installer failed to acquire its process lock');
}

test('two real installer processes serialize to one published release and a fully verified reuse', { timeout: 15000 }, async t => {
  const f = fixture(t), first = installerChild(f, { paused: true }); t.after(() => first.child.kill('SIGKILL')); await waitEntered(first);
  const second = installerChild(f); t.after(() => second.child.kill('SIGKILL'));
  await new Promise(resolve => setTimeout(resolve, 100)); fs.writeFileSync(first.release, 'resume');
  const results = await Promise.all([first.exited, second.exited]); assert.deepEqual(results.map(row => row[0]), [0, 0]);
  assert.equal(first.result().root, second.result().root); assert.equal(second.result().reused, true);
  assert.equal(fs.readdirSync(path.join(f.base, 'releases')).length, 1); verifyRelease(f.base, f.pointer('current'));
});

test('a timed-out installer cannot publish and killing the owner releases the real kernel guard', { timeout: 15000 }, async t => {
  const f = fixture(t), first = installerChild(f, { paused: true }); t.after(() => first.child.kill('SIGKILL')); await waitEntered(first);
  assert.throws(() => installHost({ source: f.source, home: f.home, hostRoot: f.hostRoot, lockTimeoutMs: 100 }), /RELEASE_INSTALL_BUSY/);
  assert.equal(fs.existsSync(path.join(f.base, 'current.json')), false);
  first.child.kill('SIGKILL'); await first.exited;
  assert.equal((await f.install()).helperReady, true); assert.equal((await f.boot()).applied, true);
});

test('a rejected applied release restores verified stock before a real server import, never executing rejected adapter', async t => {
  const f = fixture(t); const installed = await f.install(); await f.boot();
  fs.writeFileSync(path.join(installed.releaseRoot, 'host/adapter.mjs'), 'globalThis.rejectedAdapterExecuted=true;export function installBridgeBodyParser(){};export function registerPaseoBridge(){};');
  const boot = await f.boot(); assert.equal(boot.applied, false); assert.equal(boot.recovered, true);
  assert.equal(fs.readFileSync(path.join(f.hostRoot, 'apps/daemon/dist/server.js'), 'utf8'), f.stocks['apps/daemon/dist/server.js']);
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(f.hostRoot, 'apps/daemon/dist/server.js')).href)});process.stdout.write(JSON.stringify({loaded:true,rejected:globalThis.rejectedAdapterExecuted===true}));`], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(result), { loaded: true, rejected: false });
});

test('invalid reused release is rejected; valid reused release repairs missing private helpers and probes flock', async t => {
  const f = fixture(t); const installed = await f.install();
  for (const relative of ['bin/preload.mjs', 'bin/flock-helper.py']) fs.unlinkSync(path.join(f.base, relative));
  assert.equal((await f.install()).reused, true);
  for (const relative of ['bin/preload.mjs', 'bin/flock-helper.py']) assert.equal(fs.statSync(path.join(f.base, relative)).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(installed.releaseRoot, 'host/adapter.mjs'), 'changed');
  assert.throws(() => f.install(), /RELEASE_/);
});

test('previous release validation and foreign host/bootstrap edits fail before publication', async t => {
  const f = fixture(t); const installed = await f.install(); await f.boot(); const original = f.pointer('current');
  f.revision('B'); fs.writeFileSync(path.join(f.hostRoot, 'apps/daemon/dist/server.js'), 'foreign tenant edit');
  assert.throws(() => f.install(), /HOST_EXTERNAL_CHANGE/); assert.deepEqual(f.pointer('current'), original);
  const receipt = verifyRelease(f.base, original); fs.writeFileSync(path.join(f.hostRoot, 'apps/daemon/dist/server.js'), fs.readFileSync(receipt.entries.find(row => row.relative.endsWith('/server.js')).patchedFile));
  fs.writeFileSync(path.join(f.base, 'bin/preload.mjs'), 'foreign bootstrap');
  assert.throws(() => f.install(), /BOOTSTRAP_CONFLICT/); assert.deepEqual(f.pointer('current'), original);
  fs.writeFileSync(path.join(f.base, 'bin/preload.mjs'), fs.readFileSync(path.join(installed.releaseRoot, 'bin/preload.mjs')));
  fs.writeFileSync(path.join(installed.releaseRoot, 'overlay/receipt.json'), '{}');
  assert.throws(() => f.install(), /RELEASE_/); assert.deepEqual(f.pointer('current'), original);
});

test('a forged previous receipt cannot authorize foreign host bytes', t => {
  const f = fixture(t), relative = 'apps/daemon/dist/server.js', originalFile = path.join(f.temporary, 'original'), patchedFile = path.join(f.temporary, 'patch');
  fs.writeFileSync(originalFile, f.stocks[relative]); fs.writeFileSync(patchedFile, 'desired'); fs.writeFileSync(path.join(f.hostRoot, relative), 'foreign');
  const entry = { relative, before: sha(f.stocks[relative]), after: sha('desired'), originalFile, patchedFile, mode: 0o600 };
  assert.throws(() => applyOverlay({ hostRoot: f.hostRoot, entries: [entry] }, { previousReceipt: { hostRoot: f.hostRoot, entries: [{ ...entry, after: sha('foreign') }] } }), /PREVIOUS_RECEIPT/);
});
