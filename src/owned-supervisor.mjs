import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { processIdentity, RuntimeError, assertSafePath } from '../vendor/pi-paseo/src/state.mjs';
import { readRecord, writeRecord } from '../vendor/pi-paseo/src/onboarding.mjs';
import { contained } from './runtime-context.mjs';
import { providerEnvironment } from './provider-install.mjs';

export function supervisorOwned(context, record) {
  if (!record?.identity || !Number.isInteger(record.pid) || record.pid <= 1 || processIdentity(record.pid) !== record.identity) return false;
  if (typeof record.packageRoot !== 'string' || (!contained(context.toolsDir, record.packageRoot) && !contained(context.sourceStore, record.packageRoot) && record.packageRoot !== context.packageRoot)) return false;
  if (process.platform !== 'linux') return false;
  try {
    const args = fs.readFileSync(`/proc/${record.pid}/cmdline`, 'utf8').split('\0');
    const env = fs.readFileSync(`/proc/${record.pid}/environ`, 'utf8').split('\0');
    return fs.statSync(`/proc/${record.pid}`).uid === process.getuid() && fs.realpathSync(`/proc/${record.pid}/exe`) === fs.realpathSync(process.execPath) &&
      args.includes(path.join(record.packageRoot, 'bin/supervise.mjs')) && env.includes(`OPENDESIGN_PASEO_DATA_DIR=${context.dataDir}`) && env.includes(`HOME=${context.home}`);
  } catch { return false; }
}

export async function stopOwnedSupervisor(context, { timeoutMs = 6000 } = {}) {
  const file = path.join(context.stateDir, 'supervisor.json'), record = readRecord(file);
  if (!supervisorOwned(context, record)) {
    if (record.pid && processIdentity(record.pid)) throw new RuntimeError('SUPERVISOR_NOT_OWNED');
    return { running: false };
  }
  process.kill(record.pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (supervisorOwned(context, record)) {
    if (Date.now() >= deadline) {
      // Recheck exact identity/environment immediately before escalation.
      if (supervisorOwned(context, record)) process.kill(record.pid, 'SIGKILL');
      await delay(100);
      if (supervisorOwned(context, record)) throw new RuntimeError('SUPERVISOR_STOP_TIMEOUT');
      break;
    }
    await delay(50);
  }
  return { running: false };
}

/** Caller holds the manager lifecycle lock. */
export async function startOwnedSupervisor(context) {
  const file = path.join(context.stateDir, 'supervisor.json'), previous = readRecord(file);
  if (supervisorOwned(context, previous)) {
    if (previous.packageRoot === context.packageRoot) return { running: true };
    await stopOwnedSupervisor(context);
  } else if (previous.pid && processIdentity(previous.pid)) throw new RuntimeError('SUPERVISOR_NOT_OWNED');
  assertSafePath(path.join(context.packageRoot, 'bin/supervise.mjs'));
  const child = spawn(process.execPath, [path.join(context.packageRoot, 'bin/supervise.mjs')], { cwd: context.home, env: providerEnvironment(context), detached: true, shell: false, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new RuntimeError('SUPERVISOR_UNAVAILABLE'))); });
  const identity = processIdentity(child.pid);
  if (!identity) throw new RuntimeError('SUPERVISOR_UNAVAILABLE');
  writeRecord(file, { pid: child.pid, identity, packageRoot: context.packageRoot, startedAt: new Date().toISOString() });
  child.unref();
  return { running: true };
}
