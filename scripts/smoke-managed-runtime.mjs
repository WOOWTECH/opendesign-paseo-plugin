import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runtimeContext } from '../src/runtime-context.mjs';
import { runtimeDirectory, runtimeReady, PASEO_VERSION } from '../vendor/pi-paseo/src/runtime-layout.mjs';

// Intended for `docker run --network none`: fresh identity, no account files,
// no inference or pairing, and no writable image runtime.
const root = path.resolve(import.meta.dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'od-agent-connect-smoke-'));
const home = path.join(temporary, 'home');
const dataDir = path.join(temporary, 'data');
fs.mkdirSync(home);
const context = runtimeContext({ home, dataDir, packageRoot: root, env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' } });
assert.equal(context.runtimeDir, path.join(root, 'managed-runtime'));
assert.equal(runtimeReady(context), true);
const receipt = path.join(runtimeDirectory(context), '.pi-paseo-runtime.json');
const digest = () => createHash('sha256').update(fs.readFileSync(receipt)).digest('hex');
const before = { digest: digest(), mtime: fs.statSync(receipt).mtimeMs };
Object.assign(process.env, context.env);
const runtime = await import('../vendor/pi-paseo/src/runtime.mjs');
let stopped = false;
try {
  const started = await runtime.activate();
  assert.equal(started.version, PASEO_VERSION);
  assert.equal(started.daemon.owned, true);
  assert.equal(started.daemon.running, true);
  assert.equal(started.daemon.reachable, true);
  await runtime.deactivate();
  stopped = true;
  const status = await runtime.status();
  assert.equal(status.daemon.running, false);
  assert.equal(fs.existsSync(path.join(dataDir, 'paseo/packages/runtime')), false);
  assert.equal(digest(), before.digest);
  assert.equal(fs.statSync(receipt).mtimeMs, before.mtime);
  console.log(JSON.stringify({ version: PASEO_VERSION, offlineFirstActivation: true, ownedDaemonStarted: true, ownedDaemonStopped: true, imageRuntimeUntouched: true, tenantRuntimeInstallAbsent: true, modelCalls: 0, pairedClients: 0 }));
} finally {
  if (!stopped) {
    await runtime.deactivate();
    stopped = (await runtime.status()).daemon.running === false;
  }
  if (!stopped) throw new Error('OWNED_DAEMON_CLEANUP_NOT_CONFIRMED');
  fs.rmSync(temporary, { recursive: true, force: true });
}
