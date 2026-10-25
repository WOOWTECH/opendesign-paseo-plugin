import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadPiOAuth } from '../src/pi-oauth.mjs';
import { runtimeContext, sourceRoot } from '../src/runtime-context.mjs';
import { providerRelease } from '../src/provider-install.mjs';
import { repairPiSdk, piRepaired } from '../src/sdk-repair.mjs';

function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-pi-native-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), dataDir = path.join(root, 'data'), bin = path.join(root, 'bin');
  for (const dir of [home, dataDir, bin]) fs.mkdirSync(dir);
  const context = runtimeContext({ home, dataDir, packageRoot: sourceRoot, env: { PATH: bin } });
  return { root, bin, context, audit: path.join(root, 'imports.txt') };
}

function sdk(f, codingRoot, { codingVersion = '1.1.0', aiVersion = '1.4.0' } = {}) {
  const aiRoot = path.join(codingRoot, 'node_modules/@earendil-works/pi-ai');
  json(path.join(codingRoot, 'package.json'), {
    name: '@earendil-works/pi-coding-agent', version: codingVersion, type: 'module',
    bin: { pi: 'dist/bundle/cli.js' },
  });
  fs.mkdirSync(path.join(codingRoot, 'dist/bundle'), { recursive: true });
  const entry = path.join(codingRoot, 'dist/bundle/cli.js');
  fs.writeFileSync(entry, '#!/usr/bin/env node\nthrow new Error("CLI must not execute");\n', { mode: 0o755 });
  const audit = kind => `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(f.audit)}, ${JSON.stringify(kind + '\n')});\n`;
  fs.mkdirSync(path.join(codingRoot, 'dist/core'), { recursive: true });
  const storageFile = path.join(codingRoot, 'dist/core/auth-storage.js');
  fs.writeFileSync(storageFile, audit('storage') + 'export class AuthStorage { static create() { throw new Error("must not open auth storage"); } }\n');
  json(path.join(aiRoot, 'package.json'), {
    name: '@earendil-works/pi-ai', version: aiVersion, type: 'module',
    exports: { './providers/*': { types: './dist/providers/*.d.ts', import: './dist/providers/*.js' } },
  });
  fs.mkdirSync(path.join(aiRoot, 'dist/providers'), { recursive: true });
  const providerFile = path.join(aiRoot, 'dist/providers/openai-codex.js');
  fs.writeFileSync(providerFile, audit('provider') + 'export const openaiCodexProvider = () => ({ id: "openai-codex", auth: { oauth: { login() { throw new Error("must not start OAuth"); } } } });\n');
  return { codingRoot, aiRoot, entry, storageFile, providerFile };
}

function native(t) {
  const f = fixture(t);
  Object.assign(f, sdk(f, path.join(f.root, 'global/node_modules/@earendil-works/pi-coding-agent')));
  fs.symlinkSync(f.entry, path.join(f.bin, 'pi'));
  return f;
}

function managed(f, options) {
  const release = providerRelease(f.context, 'pi');
  const installed = sdk(f, path.join(release, 'node_modules/@earendil-works/pi-coding-agent'), {
    codingVersion: '1.0.0', aiVersion: '1.0.0', ...options,
  });
  json(path.join(installed.codingRoot, 'node_modules/minimatch/package.json'), { name: 'minimatch', version: '10.2.6' });
  const brace = path.join(installed.codingRoot, 'node_modules/brace-expansion');
  fs.cpSync(path.join(sourceRoot, 'node_modules/brace-expansion'), brace, { recursive: true });
  repairPiSdk(release, sourceRoot);
  assert.equal(piRepaired(release, sourceRoot), true);
  return { ...installed, release, brace };
}

function notImported(f) {
  assert.equal(fs.existsSync(f.audit), false, 'rejected package must not evaluate SDK modules');
  assert.equal(fs.existsSync(path.join(f.context.env.PI_CODING_AGENT_DIR, 'auth.json')), false);
}

test('native real bundle entry and relative launcher symlink load import-only exports without opening credentials', async t => {
  const f = native(t);
  fs.unlinkSync(path.join(f.bin, 'pi'));
  fs.symlinkSync(path.relative(f.bin, f.entry), path.join(f.bin, 'pi'));
  assert.throws(() => createRequire(path.join(f.codingRoot, 'package.json')).resolve('@earendil-works/pi-ai/providers/openai-codex'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  const loaded = await loadPiOAuth(f.context);
  assert.equal(loaded.providerId, 'openai-codex');
  assert.equal(typeof loaded.AuthStorage.create, 'function');
  assert.equal(typeof loaded.oauth.login, 'function');
  assert.deepEqual(fs.readFileSync(f.audit, 'utf8').trim().split('\n').sort(), ['provider', 'storage']);
  assert.equal(fs.existsSync(f.context.toolsDir), false);
  assert.equal(fs.existsSync(path.join(f.context.env.PI_CODING_AGENT_DIR, 'auth.json')), false);
});

test('native SDK uses its nested dependency before a conflicting hoisted package', async t => {
  const f = native(t);
  json(path.join(path.dirname(f.codingRoot), 'pi-ai/package.json'), { name: '@earendil-works/pi-ai', version: '1.0.0' });
  assert.equal((await loadPiOAuth(f.context)).providerId, 'openai-codex');
});

test('native SDK can resolve an npm-hoisted dependency with the reviewed version and exports', async t => {
  const f = native(t), hoisted = path.join(path.dirname(f.codingRoot), 'pi-ai');
  fs.renameSync(f.aiRoot, hoisted);
  assert.equal((await loadPiOAuth(f.context)).providerId, 'openai-codex');
});

test('a wrong nearest dependency cannot be skipped in favor of a compatible hoisted package', async t => {
  const f = native(t), hoisted = path.join(path.dirname(f.codingRoot), 'pi-ai');
  fs.cpSync(f.aiRoot, hoisted, { recursive: true });
  const file = path.join(f.aiRoot, 'package.json'), pkg = JSON.parse(fs.readFileSync(file));
  json(file, { ...pkg, version: '1.1.0' });
  await assert.rejects(loadPiOAuth(f.context), { code: 'PROVIDER_VERSION_MISMATCH' });
  notImported(f);
});

test('native SDK rejects unreviewed package identity and export targets before module evaluation', async t => {
  const variants = [
    { name: 'foreign-sdk', code: 'PROVIDER_VERSION_MISMATCH' },
    { exports: { './providers/*': { require: './dist/providers/*.js' } }, code: 'PROVIDER_UNAVAILABLE' },
    { exports: { './providers/*': { import: '../foreign/*.js' } }, code: 'PROVIDER_UNAVAILABLE' },
    { exports: { './providers/*': { import: './elsewhere/*.js' } }, code: 'PROVIDER_UNAVAILABLE' },
  ];
  for (const { code, ...patch } of variants) {
    const f = native(t), file = path.join(f.aiRoot, 'package.json');
    json(file, { ...JSON.parse(fs.readFileSync(file)), ...patch });
    await assert.rejects(loadPiOAuth(f.context), { code });
    notImported(f);
  }
});

test('native manifest and module symlinks fail closed before either module is imported', async t => {
  for (const key of ['manifest', 'storageFile', 'providerFile']) {
    const f = native(t), file = key === 'manifest' ? path.join(f.aiRoot, 'package.json') : f[key];
    fs.renameSync(file, file + '.saved');
    fs.symlinkSync(file + '.saved', file);
    await assert.rejects(loadPiOAuth(f.context), { code: 'UNSAFE_SYMLINK' });
    notImported(f);
  }
});

test('native malformed manifests return a category without exposing parser contents or filesystem paths', async t => {
  for (const key of ['codingRoot', 'aiRoot']) {
    const f = native(t);
    fs.writeFileSync(path.join(f[key], 'package.json'), '{ malformed-fixture-private-content');
    await assert.rejects(loadPiOAuth(f.context), error => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.message, 'PROVIDER_UNAVAILABLE');
      assert.equal(String(error.stack).includes(f.root), false);
      assert.equal(String(error.stack).includes('malformed-fixture-private-content'), false);
      return true;
    });
    notImported(f);
  }
});

test('an executable outside the declared native bin is rejected without executing it', async t => {
  const f = native(t);
  fs.unlinkSync(path.join(f.bin, 'pi'));
  const other = path.join(f.codingRoot, 'dist/bundle/foreign.js');
  fs.writeFileSync(other, '#!/usr/bin/env node\nthrow new Error("must not execute");\n', { mode: 0o755 });
  fs.symlinkSync(other, path.join(f.bin, 'pi'));
  await assert.rejects(loadPiOAuth(f.context), { code: 'PROVIDER_UNAVAILABLE' });
  notImported(f);
});

test('managed repaired 1.0.0 / 1.0.0 resolves the same import-only wildcard without a native CLI', async t => {
  const f = fixture(t), installed = managed(f);
  assert.throws(() => createRequire(path.join(installed.codingRoot, 'package.json')).resolve('@earendil-works/pi-ai/providers/openai-codex'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  assert.equal((await loadPiOAuth(f.context)).providerId, 'openai-codex');
  assert.equal(fs.existsSync(path.join(f.context.env.PI_CODING_AGENT_DIR, 'auth.json')), false);
});

test('managed SDK retains the AI 1.0.0 pin even when native 1.1.0 / 1.4.0 is available', async t => {
  const f = native(t);
  managed(f, { aiVersion: '1.4.0' });
  await assert.rejects(loadPiOAuth(f.context), { code: 'PROVIDER_VERSION_MISMATCH' });
  notImported(f);
});

test('managed repair byte tampering blocks SDK import rather than falling back to native', async t => {
  const f = native(t), installed = managed(f);
  fs.writeFileSync(path.join(installed.brace, 'tampered-fixture.txt'), 'changed dependency bytes');
  assert.equal(piRepaired(installed.release, sourceRoot), false);
  await assert.rejects(loadPiOAuth(f.context), { code: 'PROVIDER_REPAIR_FAILED' });
  notImported(f);
});
