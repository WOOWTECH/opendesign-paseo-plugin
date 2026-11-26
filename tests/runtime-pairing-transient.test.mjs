import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as stateHelpers from '../vendor/pi-paseo/src/state.mjs';
import * as layout from '../vendor/pi-paseo/src/runtime-layout.mjs';
import * as targets from '../vendor/pi-paseo/src/connection-targets.mjs';
import { singleFlight, createReadWindow } from '../vendor/pi-paseo/src/single-flight.mjs';

test('pairing returns a validated offer without persisting it and removes a legacy offer', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-transient-pair-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const loc = { home: dir, stateDir: dir, runtimeDir: path.join(dir, 'runtime'), paseoHome: path.join(dir, 'daemon') };
  fs.mkdirSync(loc.paseoHome);
  const state = { installationId: 'owned-fixture', activeTarget: 'paseo', phase: 'running', desiredEnabled: true };
  fs.writeFileSync(path.join(loc.paseoHome, '.pi-paseo-owner.json'), JSON.stringify({ installationId: state.installationId, home: loc.paseoHome }));
  const release = layout.runtimeDirectory(loc), cli = path.join(release, 'node_modules/@getpaseo/cli');
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ version: layout.PASEO_VERSION }));
  layout.markRuntimeReady(loc);
  const offer = { v: 2, serverId: 'owned-fixture', daemonPublicKeyB64: 'fixture', minimumSecurityMode: 'protected', relay: { endpoint: 'relay.paseo.sh:443', useTls: true } };
  const url = 'https://app.paseo.sh/#offer=' + Buffer.from(JSON.stringify(offer)).toString('base64url');
  const privateFile = path.join(dir, 'pairing.private.json');
  fs.writeFileSync(privateFile, JSON.stringify({ url: 'legacy-private-offer' }));
  const client = { getDaemonStatus: async () => ({ providers: [], relay: { enabled: true } }), close: async () => {} };
  const source = new URL('../vendor/pi-paseo/src/runtime.mjs', import.meta.url);
  const code = ts.transpileModule(fs.readFileSync(source, 'utf8').replaceAll('import.meta.url', JSON.stringify(source.href)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const require = createRequire(import.meta.url), module = { exports: {} };
  const localRequire = spec => {
    if (spec === './state.mjs') return { ...stateHelpers, locations: () => loc, readState: () => state, updateState: patch => Object.assign(state, patch), processIdentity: () => 'owned' };
    if (spec === './runtime-layout.mjs') return layout;
    if (spec === './connection-targets.mjs') return targets;
    if (spec === './single-flight.mjs') return { singleFlight, daemonStatusWindow: createReadWindow() };
    if (spec === './process.mjs') return { runProcess: async () => JSON.stringify({ url, relayEnabled: true }) };
    if (spec.endsWith('/dist/utils/client.js')) return { connectToDaemon: async () => client };
    if (spec.endsWith('/daemon-instance.js')) return { readDaemonInstance: async () => ({ pid: 999, uid: 1000, startedAt: 'fixture' }) };
    if (spec.startsWith('./')) return {};
    return require(spec);
  };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {
    process: { platform: 'fixture', getuid: () => 1000, env: {} }, setTimeout, clearTimeout,
  })(localRequire, module, module.exports);
  const runtime = module.exports;
  assert.equal((await runtime.pair('paseo')).url, url);
  assert.equal(fs.existsSync(privateFile), false);
  assert.equal(JSON.stringify(state).includes('#offer='), false);
  assert.equal((await runtime.status()).pairingAvailable, true);
  await assert.rejects(runtime.pair('apporo'), { code: 'RESTART_REQUIRED' });
  assert.equal(fs.existsSync(privateFile), false);
});
