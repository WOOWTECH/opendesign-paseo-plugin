import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertSafePath, atomicJson } from '../vendor/pi-paseo/src/state.mjs';
import { withLock } from '../vendor/pi-paseo/src/onboarding.mjs';

export const MANAGED_PLUGIN_ID = 'woowtech-paseo';
const helper = fileURLToPath(new URL('../src/flock-helper.py', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const terminal = new Set(['committed', 'rolled-back']);
const phases = new Set(['preparing', 'staged', 'moving', 'moved', 'publishing', 'published', 'record-writing', 'rolling-back', 'committed', 'rolled-back', 'conflict']);

const errorCodes = new Set(['PLUGIN_TRANSACTION_ABORTED', 'PLUGIN_TRANSACTION_BUSY', 'PLUGIN_TRANSACTION_CONFLICT', 'PLUGIN_TRANSACTION_FAILED', 'PLUGIN_TRANSACTION_INVALID_JOURNAL', 'PLUGIN_TRANSACTION_INVALID_OPTIONS', 'PLUGIN_TRANSACTION_INVALID_PHASE', 'PLUGIN_TRANSACTION_INVALID_RECORD', 'PLUGIN_TRANSACTION_LOCK_FAILED', 'PLUGIN_TRANSACTION_NOT_PUBLISHED', 'PLUGIN_TRANSACTION_RECORD_ROLLBACK_REQUIRED', 'PLUGIN_TRANSACTION_RECORD_SCOPE', 'PLUGIN_TRANSACTION_RECOVERY_CONFLICT', 'PLUGIN_TRANSACTION_STAGE_INVALID', 'PLUGIN_TRANSACTION_TREE_LIMIT', 'PLUGIN_TRANSACTION_UNMANAGED', 'PLUGIN_TRANSACTION_UNSAFE_PATH']);

export class PluginTransactionError extends Error {
  constructor(code) { const safe = errorCodes.has(code) ? code : 'PLUGIN_TRANSACTION_FAILED'; super(safe); this.name = 'PluginTransactionError'; this.code = safe; }
}
const fail = code => { throw new PluginTransactionError(code); };
const safeError = error => new PluginTransactionError(error instanceof PluginTransactionError ? error.code : 'PLUGIN_TRANSACTION_FAILED');
function safe(file) {
  try {
    assertSafePath(file);
    try { return fs.lstatSync(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  } catch { fail('PLUGIN_TRANSACTION_UNSAFE_PATH'); }
}
function regular(file) {
  const stat = safe(file);
  if (stat && (!stat.isFile() || stat.nlink !== 1n)) fail('PLUGIN_TRANSACTION_UNSAFE_PATH');
  return stat;
}
function directory(file, create = false) {
  let stat = safe(file);
  if (!stat && create) { fs.mkdirSync(file, { recursive: true, mode: 0o700 }); stat = safe(file); }
  if (stat && !stat.isDirectory()) fail('PLUGIN_TRANSACTION_UNSAFE_PATH');
  return stat;
}
function canonical(value) {
  if (value === undefined) return null;
  let json;
  try { json = JSON.stringify(value); } catch { fail('PLUGIN_TRANSACTION_INVALID_RECORD'); }
  if (typeof json !== 'string' || Buffer.byteLength(json) > 1024 * 1024) fail('PLUGIN_TRANSACTION_INVALID_RECORD');
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  return sorted(JSON.parse(json));
}
function descriptor(stat, root = false) {
  return { dev: String(stat.dev), ino: String(stat.ino), mode: Number(stat.mode & 0o7777n), uid: Number(stat.uid), gid: Number(stat.gid), size: Number(stat.size),
    mtime: String(stat.mtimeNs), ...(root ? {} : { ctime: String(stat.ctimeNs) }) };
}
function cancelled(options) { if (options.signal?.aborted) fail('PLUGIN_TRANSACTION_ABORTED'); }
function identity(stat) { return stat ? { dev: String(stat.dev), ino: String(stat.ino) } : null; }
function sameIdentity(a, b) { return a?.dev === b?.dev && a?.ino === b?.ino; }
function syncDirectory(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readJson(file) {
  if (!regular(file)) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > 3n * 1024n * 1024n) fail('PLUGIN_TRANSACTION_INVALID_JOURNAL');
    const before = descriptor(stat);
    let value;
    try { value = JSON.parse(fs.readFileSync(fd, 'utf8')); } catch { fail('PLUGIN_TRANSACTION_INVALID_JOURNAL'); }
    if (!equal(before, descriptor(fs.fstatSync(fd, { bigint: true }))) || !sameIdentity(identity(stat), identity(regular(file)))) fail('PLUGIN_TRANSACTION_CONFLICT');
    return value;
  } finally { fs.closeSync(fd); }
}
function writeJson(file, value) {
  regular(file); directory(path.dirname(file));
  atomicJson(file, value); syncDirectory(path.dirname(file));
}
/** A content digest plus inode/timestamp digest makes rollback refuse external edits. */
function snapshot(root, maxBytes, maxEntries, flush = false) {
  const rootStat = directory(root);
  if (!rootStat) return null;
  const content = [], ownership = []; let bytes = 0, entries = 0;
  const visit = (file, relative) => {
    const before = safe(file);
    if (!before || ++entries > maxEntries) fail('PLUGIN_TRANSACTION_TREE_LIMIT');
    const stamp = descriptor(before, relative === '');
    ownership.push([relative, stamp]);
    if (before.isDirectory()) {
      content.push([relative, 'directory', stamp.mode]);
      for (const name of fs.readdirSync(file).sort()) {
        if (name.includes('\\') || name.includes('\0') || name === '.' || name === '..') fail('PLUGIN_TRANSACTION_UNSAFE_PATH');
        visit(path.join(file, name), relative ? `${relative}/${name}` : name);
      }
    } else if (before.isFile() && before.nlink === 1n) {
      bytes += Number(before.size);
      if (bytes > maxBytes) fail('PLUGIN_TRANSACTION_TREE_LIMIT');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        if (!equal(stamp, descriptor(fs.fstatSync(fd, { bigint: true })))) fail('PLUGIN_TRANSACTION_CONFLICT');
        content.push([relative, 'file', stamp.mode, hash(fs.readFileSync(fd))]);
        if (!equal(stamp, descriptor(fs.fstatSync(fd, { bigint: true })))) fail('PLUGIN_TRANSACTION_CONFLICT');
        if (flush) fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    } else { fail('PLUGIN_TRANSACTION_UNSAFE_PATH'); }
    if (flush && before.isDirectory()) syncDirectory(file);
    if (!equal(stamp, descriptor(safe(file), relative === ''))) fail('PLUGIN_TRANSACTION_CONFLICT');
  };
  visit(root, '');
  return { root: identity(rootStat), digest: hash(JSON.stringify(content)), ownership: hash(JSON.stringify(ownership)), bytes, entries };
}
function optionsFor(input) {
  if (input?.pluginId !== MANAGED_PLUGIN_ID) fail('PLUGIN_TRANSACTION_UNMANAGED');
  if (!path.isAbsolute(input.dataDir || '') || typeof input.getRecord !== 'function') fail('PLUGIN_TRANSACTION_INVALID_OPTIONS');
  const dataDir = path.resolve(input.dataDir), plugins = path.join(dataDir, 'plugins');
  const root = path.join(plugins, '.woowtech-paseo-transactions');
  const maxBytes = input.maxBytes ?? 50 * 1024 * 1024, maxEntries = input.maxEntries ?? 5000;
  if (![maxBytes, maxEntries].every(value => Number.isSafeInteger(value) && value > 0)) fail('PLUGIN_TRANSACTION_INVALID_OPTIONS');
  if (input.restoreRecord !== undefined && typeof input.restoreRecord !== 'function') fail('PLUGIN_TRANSACTION_INVALID_OPTIONS');
  safe(dataDir); directory(plugins, true); directory(root, true);
  return { ...input, dataDir, plugins, root, destination: path.join(plugins, MANAGED_PLUGIN_ID), maxBytes, maxEntries };
}
const tree = (options, file, flush = false) => snapshot(file, options.maxBytes, options.maxEntries, flush);
async function record(options) {
  const value = canonical(await options.getRecord());
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) fail('PLUGIN_TRANSACTION_INVALID_RECORD');
  if (value && (value.id !== MANAGED_PLUGIN_ID || (value.fsPath && path.resolve(value.fsPath) !== options.destination))) fail('PLUGIN_TRANSACTION_RECORD_SCOPE');
  return value;
}
function journalFor(options, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) fail('PLUGIN_TRANSACTION_INVALID_JOURNAL');
  const work = path.join(options.root, id);
  return { work, receipt: path.join(work, 'receipt.json'), stage: path.join(work, 'stage'), previous: path.join(work, 'previous'), rejected: path.join(work, 'rejected') };
}
function load(options) {
  const pointer = readJson(path.join(options.root, 'current.json'));
  if (!pointer) return null;
  if (pointer.version !== 1 || pointer.pluginId !== MANAGED_PLUGIN_ID) fail('PLUGIN_TRANSACTION_INVALID_JOURNAL');
  const files = journalFor(options, pointer.id); directory(files.work);
  const receipt = readJson(files.receipt);
  const work = identity(directory(files.work));
  // st_dev is a mount-local number: a new Pod can mount the same PVC inode
  // under a different device number. Terminal receipts never authorize any
  // rollback/write, so keep the persistent inode fence without blocking boot.
  // Unfinished receipts still require the full identity and ownership proof.
  const sameWork = receipt && (sameIdentity(receipt.work, work) ||
    terminal.has(receipt.phase) && typeof receipt.work?.dev === 'string' && /^[0-9]{1,20}$/.test(receipt.work.dev) && receipt.work?.ino === work?.ino && work !== null);
  if (!receipt || receipt.version !== 1 || receipt.id !== pointer.id || receipt.pluginId !== MANAGED_PLUGIN_ID ||
      !phases.has(receipt.phase) || !sameWork ||
      hash(JSON.stringify(canonical(receipt.previousRecord))) !== receipt.previousRecordDigest) fail('PLUGIN_TRANSACTION_INVALID_JOURNAL');
  if (receipt.expectedRecordDigest && hash(JSON.stringify(canonical(receipt.expectedRecord))) !== receipt.expectedRecordDigest) fail('PLUGIN_TRANSACTION_INVALID_JOURNAL');
  if (receipt.intermediateRecords && (!Array.isArray(receipt.intermediateRecords) || receipt.intermediateRecords.length > 4 ||
      !equal(receipt.intermediateRecords.map(value => hash(JSON.stringify(canonical(value)))), receipt.intermediateRecordDigests))) fail('PLUGIN_TRANSACTION_INVALID_JOURNAL');
  return { files, receipt };
}
function save(options, journal, patch) {
  const { files } = journal;
  if (!sameIdentity(journal.receipt.work, identity(directory(files.work)))) fail('PLUGIN_TRANSACTION_CONFLICT');
  journal.receipt = { ...journal.receipt, ...patch };
  writeJson(files.receipt, journal.receipt);
}
async function rollback(options, journal) {
  const { files, receipt } = journal;
  const prior = tree(options, files.previous), current = tree(options, options.destination);
  const expected = receipt.expectedRecordDigest || receipt.previousRecordDigest;
  const currentRecord = await record(options), currentDigest = hash(JSON.stringify(currentRecord));
  if (prior) {
    if (!equal(prior, receipt.previousTree)) fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT');
    // A missing target is ours only when the verified staged inode has not yet moved.
    const waitingStage = current ? null : tree(options, files.stage);
    const rejected = !current && receipt.phase === 'rolling-back' ? tree(options, files.rejected) : null;
    if (current ? !equal(current, receipt.stagedTree) : !equal(waitingStage, receipt.stagedTree) && !equal(rejected, receipt.stagedTree)) fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT');
  } else if (receipt.previousTree) {
    if (!equal(current, receipt.previousTree)) fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT');
  } else if (current && !equal(current, receipt.stagedTree)) {
    fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT');
  }
  if (currentDigest !== receipt.previousRecordDigest) {
    if (![expected, ...(receipt.intermediateRecordDigests || [])].includes(currentDigest) || !receipt.expectedRecordDigest || typeof options.restoreRecord !== 'function') fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT');
    const accepted = await options.restoreRecord({ previousRecord: canonical(receipt.previousRecord), expectedRecord: currentRecord,
      previousDigest: receipt.previousRecordDigest, expectedDigest: currentDigest });
    if (accepted !== true || hash(JSON.stringify(await record(options))) !== receipt.previousRecordDigest) fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT');
  }
  // Recheck after the asynchronous metadata callback; no concurrent edit is overwritten.
  if (!equal(current, tree(options, options.destination)) || !equal(prior, tree(options, files.previous))) fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT');
  save(options, journal, { phase: 'rolling-back' });
  if (prior) {
    if (current) { if (directory(files.rejected)) fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT'); fs.renameSync(options.destination, files.rejected); }
    if (safe(options.destination)) fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT');
    fs.renameSync(files.previous, options.destination);
  } else if (!receipt.previousTree && current) {
    if (directory(files.rejected)) fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT');
    fs.renameSync(options.destination, files.rejected);
  }
  syncDirectory(options.plugins); syncDirectory(files.work);
  save(options, journal, { phase: 'rolled-back' });
}
async function recover(options) {
  const journal = load(options);
  if (!journal || terminal.has(journal.receipt.phase)) return { recovered: false };
  if (journal.receipt.phase === 'conflict') fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT');
  try { await rollback(options, journal); return { recovered: true }; }
  catch { save(options, journal, { phase: 'conflict' }); fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT'); }
}
async function locked(input, fn) {
  let options;
  try { options = optionsFor(input); } catch (error) { throw safeError(error); }
  try { return await withLock(path.join(options.root, 'operation.lock'), () => fn(options), { helper, timeoutMs: input.timeoutMs ?? 15000, signal: input.signal }); }
  catch (error) {
    if (error instanceof PluginTransactionError) throw safeError(error);
    if (error.code === 'LOCK_BUSY') fail('PLUGIN_TRANSACTION_BUSY');
    if (error.code === 'LOCK_ABORTED') fail('PLUGIN_TRANSACTION_ABORTED');
    fail('PLUGIN_TRANSACTION_LOCK_FAILED');
  }
}
export async function recoverManagedPluginTransaction(options) { return locked(options, recover); }
/** Native managed uninstall participates in the same upgrade/recovery guard. */
export async function withManagedPluginMutationLock(input, fn) {
  if (typeof fn !== 'function') fail('PLUGIN_TRANSACTION_INVALID_OPTIONS');
  return locked(input, async options => {
    await recover(options); await record(options); tree(options, options.destination);
    try { return await fn(); } catch (error) { throw safeError(error); }
  });
}

/**
 * Scoped native-installer integration (only the owned id, after native authority checks):
 *   const parsed = await withManagedPluginTransaction({dataDir, pluginId,
 *     getRecord: () => getInstalledPlugin(db, pluginId)}, async tx => {
 *     await tx.stage(folder => safeCopyTree(sourceFolder, folder, maxBytes),
 *       folder => resolvePluginFolder(buildResolveOptions({...base, folder}, opts)));
 *     await tx.publish();
 *     const parsed = await resolvePluginFolder(buildResolveOptions({...base, folder: tx.destination}, opts));
 *     if (!parsed.ok) throw new PluginTransactionError('PLUGIN_TRANSACTION_STAGE_INVALID');
 *     return parsed;
 *   });
 * Keep upsertInstalledPlugin/lockfile writes AFTER this default callback: records must be
 * unchanged inside it. For metadata writes inside the transaction, explicitly supply a
 * restoreRecord compare-and-swap callback and use tx.persistRecord(expectedRecord, write).
 * That callback owns native DB/lockfile semantics; this helper contains no SQL/schema.
 *
 * Plan: stage+validate before original removal; inode/content receipts fence publication;
 * restore only matching owned trees/records; recover a killed owner through the shared
 * Alpine-safe kernel guard. Retain previous/rejected artifacts for review, without deleting
 * unknown edits. Native install/uninstall callers must participate in this same guard;
 * pure-JS check+rename cannot prevent an uncooperative final-syscall filesystem race.
 */
export async function withManagedPluginTransaction(input, fn) {
  if (typeof fn !== 'function') fail('PLUGIN_TRANSACTION_INVALID_OPTIONS');
  return locked(input, async options => {
    await recover(options);
    const previousRecord = await record(options), previousTree = tree(options, options.destination);
    const id = randomUUID(), files = journalFor(options, id); directory(files.work, true);
    const journal = { files, receipt: { version: 1, id, pluginId: MANAGED_PLUGIN_ID, phase: 'preparing', work: identity(directory(files.work)),
      previousTree, previousRecord, previousRecordDigest: hash(JSON.stringify(previousRecord)), stagedTree: null } };
    writeJson(files.receipt, journal.receipt);
    writeJson(path.join(options.root, 'current.json'), { version: 1, id, pluginId: MANAGED_PLUGIN_ID });
    const unchangedRecord = async () => {
      const expected = journal.receipt.expectedRecordDigest || journal.receipt.previousRecordDigest;
      if (hash(JSON.stringify(await record(options))) !== expected) fail('PLUGIN_TRANSACTION_CONFLICT');
    };
    const transaction = Object.freeze({
      destination: options.destination,
      previousRecord: canonical(previousRecord),
      async stage(copyForward, validate) {
        if (journal.receipt.phase !== 'preparing' || typeof copyForward !== 'function' || typeof validate !== 'function') fail('PLUGIN_TRANSACTION_INVALID_PHASE');
        cancelled(options);
        directory(files.stage, true); const stageIdentity = identity(directory(files.stage));
        await copyForward(files.stage); cancelled(options);
        const copied = tree(options, files.stage, true);
        if (!sameIdentity(stageIdentity, copied?.root)) fail('PLUGIN_TRANSACTION_CONFLICT');
        const result = await validate(files.stage); cancelled(options);
        if (result !== true && result?.ok !== true) fail('PLUGIN_TRANSACTION_STAGE_INVALID');
        if (!equal(copied, tree(options, files.stage))) fail('PLUGIN_TRANSACTION_CONFLICT');
        save(options, journal, { phase: 'staged', stagedTree: copied }); return result;
      },
      async publish() {
        if (journal.receipt.phase !== 'staged') fail('PLUGIN_TRANSACTION_INVALID_PHASE');
        cancelled(options); await unchangedRecord(); cancelled(options);
        if (!equal(previousTree, tree(options, options.destination)) || !equal(journal.receipt.stagedTree, tree(options, files.stage))) fail('PLUGIN_TRANSACTION_CONFLICT');
        save(options, journal, { phase: 'moving' });
        if (previousTree) fs.renameSync(options.destination, files.previous);
        syncDirectory(options.plugins); syncDirectory(files.work);
        save(options, journal, { phase: 'moved' });
        if (safe(options.destination)) fail('PLUGIN_TRANSACTION_CONFLICT');
        save(options, journal, { phase: 'publishing' });
        fs.renameSync(files.stage, options.destination);
        syncDirectory(options.plugins); syncDirectory(files.work);
        save(options, journal, { phase: 'published' }); return options.destination;
      },
      async persistRecord(expectedRecord, write, intermediateRecords = []) {
        if (journal.receipt.phase !== 'published' || typeof write !== 'function') fail('PLUGIN_TRANSACTION_INVALID_PHASE');
        if (typeof options.restoreRecord !== 'function') fail('PLUGIN_TRANSACTION_RECORD_ROLLBACK_REQUIRED');
        cancelled(options); await unchangedRecord(); cancelled(options);
        const expected = canonical(expectedRecord);
        if (!expected || expected.id !== MANAGED_PLUGIN_ID || (expected.fsPath && path.resolve(expected.fsPath) !== options.destination)) fail('PLUGIN_TRANSACTION_RECORD_SCOPE');
        if (!Array.isArray(intermediateRecords) || intermediateRecords.length > 4) fail('PLUGIN_TRANSACTION_INVALID_RECORD');
        const intermediate = intermediateRecords.map(canonical);
        if (intermediate.some(value => !value || value.id !== MANAGED_PLUGIN_ID || value.fsPath !== expected.fsPath)) fail('PLUGIN_TRANSACTION_RECORD_SCOPE');
        save(options, journal, { phase: 'record-writing', expectedRecord: expected, expectedRecordDigest: hash(JSON.stringify(expected)),
          intermediateRecords: intermediate, intermediateRecordDigests: intermediate.map(value => hash(JSON.stringify(value))) });
        const result = await write(); await unchangedRecord(); return result;
      },
    });
    try {
      const value = await fn(transaction); cancelled(options);
      if (value?.ok === false || value?.kind === 'error') fail('PLUGIN_TRANSACTION_FAILED');
      if (!['published', 'record-writing'].includes(journal.receipt.phase)) fail('PLUGIN_TRANSACTION_NOT_PUBLISHED');
      await unchangedRecord(); cancelled(options);
      if (!equal(journal.receipt.stagedTree, tree(options, options.destination))) fail('PLUGIN_TRANSACTION_CONFLICT');
      save(options, journal, { phase: 'committed' }); return value;
    } catch (error) {
      try { await rollback(options, journal); }
      catch { save(options, journal, { phase: 'conflict' }); fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT'); }
      throw safeError(error);
    }
  });
}

function lockDocument(file) {
  const value = readJson(file);
  if (value === null) return { schemaVersion: 1, plugins: {} };
  if (!value || value.schemaVersion !== 1 || !value.plugins || typeof value.plugins !== 'object' || Array.isArray(value.plugins)) fail('PLUGIN_TRANSACTION_INVALID_JOURNAL');
  return value;
}
function lockEntry(file) { return canonical(lockDocument(file).plugins[MANAGED_PLUGIN_ID] ?? null); }
/** Called only inside the native lockfile module's existing per-path queue. */
function replaceLockEntry(file, expectedEntry, nextEntry) {
  const before = regular(file), stamp = before ? descriptor(before) : null;
  const document = lockDocument(file), originalDigest = before ? hash(fs.readFileSync(file)) : null;
  if (!equal(canonical(document.plugins[MANAGED_PLUGIN_ID] ?? null), canonical(expectedEntry))) fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT');
  const plugins = { ...document.plugins };
  if (nextEntry === null) delete plugins[MANAGED_PLUGIN_ID];
  else { if (nextEntry.name !== MANAGED_PLUGIN_ID) fail('PLUGIN_TRANSACTION_RECORD_SCOPE'); plugins[MANAGED_PLUGIN_ID] = nextEntry; }
  const bytes = Buffer.from(JSON.stringify({ ...document, plugins: Object.fromEntries(Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b))) }, null, 2) + '\n');
  directory(path.dirname(file));
  const temporary = `${file}.woow-paseo-${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const current = regular(file);
    if (!equal(stamp, current ? descriptor(current) : null) || (current ? hash(fs.readFileSync(file)) : null) !== originalDigest) fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT');
    fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

/** Native APIs own their DB schema; this adapter stores only an opaque row and one lock entry. */
export function nativeManagedPluginTransactionOptions({ dataDir, roots, db, lockfilePath, native }) {
  if (!path.isAbsolute(dataDir || '') || path.resolve(roots?.userPluginsRoot || '') !== path.join(path.resolve(dataDir), 'plugins') ||
      !['getInstalledPlugin', 'upsertInstalledPlugin', 'deleteInstalledPlugin'].every(name => typeof native?.[name] === 'function') || typeof db?.transaction !== 'function') fail('PLUGIN_TRANSACTION_INVALID_OPTIONS');
  const destination = path.join(path.resolve(dataDir), 'plugins', MANAGED_PLUGIN_ID);
  const writeLockfile = Boolean(lockfilePath);
  lockfilePath = lockfilePath ? path.resolve(lockfilePath) : path.join(path.resolve(dataDir), 'od-plugin-lock.json');
  if (lockfilePath !== path.join(path.resolve(dataDir), 'od-plugin-lock.json') ||
      typeof native.withManagedPluginLockfileQueue !== 'function' || typeof native.lockEntryFromInstalled !== 'function') fail('PLUGIN_TRANSACTION_INVALID_OPTIONS');
  // Recovery/uninstall must observe the same entry as an install, even when the
  // current CLI caller omitted the optional native lockfile write argument.
  const queue = task => native.withManagedPluginLockfileQueue(lockfilePath, task);
  const readRecord = () => {
    const nativeRecord = native.getInstalledPlugin(db, MANAGED_PLUGIN_ID);
    if (nativeRecord && (nativeRecord.id !== MANAGED_PLUGIN_ID || nativeRecord.fsPath !== destination)) fail('PLUGIN_TRANSACTION_RECORD_SCOPE');
    return { id: MANAGED_PLUGIN_ID, fsPath: destination, nativeRecord, lockEntry: lockEntry(lockfilePath) };
  };
  // Existing unmanaged writers use a non-atomic writeFile. Join their queue for
  // reads as well, so an in-progress unrelated write cannot look like corruption.
  const getRecord = () => queue(() => readRecord());
  const restoreRecord = ({ previousRecord, expectedRecord }) => queue(async () => {
    if (!equal(canonical(readRecord()), canonical(expectedRecord))) return false;
    db.transaction(() => {
      if (!equal(canonical(native.getInstalledPlugin(db, MANAGED_PLUGIN_ID)), canonical(expectedRecord.nativeRecord))) fail('PLUGIN_TRANSACTION_RECOVERY_CONFLICT');
      if (previousRecord.nativeRecord) native.upsertInstalledPlugin(db, previousRecord.nativeRecord);
      else native.deleteInstalledPlugin(db, MANAGED_PLUGIN_ID);
    })();
    if (lockfilePath && !equal(expectedRecord.lockEntry, previousRecord.lockEntry)) replaceLockEntry(lockfilePath, expectedRecord.lockEntry, previousRecord.lockEntry);
    return true;
  });
  return { dataDir, pluginId: MANAGED_PLUGIN_ID, getRecord, readRecord, restoreRecord, native, db, lockfilePath, writeLockfile, queue };
}

/** Full managed native copy/reparse/row/lockfile operation, before installer success is emitted. */
export async function installNativeManagedPlugin(options, { copy, parse, maxBytes }) {
  const checkedParse = async folder => {
    const parsed = await parse(folder);
    // The source may change after native probing; never let that switch the
    // persisted id or fsPath to an unowned row after choosing the managed branch.
    if (parsed?.ok === true && (parsed.record?.id !== MANAGED_PLUGIN_ID || parsed.record.fsPath !== folder)) fail('PLUGIN_TRANSACTION_STAGE_INVALID');
    return parsed;
  };
  return withManagedPluginTransaction({ ...options, ...(maxBytes === undefined ? {} : { maxBytes }) }, async tx => {
    await tx.stage(copy, checkedParse); await tx.publish();
    const parsed = await checkedParse(tx.destination);
    if (parsed?.ok !== true) fail('PLUGIN_TRANSACTION_STAGE_INVALID');
    const previous = tx.previousRecord;
    const nativeRecord = canonical({ ...parsed.record, installedAt: previous.nativeRecord?.installedAt ?? parsed.record.installedAt });
    const nextEntry = options.writeLockfile ? canonical(options.native.lockEntryFromInstalled(parsed.record, Date.now())) : previous.lockEntry;
    if (nextEntry && nextEntry.name !== MANAGED_PLUGIN_ID) fail('PLUGIN_TRANSACTION_RECORD_SCOPE');
    const expected = { id: MANAGED_PLUGIN_ID, fsPath: tx.destination, nativeRecord, lockEntry: nextEntry };
    const intermediate = [{ ...expected, lockEntry: previous.lockEntry }, { ...previous, lockEntry: nextEntry }];
    await tx.persistRecord(expected, () => options.queue(async () => {
      if (!equal(canonical(options.readRecord()), canonical(previous))) fail('PLUGIN_TRANSACTION_CONFLICT');
      options.native.upsertInstalledPlugin(options.db, parsed.record);
      if (options.writeLockfile) replaceLockEntry(options.lockfilePath, previous.lockEntry, nextEntry);
    }), intermediate);
    return parsed;
  });
}
