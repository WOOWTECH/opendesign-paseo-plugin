import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceRoot } from '../src/runtime-context.mjs';
import { repairPiSdk, piRepaired } from '../src/sdk-repair.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-sdk-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdk = path.join(root, 'node_modules/@earendil-works/pi-coding-agent');
  fs.mkdirSync(path.join(sdk, 'node_modules/minimatch'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0' }));
  fs.writeFileSync(path.join(sdk, 'node_modules/minimatch/package.json'), JSON.stringify({ name: 'minimatch', version: '10.2.6' }));
  const brace = path.join(sdk, 'node_modules/brace-expansion');
  fs.cpSync(path.join(sourceRoot, 'node_modules/brace-expansion'), brace, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(brace, 'package.json'))); pkg.version = '5.0.9'; fs.writeFileSync(path.join(brace, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion': { version: '5.0.12' } } }));
  return { root, sdk, brace };
}

test('actual embedded dependency manifests/bytes override optimistic lock metadata; pinned official copy repairs the SDK', t => {
  const { root, brace } = fixture(t);
  assert.equal(piRepaired(root), false);
  const result = repairPiSdk(root);
  assert.equal(result.version, '5.0.12'); assert.equal(result.targets.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(brace, 'package.json'))).version, '5.0.12');
  assert.equal(piRepaired(root), true);
  const entry = path.join(brace, 'dist/esm/index.js'); fs.appendFileSync(entry, '\n// tampered fixture');
  assert.equal(piRepaired(root), false);
  repairPiSdk(root); assert.equal(piRepaired(root), true);
});

test('repair leaves older minimatch/brace families untouched and supplies private compatible balanced-match', t => {
  const { root, brace } = fixture(t);
  const older = path.join(root, 'node_modules/legacy/node_modules');
  fs.mkdirSync(path.join(older, 'minimatch'), { recursive: true }); fs.mkdirSync(path.join(older, 'brace-expansion'));
  fs.writeFileSync(path.join(root, 'node_modules/legacy/package.json'), JSON.stringify({ name: 'legacy', version: '1.0.0' }));
  fs.writeFileSync(path.join(older, 'minimatch/package.json'), JSON.stringify({ name: 'minimatch', version: '3.1.5' }));
  fs.writeFileSync(path.join(older, 'brace-expansion/package.json'), JSON.stringify({ name: 'brace-expansion', version: '1.1.12' }));
  fs.writeFileSync(path.join(older, 'brace-expansion/index.js'), 'module.exports = function () { return ["legacy"]; };');
  const before = fs.readFileSync(path.join(older, 'brace-expansion/index.js'));
  repairPiSdk(root);
  assert.deepEqual(fs.readFileSync(path.join(older, 'brace-expansion/index.js')), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(older, 'brace-expansion/package.json'))).version, '1.1.12');
  assert.match(JSON.parse(fs.readFileSync(path.join(brace, 'node_modules/balanced-match/package.json'))).version, /^4\./);
});

test('SDK repair rejects linked package roots and unsupported minimatch 10 dependency APIs', t => {
  const { root, brace } = fixture(t);
  const pkg = JSON.parse(fs.readFileSync(path.join(brace, 'package.json'))); pkg.version = '1.1.12'; fs.writeFileSync(path.join(brace, 'package.json'), JSON.stringify(pkg));
  assert.throws(() => repairPiSdk(root), { code: 'PROVIDER_REPAIR_FAILED' });
  const target = brace + '.outside'; fs.renameSync(brace, target); fs.symlinkSync(target, brace);
  assert.throws(() => repairPiSdk(root), { code: 'PROVIDER_REPAIR_FAILED' });
});
