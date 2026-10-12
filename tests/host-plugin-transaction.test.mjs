import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { MANAGED_PLUGIN_ID, PluginTransactionError, withManagedPluginTransaction as transact, recoverManagedPluginTransaction as recover } from '../host/plugin-transaction.mjs';

const moduleUrl = new URL('../host/plugin-transaction.mjs', import.meta.url).href;
function fixture(t, { initial = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-plugin-transaction-'));
  const dataDir = path.join(root, 'data'), plugins = path.join(dataDir, 'plugins'), destination = path.join(plugins, MANAGED_PLUGIN_ID);
  fs.mkdirSync(plugins, { recursive: true });
  const f = { root, dataDir, plugins, destination, record: initial ? { id: MANAGED_PLUGIN_ID, version: 'old', fsPath: destination } : null };
  f.options = { dataDir, pluginId: MANAGED_PLUGIN_ID, getRecord: () => f.record };
  if (initial) { fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, 'SKILL.md'), 'old bytes'); }
  f.read = () => fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8');
  f.journal = () => {
    const dir = path.join(plugins, '.woowtech-paseo-transactions');
    const pointer = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'));
    const work = path.join(dir, pointer.id);
    return { ...JSON.parse(fs.readFileSync(path.join(work, 'receipt.json'), 'utf8')), work };
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return f;
}
async function stage(tx, bytes = 'new bytes') {
  return tx.stage(folder => fs.writeFileSync(path.join(folder, 'SKILL.md'), bytes), () => ({ ok: true }));
}
const failure = () => { throw new Error('fixture-private-token-must-not-escape'); };

test('copy failure leaves the original active folder and record untouched, including while copy awaits', async t => {
  const f = fixture(t), inode = fs.statSync(f.destination).ino;
  await assert.rejects(transact(f.options, async tx => {
    await tx.stage(async folder => {
      fs.writeFileSync(path.join(folder, 'partial'), 'partial source');
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(f.read(), 'old bytes'); assert.equal(fs.statSync(f.destination).ino, inode); failure();
    }, () => assert.fail('Validation must not run'));
  }), { code: 'PLUGIN_TRANSACTION_FAILED' });
  assert.equal(f.read(), 'old bytes'); assert.equal(f.record.version, 'old'); assert.equal(f.journal().phase, 'rolled-back');
});

test('failed stage validation does not remove the old plugin', async t => {
  const f = fixture(t);
  await assert.rejects(transact(f.options, tx => tx.stage(folder => fs.writeFileSync(path.join(folder, 'SKILL.md'), 'bad'), () => ({ ok: false }))), { code: 'PLUGIN_TRANSACTION_STAGE_INVALID' });
  assert.equal(f.read(), 'old bytes');
});

test('a valid stage publishes by rename and retains the exact previous inode and digest receipt', async t => {
  const f = fixture(t), inode = fs.statSync(f.destination).ino;
  const result = await transact(f.options, async tx => { await stage(tx); assert.equal(f.read(), 'old bytes'); await tx.publish(); assert.equal(f.read(), 'new bytes'); return { ok: true, value: 42 }; });
  assert.equal(result.value, 42); const journal = f.journal();
  assert.equal(journal.phase, 'committed'); assert.equal(fs.statSync(path.join(journal.work, 'previous')).ino, inode);
  assert.equal(fs.readFileSync(path.join(journal.work, 'previous/SKILL.md'), 'utf8'), 'old bytes');
  assert.match(journal.previousTree.digest, /^[a-f0-9]{64}$/); assert.match(journal.stagedTree.ownership, /^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(path.join(journal.work, 'receipt.json')).mode & 0o777, 0o600);
  assert.equal((await recover(f.options)).recovered, false); assert.equal(f.read(), 'new bytes');
});

test('destination validation failure restores the previous inode and redacts original exception data', async t => {
  const f = fixture(t), inode = fs.statSync(f.destination).ino;
  await assert.rejects(transact(f.options, async tx => { await stage(tx); await tx.publish(); failure(); }), error => {
    assert.equal(error.code, 'PLUGIN_TRANSACTION_FAILED'); assert(!error.message.includes('private-token')); assert.equal(error.cause, undefined); return true;
  });
  assert.equal(f.read(), 'old bytes'); assert.equal(fs.statSync(f.destination).ino, inode);
  assert.equal(fs.readFileSync(path.join(f.journal().work, 'rejected/SKILL.md'), 'utf8'), 'new bytes');
});

test('returning a failed native result rolls back instead of committing', async t => {
  const f = fixture(t);
  await assert.rejects(transact(f.options, async tx => { await stage(tx); await tx.publish(); return { ok: false }; }), { code: 'PLUGIN_TRANSACTION_FAILED' });
  assert.equal(f.read(), 'old bytes');
});

test('a callback that never publishes cannot silently report successful installation', async t => {
  const f = fixture(t);
  await assert.rejects(transact(f.options, async tx => { await stage(tx); return { ok: true }; }), { code: 'PLUGIN_TRANSACTION_NOT_PUBLISHED' });
  assert.equal(f.read(), 'old bytes');
});

test('first-install publication failure removes only the known staged replacement', async t => {
  const f = fixture(t, { initial: false });
  await assert.rejects(transact(f.options, async tx => { await stage(tx); await tx.publish(); failure(); }), { code: 'PLUGIN_TRANSACTION_FAILED' });
  assert.equal(fs.existsSync(f.destination), false); assert.equal(f.record, null);
  assert.equal(fs.readFileSync(path.join(f.journal().work, 'rejected/SKILL.md'), 'utf8'), 'new bytes');
});

test('first-install copy failure leaves the native folder absent', async t => {
  const f = fixture(t, { initial: false });
  await assert.rejects(transact(f.options, tx => tx.stage(failure, () => true)), { code: 'PLUGIN_TRANSACTION_FAILED' });
  assert.equal(fs.existsSync(f.destination), false);
});

test('every other plugin id is rejected before callbacks or transaction filesystem writes', async t => {
  const f = fixture(t); let called = false;
  for (const pluginId of ['other-plugin', '../woowtech-paseo', 'woowtech-paseo/../other', undefined]) {
    await assert.rejects(transact({ ...f.options, pluginId, getRecord: () => { called = true; } }, () => { called = true; }), { code: 'PLUGIN_TRANSACTION_UNMANAGED' });
  }
  assert.equal(called, false); assert.equal(fs.existsSync(path.join(f.plugins, '.woowtech-paseo-transactions')), false);
});

test('an unrelated native plugin remains byte-for-byte untouched through rollback', async t => {
  const f = fixture(t), other = path.join(f.plugins, 'unrelated'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'file'), 'tenant-owned');
  const before = fs.statSync(path.join(other, 'file'));
  await assert.rejects(transact(f.options, async tx => { await stage(tx); await tx.publish(); failure(); }));
  const after = fs.statSync(path.join(other, 'file'));
  assert.equal(fs.readFileSync(path.join(other, 'file'), 'utf8'), 'tenant-owned'); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
});

test('symlinked destination or parent and hardlinked files fail closed', async t => {
  for (const kind of ['destination', 'parent', 'hardlink']) {
    const f = fixture(t); const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'file'), 'external');
    if (kind === 'destination') { fs.rmSync(f.destination, { recursive: true }); fs.symlinkSync(outside, f.destination); }
    if (kind === 'parent') { fs.renameSync(f.plugins, path.join(f.root, 'saved')); fs.symlinkSync(path.join(f.root, 'saved'), f.plugins); }
    if (kind === 'hardlink') fs.linkSync(path.join(outside, 'file'), path.join(f.destination, 'linked'));
    await assert.rejects(transact(f.options, () => assert.fail('Unsafe source must not reach callback')), { code: 'PLUGIN_TRANSACTION_UNSAFE_PATH' });
    assert.equal(fs.readFileSync(path.join(outside, 'file'), 'utf8'), 'external');
  }
});

test('stage symlinks and inode replacements are refused without losing original bytes', async t => {
  for (const kind of ['symlink', 'replace']) {
    const f = fixture(t);
    await assert.rejects(transact(f.options, tx => tx.stage(folder => {
      if (kind === 'symlink') fs.symlinkSync(path.join(f.destination, 'SKILL.md'), path.join(folder, 'linked'));
      else { fs.renameSync(folder, folder + '.away'); fs.mkdirSync(folder); }
    }, () => true)));
    assert.equal(f.read(), 'old bytes');
  }
});

test('tree caps reject oversized stages and excessive entries before publication', async t => {
  for (const cap of [{ maxBytes: 9 }, { maxEntries: 1 }]) {
    const f = fixture(t);
    await assert.rejects(transact({ ...f.options, ...cap }, tx => stage(tx, 'too much content')));
    assert.equal(f.read(), 'old bytes');
  }
});

test('a concurrent edit to the original during staging is preserved and publication is refused', async t => {
  const f = fixture(t);
  await assert.rejects(transact(f.options, async tx => {
    await stage(tx); fs.writeFileSync(path.join(f.destination, 'SKILL.md'), 'external edit'); await tx.publish();
  }), { code: 'PLUGIN_TRANSACTION_RECOVERY_CONFLICT' });
  assert.equal(f.read(), 'external edit'); assert.equal(f.journal().phase, 'conflict');
});

test('external replacement edits after publication are not overwritten by rollback', async t => {
  const f = fixture(t);
  await assert.rejects(transact(f.options, async tx => {
    await stage(tx); await tx.publish(); fs.writeFileSync(path.join(f.destination, 'SKILL.md'), 'new external edit'); failure();
  }), { code: 'PLUGIN_TRANSACTION_RECOVERY_CONFLICT' });
  assert.equal(f.read(), 'new external edit');
  assert.equal(fs.readFileSync(path.join(f.journal().work, 'previous/SKILL.md'), 'utf8'), 'old bytes');
  await assert.rejects(recover(f.options), { code: 'PLUGIN_TRANSACTION_RECOVERY_CONFLICT' });
});

test('changed backup bytes are retained and cannot be restored as the verified previous version', async t => {
  const f = fixture(t);
  await assert.rejects(transact(f.options, async tx => {
    await stage(tx); await tx.publish(); fs.writeFileSync(path.join(f.journal().work, 'previous/SKILL.md'), 'changed backup'); failure();
  }), { code: 'PLUGIN_TRANSACTION_RECOVERY_CONFLICT' });
  assert.equal(f.read(), 'new bytes'); assert.equal(fs.readFileSync(path.join(f.journal().work, 'previous/SKILL.md'), 'utf8'), 'changed backup');
});

test('a foreign record id/path cannot authorize the managed folder', async t => {
  for (const patch of [{ id: 'other-plugin' }, { fsPath: '/tmp/another-plugin' }]) {
    const f = fixture(t); Object.assign(f.record, patch);
    await assert.rejects(transact(f.options, () => assert.fail()), { code: 'PLUGIN_TRANSACTION_RECORD_SCOPE' });
    assert.equal(f.read(), 'old bytes');
  }
});

test('a concurrent record edit during staging is preserved without replacing the folder', async t => {
  const f = fixture(t);
  await assert.rejects(transact(f.options, async tx => { await stage(tx); f.record = { ...f.record, version: 'external' }; await tx.publish(); }), { code: 'PLUGIN_TRANSACTION_RECOVERY_CONFLICT' });
  assert.equal(f.read(), 'old bytes'); assert.equal(f.record.version, 'external');
});

test('metadata writes require an explicit native compare-and-swap restore callback', async t => {
  const f = fixture(t); let writes = 0;
  await assert.rejects(transact(f.options, async tx => {
    await stage(tx); await tx.publish(); await tx.persistRecord({ ...f.record, version: 'new' }, () => { writes++; });
  }), { code: 'PLUGIN_TRANSACTION_RECORD_ROLLBACK_REQUIRED' });
  assert.equal(writes, 0); assert.equal(f.read(), 'old bytes');
});

test('caller-owned metadata rollback repairs a partial native persistence failure without schema assumptions', async t => {
  const f = fixture(t); let restores = 0;
  const options = { ...f.options, restoreRecord: ({ previousRecord, expectedRecord }) => {
    assert.deepEqual(f.record, expectedRecord); f.record = previousRecord; restores++; return true;
  } };
  await assert.rejects(transact(options, async tx => {
    await stage(tx); await tx.publish(); const expected = { ...f.record, version: 'new' };
    await tx.persistRecord(expected, () => { f.record = expected; failure(); });
  }), { code: 'PLUGIN_TRANSACTION_FAILED' });
  assert.equal(restores, 1); assert.equal(f.record.version, 'old'); assert.equal(f.read(), 'old bytes');
});

test('a third-party metadata edit after persistence is preserved; restore callback is not invoked', async t => {
  const f = fixture(t); let restores = 0;
  await assert.rejects(transact({ ...f.options, restoreRecord: () => { restores++; return true; } }, async tx => {
    await stage(tx); await tx.publish(); const expected = { ...f.record, version: 'new' };
    await tx.persistRecord(expected, () => { f.record = expected; }); f.record = { ...f.record, version: 'external' }; failure();
  }), { code: 'PLUGIN_TRANSACTION_RECOVERY_CONFLICT' });
  assert.equal(restores, 0); assert.equal(f.record.version, 'external'); assert.equal(f.read(), 'new bytes');
});

test('a rejected compare-and-swap preserves replacement and backup for reconciliation', async t => {
  const f = fixture(t);
  await assert.rejects(transact({ ...f.options, restoreRecord: () => false }, async tx => {
    await stage(tx); await tx.publish(); const expected = { ...f.record, version: 'new' }; await tx.persistRecord(expected, () => { f.record = expected; failure(); });
  }), { code: 'PLUGIN_TRANSACTION_RECOVERY_CONFLICT' });
  assert.equal(f.read(), 'new bytes'); assert.equal(f.record.version, 'new');
});

test('competing upgrades serialize; a timed-out contender never invokes its callback', async t => {
  const f = fixture(t); let enter, release, called = false;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const first = transact(f.options, async tx => { await stage(tx); enter(); await gate; await tx.publish(); });
  await entered;
  try { await assert.rejects(transact({ ...f.options, timeoutMs: 100 }, () => { called = true; }), { code: 'PLUGIN_TRANSACTION_BUSY' }); }
  finally { release(); }
  await first; assert.equal(called, false); assert.equal(f.read(), 'new bytes');
});

test('an aborted waiter performs no installation mutation', async t => {
  const f = fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(transact({ ...f.options, signal: controller.signal }, () => assert.fail()), { code: 'PLUGIN_TRANSACTION_ABORTED' });
  assert.equal(f.read(), 'old bytes');
});

test('cancellation after staging or publication rolls back before committing', async t => {
  for (const published of [false, true]) {
    const f = fixture(t), controller = new AbortController();
    await assert.rejects(transact({ ...f.options, signal: controller.signal }, async tx => {
      await stage(tx); if (published) await tx.publish(); controller.abort(); if (!published) await tx.publish();
    }), { code: 'PLUGIN_TRANSACTION_ABORTED' });
    assert.equal(f.read(), 'old bytes');
  }
});

async function killedOwner(t, f, mode) {
  const source = `import fs from 'node:fs';import path from 'node:path';import {withManagedPluginTransaction} from ${JSON.stringify(moduleUrl)};
const dataDir=${JSON.stringify(f.dataDir)}, destination=${JSON.stringify(f.destination)};
const record=${JSON.stringify(f.record)};
${['moving', 'rolling-back'].includes(mode) ? `const rename=fs.renameSync;fs.renameSync=(from,to)=>{rename(from,to);if(from===destination&&path.basename(to)===${JSON.stringify(mode === 'moving' ? 'previous' : 'rejected')})process.kill(process.pid,'SIGKILL');};` : ''}
await withManagedPluginTransaction({dataDir,pluginId:'woowtech-paseo',getRecord:()=>record},async tx=>{
 await tx.stage(folder=>fs.writeFileSync(path.join(folder,'SKILL.md'),'new bytes'),()=>true);
 ${mode === 'staged' ? '' : 'await tx.publish();'}
 ${mode === 'rolling-back' ? 'throw new Error("force rollback");' : ''}
 process.stdout.write('READY\\n');await new Promise(()=>setInterval(()=>{},1000));
});`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = '', errors = ''; child.stdout.on('data', data => { ready += data; }); child.stderr.on('data', data => { errors += data; });
  const exited = once(child, 'exit');
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  if (!['moving', 'rolling-back'].includes(mode)) {
    const deadline = Date.now() + 5000;
    while (!ready.includes('READY') && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert(ready.includes('READY'), errors || 'Child failed to reach transaction checkpoint'); child.kill('SIGKILL');
  }
  const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
}
for (const mode of ['staged', 'moving', 'published', 'rolling-back']) {
  test(`a killed owner at ${mode} recovers without losing the previous active plugin`, { timeout: 10000 }, async t => {
    const f = fixture(t); await killedOwner(t, f, mode);
    assert.equal((await recover(f.options)).recovered, true); assert.equal(f.read(), 'old bytes'); assert.equal(f.journal().phase, 'rolled-back');
    await transact(f.options, async tx => { await stage(tx, 'retry bytes'); await tx.publish(); }); assert.equal(f.read(), 'retry bytes');
  });
}

test('corrupt/linked journal data is rejected without touching active plugin bytes', async t => {
  const f = fixture(t); await transact(f.options, async tx => { await stage(tx); await tx.publish(); });
  const journal = f.journal(), receipt = path.join(journal.work, 'receipt.json'); fs.writeFileSync(receipt, '{');
  await assert.rejects(recover(f.options), { code: 'PLUGIN_TRANSACTION_INVALID_JOURNAL' }); assert.equal(f.read(), 'new bytes');
  fs.unlinkSync(receipt); fs.symlinkSync(path.join(f.destination, 'SKILL.md'), receipt);
  await assert.rejects(recover(f.options), { code: 'PLUGIN_TRANSACTION_UNSAFE_PATH' }); assert.equal(f.read(), 'new bytes');
});

test('central native staging replacement prevents the supplied installer destructive-copy regression', async t => {
  const sourcePath = '/tmp/woow-opendesign-research-20261012/deployed/plugins/installer.js';
  if (!fs.existsSync(sourcePath)) return t.skip('Deployment snapshot is advisor-only; portable tests above cover the module contract');
  const f = fixture(t), source = fs.readFileSync(sourcePath, 'utf8'), incoming = path.join(f.root, 'incoming'); fs.mkdirSync(incoming);
  fs.writeFileSync(path.join(incoming, 'SKILL.md'), 'new source'); fs.symlinkSync(path.join(f.destination, 'SKILL.md'), path.join(incoming, 'rejected-link'));
  const begin = source.indexOf('export async function* installFromLocalFolder('), end = source.indexOf('\n// A plugin id must', begin);
  let body = source.slice(begin, end).replace(/^export /, '');
  const left = body.indexOf("    yield { kind: 'progress', phase: 'copying'"), right = body.indexOf('    warnings.push(...parsed.warnings);', left);
  assert(left >= 0 && right > left);
  const replacement = `const parsed = await transact({dataDir: path.dirname(roots.userPluginsRoot),pluginId,getRecord:()=>getInstalledPlugin(db,pluginId)},async tx=>{
 await tx.stage(folder=>safeCopyTree(sourceFolder,folder,maxBytes),folder=>resolvePluginFolder(buildResolveOptions({folder,folderId:pluginId,sourceKind:recordedSourceKind,source:recordedSource},opts)));
 await tx.publish(); const parsed=await resolvePluginFolder(buildResolveOptions({folder:tx.destination,folderId:pluginId,sourceKind:recordedSourceKind,source:recordedSource},opts));
 if(!parsed.ok)throw new PluginTransactionError('PLUGIN_TRANSACTION_STAGE_INVALID');return parsed;
});\n`;
  body = body.slice(0, left) + replacement + body.slice(right);
  const copyStart = source.indexOf('async function safeCopyTree('), copyEnd = source.indexOf('\nfunction isSafeBasename(', copyStart);
  const scope = { fs, fsp: fs.promises, path, transact, PluginTransactionError, DEFAULT_MAX_BYTES: 1024 * 1024, SAFE_BASENAME: /^[a-z0-9_-]+$/,
    buildResolveOptions: base => base, resolvePluginFolder: async options => ({ ok: true, record: { id: MANAGED_PLUGIN_ID, fsPath: options.folder }, warnings: [] }),
    getInstalledPlugin: () => f.record, isSafeBasename: name => !['.', '..'].includes(name) && !/[\\/\0]/.test(name),
    upsertInstalledPlugin: () => assert.fail('Persistence must not run after copy failure'), recordPluginEvent: () => {} };
  scope.safeCopyTree = vm.runInNewContext(`(${source.slice(copyStart, copyEnd)})`, scope);
  const install = vm.runInNewContext(`(${body})`, scope);
  await assert.rejects(async () => { for await (const event of install({}, { source: incoming, roots: { userPluginsRoot: f.plugins } })) assert.notEqual(event.kind, 'success'); });
  assert.equal(f.read(), 'old bytes'); assert.equal(f.record.version, 'old');
});

test('a killed metadata writer recovers through the caller native CAS callback', { timeout: 10000 }, async t => {
  const f = fixture(t), recordFile = path.join(f.root, 'native-record.json');
  fs.writeFileSync(recordFile, JSON.stringify(f.record));
  f.options.getRecord = () => JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  let restored = 0;
  f.options.restoreRecord = ({ previousRecord, expectedRecord }) => {
    assert.deepEqual(f.options.getRecord(), expectedRecord);
    fs.writeFileSync(recordFile, JSON.stringify(previousRecord)); restored++; return true;
  };
  const source = `import fs from 'node:fs';import path from 'node:path';import {withManagedPluginTransaction} from ${JSON.stringify(moduleUrl)};
const recordFile=${JSON.stringify(recordFile)};
const getRecord=()=>JSON.parse(fs.readFileSync(recordFile,'utf8'));
await withManagedPluginTransaction({dataDir:${JSON.stringify(f.dataDir)},pluginId:'woowtech-paseo',getRecord,restoreRecord:()=>{throw new Error('Killed process must not recover itself');}},async tx=>{
 await tx.stage(folder=>fs.writeFileSync(path.join(folder,'SKILL.md'),'new bytes'),()=>true);await tx.publish();
 const expected={...getRecord(),version:'new'};
 await tx.persistRecord(expected,()=>{fs.writeFileSync(recordFile,JSON.stringify(expected));process.kill(process.pid,'SIGKILL');});
});`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', data => { errors += data; });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const [, signal] = await once(child, 'exit'); assert.equal(signal, 'SIGKILL', errors);
  assert.equal(f.options.getRecord().version, 'new'); assert.equal(f.read(), 'new bytes');
  assert.equal((await recover(f.options)).recovered, true);
  assert.equal(restored, 1); assert.equal(f.options.getRecord().version, 'old'); assert.equal(f.read(), 'old bytes');
});

test('caller-supplied transaction errors cannot expose arbitrary private codes', () => {
  const error = new PluginTransactionError('fixture-private-token');
  assert.equal(error.code, 'PLUGIN_TRANSACTION_FAILED'); assert.equal(error.message, 'PLUGIN_TRANSACTION_FAILED');
});
