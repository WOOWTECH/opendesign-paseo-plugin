import test from 'node:test';
import assert from 'node:assert/strict';
import { publicStatus } from '../src/public-dto.mjs';
import { PASEO_VERSION, LEGACY_PASEO_VERSION } from '../vendor/pi-paseo/src/runtime-layout.mjs';
import { executeRuntimeJob } from '../src/runtime-worker.mjs';

test('status reports the verified candidate and supported legacy runtime versions', () => {
  for (const version of [PASEO_VERSION, LEGACY_PASEO_VERSION]) {
    assert.equal(publicStatus({ version }).version, version);
  }
  for (const version of ['latest', '99.0.0', '<script>', null, {}]) {
    assert.equal(publicStatus({ version }).version, null);
  }
});

test('status distinguishes desired and active targets while exposing only known public fields', () => {
  const status = publicStatus({
    version: PASEO_VERSION, connectionTarget: 'apporo', activeTarget: 'paseo',
    targetPending: true, phase: 'restart_required',
    pairing: 'PRIVATE_OFFER', state: { credential: 'PRIVATE_CREDENTIAL' },
  });
  assert.equal(status.connectionTarget, 'apporo');
  assert.equal(status.activeTarget, 'paseo');
  assert.equal(status.targetPending, true);
  assert.equal(status.restartRequired, true);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_/);
  assert.equal(Object.hasOwn(status, 'state'), false);
  assert.equal(Object.hasOwn(status, 'pairing'), false);
  const untrusted = publicStatus({ connectionTarget: 'https://attacker.invalid', activeTarget: {} });
  assert.equal(untrusted.connectionTarget, 'paseo');
  assert.equal(untrusted.activeTarget, null);
});

test('saving a target crosses the worker boundary as a public DTO without raw engine state', async () => {
  const result = await executeRuntimeJob({ env: {} }, { action: 'target', input: { target: 'apporo' } }, {
    setConnectionTarget: async target => ({ version: PASEO_VERSION, connectionTarget: target,
      activeTarget: 'paseo', targetPending: true, state: { internalPath: '/PRIVATE_RUNTIME_PATH' },
      pairing: 'PRIVATE_PAIRING_OFFER', daemon: { owned: true, running: true, reachable: true } }),
  });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.connectionTarget, 'apporo');
  assert.equal(result.targetPending, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  assert.equal(Object.hasOwn(result, 'state'), false);
});
