import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeContext, sourceRoot } from '../src/runtime-context.mjs';
import { prepareRuntimeManifest, markRuntimeReady, runtimeReady, runtimeDirectory } from '../vendor/pi-paseo/src/runtime-layout.mjs';

// The image builds the managed Paseo runtime at build time into <packageRoot>/managed-runtime.
// Everything below is a fixture: no npm, no network, no daemon.
function tenant(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-bundled-')), home = path.join(root, 'home'), dataDir = path.join(root, 'data');
  const packageRoot = path.join(root, 'opt/opendesign-paseo');
  fs.mkdirSync(home); fs.mkdirSync(dataDir); fs.mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'src/runtime-worker.mjs'), '');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, dataDir, packageRoot };
}
function bake(directory) {
  const loc = { runtimeDir: directory };
  const release = prepareRuntimeManifest(loc);
  fs.mkdirSync(path.join(release, 'node_modules/@getpaseo/cli'), { recursive: true });
  fs.writeFileSync(path.join(release, 'node_modules/@getpaseo/cli/package.json'), JSON.stringify({ name: '@getpaseo/cli', version: '0.11.2' }));
  markRuntimeReady(loc);
  assert.equal(runtimeReady(loc), true);
  return loc;
}
const context = (fixture, env = {}) => runtimeContext({ home: fixture.home, dataDir: fixture.dataDir, packageRoot: fixture.packageRoot, env: { PATH: process.env.PATH, ...env } });
const volumeRuntime = fixture => path.join(fixture.dataDir, 'paseo/packages/runtime');

test('a ready managed runtime shipped with the package is used in place; the tenant volume gets no runtime directory', t => {
  const fixture = tenant(t), bundled = path.join(fixture.packageRoot, 'managed-runtime');
  const loc = bake(bundled);
  const value = context(fixture);
  assert.equal(value.runtimeDir, bundled);
  assert.equal(value.env.PI_PASEO_RUNTIME_DIR, bundled);
  assert.ok(runtimeDirectory(loc).startsWith(bundled));
  assert.equal(fs.existsSync(volumeRuntime(fixture)), false);
});

test('every nested process (supervisor, worker, stdio MCP) derives the same runtime from the package root it is handed', t => {
  const fixture = tenant(t);
  bake(path.join(fixture.packageRoot, 'managed-runtime'));
  const parent = context(fixture);
  // The child environment drops OPENDESIGN_/PI_PASEO_ variables the parent was started with, but keeps the package root.
  const child = runtimeContext({ home: fixture.home, dataDir: fixture.dataDir, packageRoot: parent.env.OPENDESIGN_PASEO_PACKAGE_ROOT, env: parent.env });
  assert.equal(child.runtimeDir, parent.runtimeDir);
});

test('without a ready managed runtime the volume install stays the fallback', t => {
  const fixture = tenant(t);
  assert.equal(context(fixture).env.PI_PASEO_RUNTIME_DIR, volumeRuntime(fixture));
  fs.mkdirSync(path.join(fixture.packageRoot, 'managed-runtime/releases'), { recursive: true });
  assert.equal(context(fixture).env.PI_PASEO_RUNTIME_DIR, volumeRuntime(fixture), 'unready directory');
  // A package without the managed runtime (e.g. this checkout) behaves exactly as before.
  const plain = runtimeContext({ home: fixture.home, dataDir: fixture.dataDir, packageRoot: sourceRoot, env: { PATH: process.env.PATH } });
  assert.equal(plain.env.PI_PASEO_RUNTIME_DIR, volumeRuntime(fixture));
});

test('a receipt for another lock is not accepted as the managed runtime', t => {
  const fixture = tenant(t), bundled = path.join(fixture.packageRoot, 'managed-runtime');
  const loc = bake(bundled);
  fs.writeFileSync(path.join(runtimeDirectory(loc), '.pi-paseo-runtime.json'), JSON.stringify({ lockSha256: '0'.repeat(64), revision: 'stale' }));
  assert.equal(context(fixture).runtimeDir, volumeRuntime(fixture));
});
