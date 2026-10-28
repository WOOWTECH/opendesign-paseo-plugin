import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeContext } from '../src/runtime-context.mjs';

// Provider CLIs refuse to start when their home variable names a directory that does not exist (Codex: "CODEX_HOME points
// to ..., but that path does not exist"). A fresh PaaS home volume has none of the three directories; the HA add-on only
// works because its start script creates them. The context creates them, so every entry point is covered.
function tenant(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-homes-')), home = path.join(root, 'home'), dataDir = path.join(root, 'data');
  const packageRoot = path.join(root, 'opt/opendesign-paseo');
  fs.mkdirSync(home); fs.mkdirSync(dataDir); fs.mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'src/runtime-worker.mjs'), '');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, dataDir, packageRoot };
}
const context = (fixture, env = {}) => runtimeContext({ home: fixture.home, dataDir: fixture.dataDir, packageRoot: fixture.packageRoot, env: { PATH: process.env.PATH, ...env } });

test('a fresh home gets the three provider directories, private to the tenant user', t => {
  const fixture = tenant(t), value = context(fixture);
  assert.equal(value.env.CODEX_HOME, path.join(fixture.home, '.codex'));
  assert.equal(value.env.CLAUDE_CONFIG_DIR, path.join(fixture.home, '.claude'));
  assert.equal(value.env.PI_CODING_AGENT_DIR, path.join(fixture.home, '.pi/agent'));
  for (const dir of [value.env.CODEX_HOME, value.env.CLAUDE_CONFIG_DIR, value.env.PI_CODING_AGENT_DIR]) {
    assert.equal(fs.statSync(dir).isDirectory(), true, dir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  }
});

test('existing provider directories keep their permissions and contents', t => {
  const fixture = tenant(t), codex = path.join(fixture.home, '.codex');
  fs.mkdirSync(codex, { mode: 0o750 }); fs.chmodSync(codex, 0o750);
  fs.writeFileSync(path.join(codex, 'auth.json'), '{"tokens":"kept"}');
  context(fixture); context(fixture);
  assert.equal(fs.statSync(codex).mode & 0o777, 0o750);
  assert.equal(fs.readFileSync(path.join(codex, 'auth.json'), 'utf8'), '{"tokens":"kept"}');
});

test('a provider home named by the environment is created where it points, inside the tenant home', t => {
  const fixture = tenant(t), custom = path.join(fixture.home, 'state/codex');
  const value = context(fixture, { CODEX_HOME: custom });
  assert.equal(value.env.CODEX_HOME, custom);
  assert.equal(fs.statSync(custom).isDirectory(), true);
});

test('a provider home outside the tenant home is rejected and nothing is created', t => {
  const fixture = tenant(t);
  assert.throws(() => context(fixture, { CODEX_HOME: path.join(fixture.root, 'elsewhere') }), error => error.code === 'INVALID_PROVIDER_HOME');
  assert.equal(fs.existsSync(path.join(fixture.root, 'elsewhere')), false);
  assert.equal(fs.existsSync(path.join(fixture.home, '.pi')), false);
  assert.equal(fs.existsSync(path.join(fixture.home, '.claude')), false);
});
