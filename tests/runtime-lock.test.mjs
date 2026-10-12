import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { withLockTransition } from '../vendor/pi-paseo/src/state.mjs';
import { withLock } from '../vendor/pi-paseo/src/onboarding.mjs';
import { sourceRoot } from '../src/runtime-context.mjs';

const helper = path.join(sourceRoot, 'src/flock-helper.py');
const args = [helper, '--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-lock-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
const lock = fd => spawnSync('/usr/bin/python3', args, { stdio: ['ignore', 'ignore', 'ignore', fd] });

test('Python helper retains parent open-description lock after exit, reports real contention, releases on close', t => {
  const root = fixture(t), file = path.join(root, 'guard');
  const parent = fs.openSync(file, 'w+'), contender = fs.openSync(file, 'r+');
  try {
    assert.equal(lock(parent).status, 0);
    assert.equal(lock(contender).status, 73);
    fs.closeSync(parent);
    assert.equal(lock(contender).status, 0);
  } finally { try { fs.closeSync(parent); } catch {} fs.closeSync(contender); }
});

test('bad descriptors/arguments are faults, never contention', () => {
  assert.equal(spawnSync('/usr/bin/python3', args, { stdio: 'ignore' }).status, 70);
  assert.equal(spawnSync('/usr/bin/python3', [helper, '-n', '3'], { stdio: 'ignore' }).status, 70);
});

test('transition guard rejects linked/hardlinked guards and mutated helpers', t => {
  const root = fixture(t), file = path.join(root, 'transition');
  const target = path.join(root, 'target'); fs.writeFileSync(target, '');
  fs.symlinkSync(target, file + '.guard');
  assert.throws(() => withLockTransition(file, () => assert.fail(), { helper }), { code: 'UNSAFE_SYMLINK' });
  fs.unlinkSync(file + '.guard'); fs.linkSync(target, file + '.guard');
  assert.throws(() => withLockTransition(file, () => assert.fail(), { helper }), { code: 'UNSAFE_LOCK' });
  fs.unlinkSync(file + '.guard');
  const bad = path.join(root, 'helper.py'); fs.writeFileSync(bad, 'import sys;sys.exit(0)');
  assert.throws(() => withLockTransition(file, () => assert.fail(), { helper: bad }), { code: 'LOCK_GUARD_FAILED' });
});

test('guard is held throughout synchronous transition and is released when callback throws', t => {
  const root = fixture(t), file = path.join(root, 'transition');
  assert.throws(() => withLockTransition(file, () => {
    const other = fs.openSync(file + '.guard', 'r+');
    try { assert.equal(lock(other).status, 73); } finally { fs.closeSync(other); }
    throw new Error('callback fixture');
  }, { helper }), { code: 'LOCK_GUARD_FAILED' });
  assert.equal(withLockTransition(file, () => 'released', { helper }), 'released');
});

test('runtime lock is exclusive across asynchronous bodies, deadline and cancellation are distinct', async t => {
  const root = fixture(t), file = path.join(root, 'operation');
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const active = withLock(file, async () => { enter(); await gate; }, { helper });
  await entered;
  await assert.rejects(withLock(file, () => assert.fail(), { helper, timeoutMs: 80 }), { code: 'LOCK_BUSY' });
  const abort = new AbortController();
  const waiting = withLock(file, () => assert.fail(), { helper, signal: abort.signal }); abort.abort();
  await assert.rejects(waiting, { code: 'LOCK_ABORTED' });
  release(); await active;
  assert.equal(await withLock(file, () => 'released', { helper }), 'released');
});

test('process death releases kernel lock and a surviving contender can acquire', async t => {
  const root = fixture(t), file = path.join(root, 'crash.guard');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';import {spawnSync} from 'node:child_process';const fd=fs.openSync(${JSON.stringify(file)},'w+');const result=spawnSync('/usr/bin/python3',${JSON.stringify(args)},{stdio:['ignore','ignore','ignore',fd]});process.stdout.write(String(result.status));setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await new Promise(resolve => child.stdout.once('data', data => { assert.equal(String(data), '0'); resolve(); }));
  const other = fs.openSync(file, 'r+');
  try {
    assert.equal(lock(other).status, 73);
    const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await closed;
    assert.equal(lock(other).status, 0);
  } finally { fs.closeSync(other); }
});
