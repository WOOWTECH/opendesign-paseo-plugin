import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { patchInstaller, patchLockfile, patchPluginRoutes, patchServer, buildOverlay, digest } from '../host/overlay.mjs';

// Private, read-only production code is deliberately excluded from the package.
// Point OD_NATIVE_BASELINE_DIR at a capture containing plugins/{installer,
// registry,lockfile,persistence}.js, plugin-runtime.mjs, contracts.mjs and
// node_modules/zod (the production version, 3.25.76).
const captured = process.env.OD_NATIVE_BASELINE_DIR ?? '/data/pi-agent/home/work/opendesign-paseo-deployment-review/private/host-baseline';
const installerFile = process.env.OD_NATIVE_INSTALLER_FILE ?? '/data/pi-agent/home/.private/opendesign-paseo/host-baseline/plugins/installer.js';
const trustFile = process.env.OD_NATIVE_TRUST_FILE ?? '/tmp/woow-opendesign-research-20261012/deployed/plugins/trust.js';
const routesFile = path.join(captured, 'routes/plugins/index.js');
const required = ['plugins/registry.js', 'plugins/lockfile.js', 'plugins/persistence.js', 'plugin-runtime.mjs', 'contracts.mjs', 'node_modules/zod/package.json'].map(file => path.join(captured, file));
const available = [installerFile, trustFile, ...required].every(file => fs.existsSync(file));
const nativeTest = (name, fn) => test(name, { skip: available ? false : 'Set OD_NATIVE_BASELINE_DIR and OD_NATIVE_INSTALLER_FILE to the authorized source capture', timeout: 15000 }, fn);
const compatibility = JSON.parse(fs.readFileSync(new URL('../host/compatibility.json', import.meta.url)));
const transactionUrl = new URL('../host/plugin-transaction.mjs', import.meta.url).href;
const id = 'woowtech-paseo';
const goldenManifest = fs.readFileSync(new URL('../plugin/open-design.json', import.meta.url));
const goldenSkill = fs.readFileSync(new URL('../plugin/SKILL.md', import.meta.url));
const goldenVersion = JSON.parse(goldenManifest).version;
const errorText = 'fixture-private-token-must-not-escape';
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const json = value => JSON.stringify(value, null, 2);
const plain = value => JSON.parse(JSON.stringify(value));

function plugin(folder, { name = id, version = goldenVersion, code = 'new code bytes' } = {}) {
  write(path.join(folder, 'open-design.json'), name === id && version === goldenVersion ? goldenManifest : json({ ...JSON.parse(goldenManifest), name, version }));
  write(path.join(folder, 'SKILL.md'), name === id ? goldenSkill : `---\nname: ${name}\ndescription: Fixture native skill\n---\n\nFixture bytes\n`);
  write(path.join(folder, 'code.txt'), code);
}
async function events(iterator) { const result = []; for await (const event of iterator) result.push(event); return result; }
function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.transaction = fn => () => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  return db;
}
async function fixture(t, { initial = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-native-installer-'));
  const nativeRoot = path.join(root, 'native'), packageRoot = path.join(root, 'package'), dataDir = path.join(root, 'data');
  const plugins = path.join(dataDir, 'plugins'), destination = path.join(plugins, id), incoming = path.join(root, 'incoming');
  fs.mkdirSync(plugins, { recursive: true });
  write(path.join(root, 'package.json'), '{"type":"module"}');
  write(path.join(nativeRoot, 'control.mjs'), 'export const control = { parses: [], events: [], stops: [], bindings: [], onParse: null, onUpsert: null };');
  write(path.join(packageRoot, 'host/plugin-transaction.mjs'), `export * from ${JSON.stringify(transactionUrl)};`);
  write(path.join(packageRoot, 'host/adapter.mjs'), `import {control} from '../../native/control.mjs'; export async function stopBeforeNativeUninstall(id) { control.stops.push(id); if(control.stopError) throw new Error('stop failed'); }`);
  write(path.join(packageRoot, 'plugin/open-design.json'), goldenManifest);
  write(path.join(packageRoot, 'plugin/SKILL.md'), goldenSkill);
  write(path.join(nativeRoot, 'plugins/installer.js'), patchInstaller(fs.readFileSync(installerFile, 'utf8'), packageRoot));
  write(path.join(nativeRoot, 'plugins/lockfile.js'), patchLockfile(fs.readFileSync(path.join(captured, 'plugins/lockfile.js'), 'utf8')));
  // Execute the complete native resolver and SQL helpers. Only add fault hooks;
  // retain their bodies, all native manifest/trust checks and SQL verbatim.
  let registry = fs.readFileSync(path.join(captured, 'plugins/registry.js'), 'utf8')
    .replace('export async function resolvePluginFolder(opts) {', 'async function nativeResolvePluginFolder(opts) {')
    .replace('export function upsertInstalledPlugin(db, record) {', 'function nativeUpsertInstalledPlugin(db, record) {');
  registry = "import {control} from '../control.mjs';\n" + registry + `
export async function resolvePluginFolder(opts) { const parsed = await nativeResolvePluginFolder(opts); control.parses.push(opts.folder); return control.onParse ? await control.onParse(opts, parsed) : parsed; }
export function upsertInstalledPlugin(db, record) { return control.onUpsert ? control.onUpsert(db, record, nativeUpsertInstalledPlugin) : nativeUpsertInstalledPlugin(db, record); }
`;
  write(path.join(nativeRoot, 'plugins/registry.js'), registry);
  write(path.join(nativeRoot, 'plugins/trust.js'), fs.readFileSync(trustFile));
  // These dependencies are outside local-folder install/resolve; a call fails.
  write(path.join(nativeRoot, 'plugins/strategy-provenance.js'), 'export function isInternalBundledStrategyV2() { throw new Error("Unused strategy path"); }');
  write(path.join(nativeRoot, 'plugins/plugin-asset-cache.js'), 'export function safeExternalFetch() { throw new Error("Network forbidden in fixture"); }');
  write(path.join(nativeRoot, 'plugins/events.js'), "import {control} from '../control.mjs'; export function recordPluginEvent(event) {control.events.push(event);}");
  write(path.join(nativeRoot, 'github-install-source.js'), 'export function resolveGithubRepositoryUrl() { return {kind:"other"}; }');
  write(path.join(nativeRoot, 'db.js'), "import {control} from './control.mjs'; export function deleteWorkspaceResourceByResourceId(db,type,id) {control.bindings.push([type,id]);} export function getWorkspaceResourceByResourceId() { throw new Error('Unused binding read'); }");
  for (const [name, source] of [['plugin-runtime', 'plugin-runtime.mjs'], ['contracts', 'contracts.mjs']]) {
    const folder = path.join(root, 'node_modules/@open-design', name);
    write(path.join(folder, 'package.json'), json({ type: 'module', exports: './index.mjs' }));
    write(path.join(folder, 'index.mjs'), fs.readFileSync(path.join(captured, source)));
  }
  write(path.join(root, 'node_modules/tar/package.json'), '{"type":"module","exports":"./index.mjs"}');
  write(path.join(root, 'node_modules/tar/index.mjs'), 'export function x() { throw new Error("Unused archive path"); }');
  fs.symlinkSync(path.join(captured, 'node_modules/zod'), path.join(root, 'node_modules/zod'), 'dir');
  const { control } = await import(pathToFileURL(path.join(nativeRoot, 'control.mjs')));
  const installer = await import(pathToFileURL(path.join(nativeRoot, 'plugins/installer.js')));
  const registryModule = await import(pathToFileURL(path.join(nativeRoot, 'plugins/registry.js')));
  const lockfile = await import(pathToFileURL(path.join(nativeRoot, 'plugins/lockfile.js')));
  const f = { root, nativeRoot, packageRoot, dataDir, plugins, destination, incoming, control, installer, registry: registryModule, lockfile, dbFile: path.join(root, 'fixture.sqlite'), lockfilePath: path.join(dataDir, 'od-plugin-lock.json') };
  f.db = openDatabase(f.dbFile);
  // Use production's exact CREATE TABLE, not a fabricated record schema.
  const migration = fs.readFileSync(path.join(captured, 'plugins/persistence.js'), 'utf8');
  const table = migration.match(/CREATE TABLE IF NOT EXISTS installed_plugins \([\s\S]*?\n    \);/);
  assert.ok(table); f.db.exec(table[0]);
  plugin(incoming);
  f.read = () => fs.readFileSync(path.join(destination, 'code.txt'), 'utf8');
  f.row = () => plain(f.registry.getInstalledPlugin(f.db, id));
  f.locks = () => JSON.parse(fs.readFileSync(f.lockfilePath, 'utf8'));
  f.journal = () => { const journalRoot = path.join(plugins, '.woowtech-paseo-transactions'); const pointer = JSON.parse(fs.readFileSync(path.join(journalRoot, 'current.json'), 'utf8')); const work = path.join(journalRoot, pointer.id); return { ...JSON.parse(fs.readFileSync(path.join(work, 'receipt.json'), 'utf8')), work }; };
  f.options = { source: incoming, roots: { userPluginsRoot: plugins }, lockfilePath: f.lockfilePath };
  f.run = (opts = {}) => events(installer.installPlugin(f.db, { ...f.options, ...opts }));
  if (initial) {
    plugin(destination, { code: 'old code bytes' });
    const parsed = await f.registry.resolvePluginFolder({ folder: destination, folderId: id, source: 'original-local', sourceKind: 'local' });
    assert.equal(parsed.ok, true, json(parsed));
    parsed.record.installedAt = 100; parsed.record.updatedAt = 101;
    f.registry.upsertInstalledPlugin(f.db, parsed.record);
    await f.lockfile.upsertPluginLockfileEntry(f.lockfilePath, parsed.record, 102);
  } else write(f.lockfilePath, json({ schemaVersion: 1, plugins: {} }));
  await f.lockfile.upsertPluginLockfileEntry(f.lockfilePath, { id: 'unrelated', version: '7.0.0', source: 'tenant-owned', sourceKind: 'local' }, 103);
  const other = path.join(plugins, 'unrelated'); write(path.join(other, 'file'), 'tenant-owned');
  f.desiredFile = path.join(dataDir, 'paseo-desired-fixture.json');
  write(f.desiredFile, json({ desiredEnabled: true, generation: 17 }));
  f.before = { row: f.row(), lock: plain(f.locks().plugins[id] ?? null), unrelated: plain(f.locks().plugins.unrelated), bytes: initial ? f.read() : null, inode: initial ? fs.statSync(destination).ino : null, otherStat: fs.statSync(path.join(other, 'file')), desired: fs.readFileSync(f.desiredFile), desiredStat: fs.statSync(f.desiredFile), lockBytes: fs.readFileSync(f.lockfilePath), lockStat: fs.statSync(f.lockfilePath) };
  control.parses.length = 0;
  t.after(() => { try { f.db.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}
function restored(f) {
  assert.deepEqual(f.row(), f.before.row);
  assert.deepEqual(f.locks().plugins[id] ?? null, f.before.lock);
  assert.deepEqual(f.locks().plugins.unrelated, f.before.unrelated);
  if (f.before.bytes === null) assert.equal(fs.existsSync(f.destination), false);
  else {
    assert.equal(f.read(), f.before.bytes); assert.equal(fs.statSync(f.destination).ino, f.before.inode);
    assert.deepEqual(fs.readFileSync(path.join(f.destination, 'open-design.json')), goldenManifest);
    assert.deepEqual(fs.readFileSync(path.join(f.destination, 'SKILL.md')), goldenSkill);
  }
  assert.deepEqual(fs.readFileSync(f.desiredFile), f.before.desired);
  assert.equal(fs.statSync(f.desiredFile).ino, f.before.desiredStat.ino); assert.equal(fs.statSync(f.desiredFile).mtimeMs, f.before.desiredStat.mtimeMs);
  const after = fs.statSync(path.join(f.plugins, 'unrelated/file'));
  assert.equal(after.ino, f.before.otherStat.ino); assert.equal(after.mtimeMs, f.before.otherStat.mtimeMs);
}
function failed(result, code) { const event = result.at(-1); assert.equal(event.kind, 'error', json(result)); if (code) assert.equal(event.code, code); assert.equal(result.some(event => event.kind === 'success'), false); assert.equal(json(result).includes(errorText), false); }
function intercept(t, method, fn) { const original = fs[method]; fs[method] = (...args) => fn(original, ...args); t.after(() => { fs[method] = original; }); }

nativeTest('pins the authoritative installer and lockfile, keeping native route authorization bytes intact', () => {
  assert.equal(digest(fs.readFileSync(installerFile)), compatibility.files['apps/daemon/dist/plugins/installer.js']);
  assert.equal(digest(fs.readFileSync(path.join(captured, 'plugins/lockfile.js'))), compatibility.files['apps/daemon/dist/plugins/lockfile.js']);
  const routes = fs.readFileSync(routesFile, 'utf8'); assert.equal(patchPluginRoutes(routes, '/release'), routes);
  assert.equal(JSON.parse(fs.readFileSync(path.join(captured, 'node_modules/zod/package.json'))).version, '3.25.76');
  assert.equal(compatibility.daemonPackageVersion, '0.23.1'); assert.equal(compatibility.openDesignImageVersion, '0.24.1');
});

nativeTest('actual native validator accepts engine declaration; golden same-version code update preserves installedAt', async t => {
  const f = await fixture(t), engineProbe = path.join(f.root, 'engine-probe'); plugin(engineProbe);
  const manifest = JSON.parse(goldenManifest); manifest.od.engineRequirements = { od: '=0.24.1' };
  write(path.join(engineProbe, 'open-design.json'), json(manifest));
  const parsed = await f.registry.resolvePluginFolder({ folder: engineProbe, folderId: id, sourceKind: 'local' });
  assert.equal(parsed.ok, true, json(parsed)); assert.equal(parsed.record.manifest.od.engineRequirements.od, '=0.24.1');
  f.control.parses.length = 0;
  const result = await f.run({ eventKind: 'upgraded' });
  assert.equal(result.at(-1).kind, 'success', json(result));
  assert.equal(f.row().version, goldenVersion); assert.equal(f.row().installedAt, 100); assert.equal(f.read(), 'new code bytes');
  assert.deepEqual(fs.readFileSync(path.join(f.destination, 'open-design.json')), goldenManifest); assert.deepEqual(fs.readFileSync(path.join(f.destination, 'SKILL.md')), goldenSkill);
  assert.equal(f.locks().plugins[id].version, goldenVersion); assert.equal(f.journal().phase, 'committed');
  assert.equal(f.control.parses.length, 3); assert.ok(f.control.parses[1].endsWith('/stage')); assert.equal(f.control.parses[2], f.destination);
  assert.equal(fs.statSync(path.join(f.journal().work, 'previous')).ino, f.before.inode);
  assert.equal(f.control.events.at(-1).kind, 'plugin.upgraded'); assert.deepEqual(f.locks().plugins.unrelated, f.before.unrelated);
});

nativeTest('first installation also uses real validation, copy, SQLite upsert and lockfile queue', async t => {
  const f = await fixture(t, { initial: false }), result = await f.run();
  assert.equal(result.at(-1).kind, 'success', json(result)); assert.equal(f.row().id, id); assert.equal(f.locks().plugins[id].version, goldenVersion);
  assert.equal(f.journal().previousTree, null); assert.equal(f.journal().phase, 'committed');
});

for (const change of ['unsupported manifest version', 'modified SKILL.md']) nativeTest(`actual patched installer rejects ${change} before publication, preserving the working plugin and desired state`, async t => {
  const f = await fixture(t); let published = false;
  if (change === 'unsupported manifest version') {
    const manifest = JSON.parse(goldenManifest); manifest.version = '0.2.0';
    write(path.join(f.incoming, 'open-design.json'), json(manifest));
  } else fs.appendFileSync(path.join(f.incoming, 'SKILL.md'), '\nUntrusted replacement instruction.\n');
  // This input passes the exact native schema; the host compatibility guard
  // must be the check that refuses publication.
  f.control.onParse = (opts, parsed) => { assert.equal(parsed.ok, true, json(parsed)); return parsed; };
  f.control.onUpsert = () => assert.fail('Unsupported bytes must never reach DB persistence');
  intercept(t, 'renameSync', (original, from, to) => { if (to === f.destination || from === f.destination) published = true; return original(from, to); });
  failed(await f.run({ eventKind: 'upgraded' }), 'INVALID_MANIFEST');
  restored(f); assert.equal(published, false); assert.equal(f.journal().phase, 'rolled-back');
  assert.equal(f.control.parses.length, 2); assert.ok(f.control.parses[1].endsWith('/stage'));
  assert.deepEqual(f.control.events, []); assert.deepEqual(f.control.stops, []);
  assert.deepEqual(fs.readFileSync(f.lockfilePath), f.before.lockBytes);
  assert.equal(fs.statSync(f.lockfilePath).ino, f.before.lockStat.ino); assert.equal(fs.statSync(f.lockfilePath).mtimeMs, f.before.lockStat.mtimeMs);
});

for (const [name, options] of [['replacement ownership', { allowReplacePlugin: () => 'owned by another workspace member' }], ['explicit overwrite refusal', { overwriteExisting: false }]]) {
  nativeTest(`native ${name} check returns before any managed writes`, async t => {
    const f = await fixture(t); failed(await f.run(options), 'CONFLICT'); restored(f);
    assert.equal(fs.existsSync(path.join(f.plugins, '.woowtech-paseo-transactions')), false); assert.deepEqual(f.control.stops, []);
  });
}

for (const initial of [true, false]) nativeTest(`actual safeCopyTree symlink failure preserves ${initial ? 'the active version' : 'an absent first install'}`, async t => {
  const f = await fixture(t, { initial }); fs.symlinkSync(path.join(f.plugins, 'unrelated/file'), path.join(f.incoming, 'forbidden-link'));
  failed(await f.run(), 'INTERNAL_ERROR'); restored(f); assert.equal(f.journal().phase, 'rolled-back'); assert.deepEqual(f.control.events, []);
});

nativeTest('actual copy budget failure leaves old bytes and records intact', async t => {
  const f = await fixture(t); write(path.join(f.incoming, 'large-file'), Buffer.alloc(16384));
  failed(await f.run({ maxBytes: 8192 }), 'INTERNAL_ERROR'); restored(f); assert.equal(f.journal().phase, 'rolled-back');
});

for (const phase of ['stage', 'destination']) nativeTest(`native ${phase} reparse failure restores the original folder inode and records`, async t => {
  const f = await fixture(t); f.control.onParse = (opts, parsed) => opts.folder === (phase === 'destination' ? f.destination : f.incoming) || (phase === 'stage' && opts.folder.endsWith('/stage'))
    ? (opts.folder === f.incoming ? parsed : { ok: false, errors: [errorText], warnings: [] }) : parsed;
  failed(await f.run(), 'INVALID_MANIFEST'); restored(f); assert.equal(f.journal().phase, 'rolled-back'); assert.deepEqual(f.control.events, []);
});

nativeTest('failed atomic publication restores the old active directory', async t => {
  const f = await fixture(t); let fault = true;
  intercept(t, 'renameSync', (original, from, to) => { if (fault && from.endsWith('/stage') && to === f.destination) { fault = false; throw new Error(errorText); } return original(from, to); });
  failed(await f.run(), 'INTERNAL_ERROR'); restored(f); assert.equal(f.journal().phase, 'rolled-back');
});

for (const phase of ['before', 'after']) nativeTest(`native DB upsert ${phase}-write fault rolls back folder and exact opaque native record`, async t => {
  const f = await fixture(t); let fault = true;
  f.control.onUpsert = (db, record, original) => { if (!fault) return original(db, record); fault = false; if (phase === 'after') original(db, record); throw new Error(errorText); };
  failed(await f.run(), 'INTERNAL_ERROR'); restored(f); assert.equal(f.journal().phase, 'rolled-back'); assert.deepEqual(f.control.events, []);
});

nativeTest('atomic lockfile publication failure rolls back a completed DB update without touching another entry', async t => {
  const f = await fixture(t); let fault = true;
  intercept(t, 'renameSync', (original, from, to) => { if (fault && to === f.lockfilePath && from.includes('.woow-paseo-')) { fault = false; throw new Error(errorText); } return original(from, to); });
  failed(await f.run(), 'INTERNAL_ERROR'); restored(f); assert.equal(f.journal().phase, 'rolled-back');
});

nativeTest('completed row and lock entry both roll back when final folder validation observes a failure', async t => {
  const f = await fixture(t); let fault = false, armed = false;
  intercept(t, 'lstatSync', (original, file, ...args) => { if (fault && file === f.destination) { fault = false; throw new Error(errorText); } return original(file, ...args); });
  intercept(t, 'renameSync', (original, from, to) => { const result = original(from, to); if (!armed && to === f.lockfilePath && from.includes('.woow-paseo-')) { fault = true; armed = true; } return result; });
  failed(await f.run(), 'INTERNAL_ERROR'); restored(f); assert.equal(f.journal().phase, 'rolled-back');
});

nativeTest('an unrelated native lockfile writer shares its existing queue and survives managed upgrade', async t => {
  const f = await fixture(t);
  f.control.onParse = async (opts, parsed) => { if (opts.folder === f.destination) await f.lockfile.upsertPluginLockfileEntry(f.lockfilePath, { id: 'concurrent-other', version: '8.0.0', source: 'other', sourceKind: 'local' }, 500); return parsed; };
  const result = await f.run(); assert.equal(result.at(-1).kind, 'success', json(result)); assert.equal(f.locks().plugins['concurrent-other'].version, '8.0.0'); assert.deepEqual(f.locks().plugins.unrelated, f.before.unrelated);
});

nativeTest('managed metadata reads wait for a partial unrelated write in the original native queue', async t => {
  const f = await fixture(t); let pending;
  f.control.onParse = async (opts, parsed) => {
    if (opts.folder === f.destination) {
      pending = f.lockfile.withManagedPluginLockfileQueue(f.lockfilePath, async () => {
        const original = fs.readFileSync(f.lockfilePath); fs.writeFileSync(f.lockfilePath, '{');
        await new Promise(resolve => setTimeout(resolve, 30)); fs.writeFileSync(f.lockfilePath, original);
      });
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(fs.readFileSync(f.lockfilePath, 'utf8'), '{');
    }
    return parsed;
  };
  const result = await f.run(); await pending;
  assert.equal(result.at(-1).kind, 'success', json(result)); assert.deepEqual(f.locks().plugins.unrelated, f.before.unrelated);
});

nativeTest('foreign edits to the published folder cause a retained conflict rather than being overwritten', async t => {
  const f = await fixture(t);
  f.control.onParse = (opts, parsed) => { if (opts.folder === f.destination) { write(path.join(f.destination, 'foreign'), 'concurrent edit'); throw new Error(errorText); } return parsed; };
  failed(await f.run(), 'CONFLICT'); assert.equal(f.journal().phase, 'conflict'); assert.equal(fs.readFileSync(path.join(f.destination, 'foreign'), 'utf8'), 'concurrent edit');
  assert.equal(fs.readFileSync(path.join(f.journal().work, 'previous/code.txt'), 'utf8'), f.before.bytes); assert.deepEqual(f.row(), f.before.row);
  await assert.rejects(f.installer.recoverManagedPaseoPlugin(f.db, f.options.roots, f.lockfilePath), { code: 'PLUGIN_TRANSACTION_RECOVERY_CONFLICT' });
});

nativeTest('foreign native record updates are preserved and block rollback', async t => {
  const f = await fixture(t); let fault = true;
  f.control.onUpsert = (db, record, original) => { if (!fault) return original(db, record); fault = false; original(db, { ...record, title: 'concurrent foreign edit' }); throw new Error(errorText); };
  failed(await f.run(), 'CONFLICT'); assert.equal(f.row().title, 'concurrent foreign edit'); assert.equal(f.journal().phase, 'conflict'); assert.equal(fs.statSync(path.join(f.journal().work, 'previous')).ino, f.before.inode);
});

nativeTest('native CLI omission of lockfilePath leaves its entry unchanged and uses the same recovery envelope', async t => {
  const f = await fixture(t), result = await f.run({ lockfilePath: undefined });
  assert.equal(result.at(-1).kind, 'success', json(result)); assert.deepEqual(f.locks().plugins[id], f.before.lock);
  assert.equal((await f.installer.recoverManagedPaseoPlugin(f.db, f.options.roots, f.lockfilePath)).recovered, false);
});

nativeTest('a changed source id after native probing cannot write another plugin row, including CLI without a lockfile argument', async t => {
  const f = await fixture(t);
  f.control.onParse = (opts, parsed) => { if (opts.folder === f.incoming) plugin(f.incoming, { name: 'unowned-id' }); return parsed; };
  failed(await f.run({ lockfilePath: undefined }), 'INVALID_MANIFEST'); restored(f);
  assert.equal(f.registry.getInstalledPlugin(f.db, 'unowned-id'), null); assert.equal(fs.existsSync(path.join(f.plugins, 'unowned-id')), false);
  assert.equal(f.journal().phase, 'rolled-back'); assert.equal(f.control.parses.length, 2);
});

nativeTest('a native installed record outside the owned folder is rejected without changing it', async t => {
  const f = await fixture(t), foreignFolder = path.join(f.root, 'foreign'); plugin(foreignFolder, { code: 'old code bytes' });
  const previous = f.registry.getInstalledPlugin(f.db, id); f.registry.upsertInstalledPlugin(f.db, { ...previous, fsPath: foreignFolder });
  const before = f.row(); failed(await f.run(), 'INTERNAL_ERROR'); assert.deepEqual(f.row(), before);
  assert.equal(f.read(), f.before.bytes); assert.equal(fs.statSync(f.destination).ino, f.before.inode);
  assert.equal(fs.readFileSync(path.join(foreignFolder, 'code.txt'), 'utf8'), f.before.bytes);
});

for (const phase of ['published', 'row-written']) nativeTest(`killed actual installer recovers a ${phase} upgrade before the managed folder is consumed`, async t => {
  const f = await fixture(t); f.db.close();
  const source = `import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
import {control} from ${JSON.stringify(pathToFileURL(path.join(f.nativeRoot, 'control.mjs')).href)};
import {installPlugin} from ${JSON.stringify(pathToFileURL(path.join(f.nativeRoot, 'plugins/installer.js')).href)};
const db=new DatabaseSync(${JSON.stringify(f.dbFile)});db.transaction=fn=>()=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
${phase === 'published' ? `control.onParse=(opts,parsed)=>{if(opts.folder===${JSON.stringify(f.destination)})process.kill(process.pid,'SIGKILL');return parsed;};` : `control.onUpsert=(db,record,original)=>{original(db,record);process.kill(process.pid,'SIGKILL');};`}
for await(const event of installPlugin(db,${JSON.stringify(f.options)})){};
`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'ignore', 'pipe'] }); let errors = '';
  child.stderr.on('data', bytes => { errors += bytes; }); t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const [code, signal] = await once(child, 'exit'); assert.equal(signal, 'SIGKILL', `${code}: ${errors}`);
  f.db = openDatabase(f.dbFile); assert.equal(f.read(), 'new code bytes');
  if (phase === 'row-written') assert.equal(f.row().source, f.incoming);
  assert.equal((await f.installer.recoverManagedPaseoPlugin(f.db, f.options.roots, f.lockfilePath)).recovered, true); restored(f); assert.equal(f.journal().phase, 'rolled-back');
});

nativeTest('managed native uninstall recovers under the shared guard, then stops before native deletion; others bypass it', async t => {
  const f = await fixture(t); const result = await f.installer.uninstallPlugin(f.db, id, f.options.roots);
  assert.equal(result.ok, true); assert.deepEqual(f.control.stops, [id]); assert.deepEqual(f.control.bindings, [['plugin', id]]); assert.equal(f.row(), null); assert.equal(fs.existsSync(f.destination), false);
  write(path.join(f.plugins, 'another/file'), 'another'); await f.installer.uninstallPlugin(f.db, 'another', f.options.roots); assert.deepEqual(f.control.stops, [id]);
});

nativeTest('stop failure prevents managed uninstall from deleting the active folder or native row', async t => {
  const f = await fixture(t); f.control.stopError = true;
  await assert.rejects(f.installer.uninstallPlugin(f.db, id, f.options.roots), { code: 'PLUGIN_TRANSACTION_FAILED' }); restored(f); assert.deepEqual(f.control.bindings, []);
});

nativeTest('unmanaged native install retains its original copy, records, lockfile and event behavior', async t => {
  const f = await fixture(t), another = path.join(f.root, 'another-source'); plugin(another, { name: 'another', version: '0.2.0' });
  const result = await f.run({ source: another }); assert.equal(result.at(-1).kind, 'success', json(result));
  assert.equal(f.registry.getInstalledPlugin(f.db, 'another').version, '0.2.0'); assert.equal(f.locks().plugins.another.version, '0.2.0'); restored(f);
  assert.equal(fs.existsSync(path.join(f.plugins, '.woowtech-paseo-transactions')), false);
});

nativeTest('full pinned overlay builds an installer patch and performs recovery before bridge registration', () => {
  const source = "    app.use(express.json({ limit: '4mb' }));\n    if (fs.existsSync(staticDir)) {\n                daemonUrl = url;\n        const cleanupDaemonBackgroundWork = () => {\n            daemonShutdownStarted = true;";
  const patched = patchServer(source, '/release'); assert.ok(patched.indexOf('await recoverManagedPaseoPlugin(') < patched.indexOf('woowPaseoBridge = registerPaseoBridge('));
  assert.ok(patched.includes('PLUGIN_TRANSACTION_RECOVERY_CONFLICT'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-native-build-'));
  try {
    const hostRoot = path.join(dir, 'host'), overlayRoot = path.join(dir, 'overlay');
    const files = { 'apps/daemon/dist/plugins/installer.js': compatibility.files['apps/daemon/dist/plugins/installer.js'], 'apps/daemon/dist/plugins/lockfile.js': compatibility.files['apps/daemon/dist/plugins/lockfile.js'] };
    write(path.join(hostRoot, 'apps/daemon/dist/plugins/installer.js'), fs.readFileSync(installerFile)); write(path.join(hostRoot, 'apps/daemon/dist/plugins/lockfile.js'), fs.readFileSync(path.join(captured, 'plugins/lockfile.js')));
    const receipt = buildOverlay({ hostRoot, packageRoot: '/release', overlayRoot, compatibility: { files } }); assert.equal(receipt.entries.length, 2);
    assert.ok(fs.readFileSync(receipt.entries[0].patchedFile, 'utf8').includes('installNativeManagedPlugin')); assert.ok(fs.readFileSync(receipt.entries[1].patchedFile, 'utf8').includes('export function withManagedPluginLockfileQueue'));
    assert.throws(() => patchInstaller(fs.readFileSync(receipt.entries[0].patchedFile, 'utf8'), '/release'), { code: 'HOST_NOT_COMPATIBLE' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
