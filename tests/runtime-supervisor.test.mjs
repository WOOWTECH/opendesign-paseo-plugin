import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runtimeContext, sourceRoot } from '../src/runtime-context.mjs';
import { processIdentity } from '../vendor/pi-paseo/src/state.mjs';
import { writeRecord } from '../vendor/pi-paseo/src/onboarding.mjs';
import { supervisorOwned, startOwnedSupervisor, stopOwnedSupervisor } from '../src/owned-supervisor.mjs';
import { runSupervision } from '../bin/supervise.mjs';
import { createManager } from '../src/manager.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-supervisor-')), home = path.join(root, 'home'), dataDir = path.join(root, 'data'), packageRoot = path.join(root, 'source');
  for (const dir of [home, dataDir, path.join(packageRoot, 'bin'), path.join(packageRoot, 'src')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'bin/supervise.mjs'), 'setInterval(() => {}, 1000);\n');
  fs.copyFileSync(path.join(sourceRoot, 'src/flock-helper.py'), path.join(packageRoot, 'src/flock-helper.py'));
  const context = runtimeContext({ home, dataDir, packageRoot, env: { PATH: process.env.PATH } });
  fs.mkdirSync(context.stateDir);
  t.after(async () => { try { await stopOwnedSupervisor(context); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  return context;
}

test('real supervisor start is idempotent and ownership-checked stop affects only its own process', async t => {
  const context = fixture(t);
  await startOwnedSupervisor(context);
  const first = JSON.parse(fs.readFileSync(path.join(context.stateDir, 'supervisor.json')));
  assert.equal(supervisorOwned(context, first), true);
  await startOwnedSupervisor(context);
  assert.equal(JSON.parse(fs.readFileSync(path.join(context.stateDir, 'supervisor.json'))).pid, first.pid);
  await stopOwnedSupervisor(context);
  assert.equal(supervisorOwned(context, first), false);
});

test('foreign PID records fail closed and are never signalled', async t => {
  const context = fixture(t);
  writeRecord(path.join(context.stateDir, 'supervisor.json'), { pid: process.pid, identity: processIdentity(process.pid), packageRoot: context.packageRoot });
  await assert.rejects(stopOwnedSupervisor(context), { code: 'SUPERVISOR_NOT_OWNED' });
  await assert.rejects(startOwnedSupervisor(context), { code: 'SUPERVISOR_NOT_OWNED' });
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('a recycled PID with a different start identity is left alone during recovery',async t=>{
  const context=fixture(t);
  writeRecord(path.join(context.stateDir,'supervisor.json'),{pid:process.pid,identity:'0',packageRoot:context.packageRoot});
  assert.deepEqual(await stopOwnedSupervisor(context),{running:false});
  await startOwnedSupervisor(context);
  const current=JSON.parse(fs.readFileSync(path.join(context.stateDir,'supervisor.json')));
  assert.notEqual(current.pid,process.pid);assert.equal(supervisorOwned(context,current),true);
  assert.doesNotThrow(()=>process.kill(process.pid,0));
});

test('supervision retries a transient crash, recovers, and exits immediately on a persisted pause', async () => {
  let tries = 0, cancelled = false;
  await runSupervision({ reconcile: async () => { tries++; if (tries === 1) throw { code: 'DAEMON_UNREACHABLE' }; return { desiredEnabled: tries < 3 }; }, cancelPending: () => { cancelled = true; } }, { intervalMs: 1, maxBackoffMs: 2 });
  assert.equal(tries, 3); assert.equal(cancelled, false);
});

test('shutdown aborts an in-flight activation and never allows it to restart after stop', async t => {
  const context = fixture(t), controllerEntered = {};
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  const events = [];
  const manager = createManager({ ...context, env: context.env }, { supervisor: { start: async () => events.push('start-supervisor'), stop: async () => events.push('stop-supervisor') }, runtime: async (_, action, input, options) => {
    events.push(action);
    if (action === 'enable') { controllerEntered.signal = options.signal; enter(); await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject({ code: 'OPERATION_ABORTED' }), { once: true })); }
    return { phase: 'disabled', daemon: { running: false } };
  } });
  const enabling = manager.enable(); await entered;
  const stopping = manager.shutdown();
  await assert.rejects(enabling, { code: 'OPERATION_ABORTED' });
  assert.equal((await stopping).desiredEnabled, true); assert.equal(controllerEntered.signal.aborted, true);
  assert.deepEqual(events, ['start-supervisor', 'enable', 'stop-supervisor', 'disable']);
  await assert.rejects(manager.enable(), { code: 'SERVICE_DISPOSED' });
});
