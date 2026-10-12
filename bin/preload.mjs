// Stable, self-contained bootstrap. Never import code from a rejected release.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const FLOCK_HELPER_SHA256 = 'f178c22c93bf5c88fb9b531228c1d08bb7be73cac878c7aeaf07093f352a8142';
const approved = new WeakSet();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export class ReleaseError extends Error { constructor(code) { super(code); this.name = 'ReleaseError'; this.code = code; } }
export const RELEASE_FILES_SHIPPED = Object.freeze(['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'SKILL.md', 'open-design.json', 'src', 'bin', 'host', 'ui', 'plugin', 'vendor', 'node_modules']);
const fail = code => { throw new ReleaseError(code); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const relativeFile = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..');
function safe(file, missing = false) {
  let current = path.resolve(file), leaf;
  while (true) {
    try { const stat = fs.lstatSync(current); if (stat.isSymbolicLink()) fail('RELEASE_UNSAFE_PATH'); if (current === path.resolve(file)) leaf = stat; }
    catch (error) { if (error.code !== 'ENOENT' || !missing) throw error; }
    const parent = path.dirname(current); if (parent === current) return leaf; current = parent;
  }
}
function regular(file) {
  const stat = safe(file); if (!stat?.isFile() || stat.nlink !== 1) fail('RELEASE_INVALID_FILE'); return stat;
}
export function readReleaseBytes(file, maxBytes = 268435456) {
  const before = regular(file); if (before.size > maxBytes) fail('RELEASE_FILE_LIMIT');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd); if (opened.ino !== before.ino || opened.dev !== before.dev) fail('RELEASE_FILE_CHANGED');
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), current = regular(file);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || current.ino !== before.ino || current.dev !== before.dev || current.mtimeMs !== before.mtimeMs) fail('RELEASE_FILE_CHANGED');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function json(file, limit = 8388608) {
  try { return JSON.parse(readReleaseBytes(file, limit)); } catch (error) { if (error instanceof ReleaseError) throw error; fail('RELEASE_INVALID_JSON'); }
}
export function privateReleaseDirectory(directory) {
  safe(directory, true); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); safe(directory); fs.chmodSync(directory, 0o700);
}
export function writeReleaseJson(file, value) {
  privateReleaseDirectory(path.dirname(file)); safe(file, true);
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
function syncDirectory(directory) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
export function releaseInventory(root) {
  safe(root); const files = []; let bytes = 0;
  const visit = relative => {
    const file = path.join(root, relative); safe(path.dirname(file)); const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(file); const target = fs.realpathSync(file); const rel = path.relative(root, target);
      if (path.isAbsolute(link) || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) fail('RELEASE_INVALID_LINK');
      files.push({ path: relative, link });
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.posix.join(relative, name));
    } else {
      const content = readReleaseBytes(file); bytes += content.length;
      if (bytes > 268435456) fail('RELEASE_TREE_LIMIT');
      files.push({ path: relative, size: content.length, sha256: sha(content) });
    }
    if (files.length > 15000) fail('RELEASE_TREE_LIMIT');
  };
  for (const name of fs.readdirSync(root).sort()) if (name !== '.release.json') visit(name);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export function releaseSourceDigest(source) {
  const hash = createHash('sha256');
  for (const name of RELEASE_FILES_SHIPPED.filter(file => file !== 'node_modules')) {
    const file = path.join(source, name); if (!safe(file, true)) continue;
    const visit = file => {
      const stat = safe(file);
      if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
      else { hash.update(path.relative(source, file) + '\0'); hash.update(readReleaseBytes(file)); }
    };
    visit(file);
  }
  return hash.digest('hex');
}
/** Data-only exact profile matching is shared with the installer. The stable
 * bootstrap never imports executable helpers from an immutable release. */
export function selectCompatibilityProfile(compatibility, hashes) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const fileMap = value => object(value) && Object.keys(value).length > 0 && Object.keys(value).length <= 100 && Object.entries(value).every(([file, hash]) => relativeFile(file) && hex(hash));
  if (!object(compatibility) || !fileMap(compatibility.files) || !fileMap(hashes)) fail('HOST_NOT_COMPATIBLE');
  const keys = Object.keys(compatibility.files).sort();
  const exactKeys = files => JSON.stringify(Object.keys(files).sort()) === JSON.stringify(keys);
  if (!exactKeys(hashes) || compatibility.profiles !== undefined && (!Array.isArray(compatibility.profiles) || compatibility.profiles.length > 16)) fail('HOST_NOT_COMPATIBLE');
  const base = { ...compatibility, id: compatibility.profileId ?? 'base-opendesign-0.24.1' };
  delete base.profiles;
  const profiles = [base, ...(compatibility.profiles || [])], ids = new Set(), fingerprints = new Set();
  for (const profile of profiles) {
    if (!object(profile) || typeof profile.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,100}$/.test(profile.id) || ids.has(profile.id) || !fileMap(profile.files) || !exactKeys(profile.files)) fail('HOST_NOT_COMPATIBLE');
    if (['openDesignImageVersion', 'daemonPackageVersion', 'adapterProtocolVersion'].some(key => profile[key] !== undefined && profile[key] !== compatibility[key])) fail('HOST_NOT_COMPATIBLE');
    const fingerprint = JSON.stringify(keys.map(file => profile.files[file]));
    if (fingerprints.has(fingerprint)) fail('HOST_NOT_COMPATIBLE');
    ids.add(profile.id); fingerprints.add(fingerprint);
  }
  const matches = profiles.filter(profile => keys.every(file => hashes[file] === profile.files[file]));
  if (matches.length !== 1) fail('HOST_NOT_COMPATIBLE');
  return Object.freeze({ ...matches[0], files: Object.freeze({ ...matches[0].files }) });
}
function pointerRoot(base, pointer) {
  if (pointer?.protocolVersion !== 1 || !hex(pointer.manifestSha256) || typeof pointer.releaseRoot !== 'string') fail('RELEASE_INVALID_POINTER');
  const relative = path.relative(path.join(base, 'releases'), pointer.releaseRoot);
  if (!hex(relative) || path.resolve(pointer.releaseRoot) !== path.join(path.resolve(base), 'releases', relative)) fail('RELEASE_INVALID_ROOT');
  return relative;
}
function receiptShape(receipt, hostRoot, packageRoot, originalsRoot) {
  if (receipt?.protocolVersion !== 1 || receipt.hostRoot !== hostRoot || receipt.packageRoot !== packageRoot || !path.isAbsolute(hostRoot) || !Array.isArray(receipt.entries) || !receipt.entries.length || receipt.entries.length > 100) fail('RELEASE_INVALID_RECEIPT');
  const seen = new Set();
  for (const entry of receipt.entries) {
    if (!relativeFile(entry.relative) || seen.has(entry.relative) || !hex(entry.before) || !hex(entry.after) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) fail('RELEASE_INVALID_RECEIPT');
    seen.add(entry.relative);
    if (entry.originalFile !== path.join(originalsRoot, entry.relative + '.original') || entry.patchedFile !== path.join(packageRoot, 'overlay', entry.relative + '.patched')) fail('RELEASE_INVALID_RECEIPT');
    if (sha(readReleaseBytes(entry.originalFile)) !== entry.before) fail('RELEASE_INVALID_ORIGINAL');
  }
}
function freezeReceipt(receipt) { for (const entry of receipt.entries) Object.freeze(entry); Object.freeze(receipt.entries); Object.freeze(receipt); approved.add(receipt); return receipt; }
export function verifyRelease(base, pointer, { hostRoot = pointer?.hostRoot } = {}) {
  try {
  const id = pointerRoot(base, pointer), root = pointer.releaseRoot;
  const raw = readReleaseBytes(path.join(root, '.release.json'), 8388608); if (sha(raw) !== pointer.manifestSha256) fail('RELEASE_INVALID_MANIFEST');
  let manifest; try { manifest = JSON.parse(raw); } catch { fail('RELEASE_INVALID_MANIFEST'); }
  if (manifest.protocolVersion !== 1 || manifest.sourceDigest !== id || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.some(entry => !relativeFile(entry.path))) fail('RELEASE_INVALID_MANIFEST');
  const actual = releaseInventory(root);
  const expected = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('RELEASE_INVALID_FILE');
  if (releaseSourceDigest(root) !== id) fail('RELEASE_SOURCE_MISMATCH');
  const required = ['package.json', 'package-lock.json', 'bin/preload.mjs', 'src/flock-helper.py', 'host/overlay.mjs', 'host/compatibility.json', 'overlay/receipt.json', 'node_modules/@modelcontextprotocol/sdk/package.json', 'open-design.json', 'SKILL.md', 'plugin/open-design.json', 'plugin/SKILL.md'];
  if (required.some(file => !actual.some(entry => entry.path === file && hex(entry.sha256)))) fail('RELEASE_INCOMPLETE');
  const pkg = json(path.join(root, 'package.json')), sdk = json(path.join(root, 'node_modules/@modelcontextprotocol/sdk/package.json'));
  if (pkg.name !== '@woowtech/opendesign-paseo' || pkg.version !== manifest.version || sdk.version !== '1.31.0') fail('RELEASE_VERSION_MISMATCH');
  for (const file of ['open-design.json', 'SKILL.md']) if (sha(readReleaseBytes(path.join(root, file))) !== sha(readReleaseBytes(path.join(root, 'plugin', file)))) fail('RELEASE_PLUGIN_MISMATCH');
  if (sha(readReleaseBytes(path.join(root, 'src/flock-helper.py'))) !== FLOCK_HELPER_SHA256) fail('RELEASE_GUARD_MISMATCH');
  const receipt = json(path.join(root, 'overlay/receipt.json'));
  hostRoot ||= receipt.hostRoot;
  receiptShape(receipt, hostRoot, root, path.join(root, 'overlay'));
  const compatibility = json(path.join(root, 'host/compatibility.json'));
  let profile; try { profile = selectCompatibilityProfile(compatibility, Object.fromEntries(receipt.entries.map(entry => [entry.relative, entry.before]))); } catch { fail('RELEASE_INCOMPATIBLE_RECEIPT'); }
  if (receipt.compatibilityProfile !== undefined && receipt.compatibilityProfile !== profile.id || receipt.entries.some(entry => sha(readReleaseBytes(entry.patchedFile)) !== entry.after)) fail('RELEASE_INCOMPATIBLE_RECEIPT');
  return freezeReceipt(receipt);
  } catch (error) { if (error instanceof ReleaseError) throw error; fail('RELEASE_VERIFICATION_FAILED'); }
}
export function verifyRecovery(base, pointer, hostRoot) {
  const id = pointerRoot(base, pointer); if (!hex(pointer.recoverySha256)) fail('RELEASE_RECOVERY_MISSING');
  const root = path.join(base, 'recovery', id), file = path.join(root, 'receipt.json');
  const raw = readReleaseBytes(file, 1048576); if (sha(raw) !== pointer.recoverySha256) fail('RELEASE_INVALID_RECOVERY');
  let receipt; try { receipt = JSON.parse(raw); } catch { fail('RELEASE_INVALID_RECOVERY'); }
  receiptShape(receipt, hostRoot, pointer.releaseRoot, path.join(root, 'stock'));
  return freezeReceipt(receipt);
}
export function replaceVerifiedFile(file, bytes, allowed, { mode = 0o600 } = {}) {
  const before = regular(file), beforeHash = sha(readReleaseBytes(file));
  if (!allowed.includes(beforeHash)) fail('HOST_EXTERNAL_CHANGE');
  const temporary = file + '.woow-paseo-' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', mode); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const current = regular(file);
    if (before.ino !== current.ino || before.dev !== current.dev || before.mtimeMs !== current.mtimeMs || before.mode !== current.mode || sha(readReleaseBytes(file)) !== beforeHash) fail('HOST_EXTERNAL_CHANGE');
    fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
export function applyVerifiedOverlay(receipt, { rollback = false, previousReceipt, ownedReceipts = [] } = {}) {
  for (const previous of [previousReceipt, ...ownedReceipts].filter(Boolean)) if (!approved.has(previous) || previous.hostRoot !== receipt.hostRoot) fail('HOST_PREVIOUS_RECEIPT_UNVERIFIED');
  const previous = [previousReceipt, ...ownedReceipts].filter(Boolean);
  const targetEntries = receipt.entries;
  const operations = targetEntries.map(entry => ({ entry, bytes: readReleaseBytes(rollback ? entry.originalFile : entry.patchedFile), expected: rollback ? entry.before : entry.after }));
  if (!rollback && previousReceipt) for (const entry of previousReceipt.entries) if (!targetEntries.some(next => next.relative === entry.relative)) operations.push({ entry, bytes: readReleaseBytes(entry.originalFile), expected: entry.before });
  for (const operation of operations) {
    const { entry, bytes, expected } = operation;
    if (!relativeFile(entry.relative) || !hex(entry.before) || !hex(entry.after) || sha(bytes) !== expected) fail('HOST_RECEIPT_INVALID');
    const file = path.join(receipt.hostRoot, entry.relative), before = readReleaseBytes(file);
    const owned = previous.flatMap(row => row.entries.filter(old => old.relative === entry.relative).map(old => { if (old.before !== entry.before) fail('HOST_RECEIPT_INCOMPATIBLE'); return old.after; }));
    if (![entry.before, entry.after, ...owned].includes(sha(before))) fail('HOST_EXTERNAL_CHANGE');
    Object.assign(operation, { file, before, mode: regular(file).mode & 0o777 });
  }
  try {
    for (const operation of operations) if (sha(operation.before) !== operation.expected) replaceVerifiedFile(operation.file, operation.bytes, [sha(operation.before)], { mode: operation.entry.mode });
  } catch (error) {
    for (const operation of [...operations].reverse()) {
      const now = sha(readReleaseBytes(operation.file));
      if (now === operation.expected && now !== sha(operation.before)) replaceVerifiedFile(operation.file, operation.before, [operation.expected], { mode: operation.mode });
    }
    throw error;
  }
}
export function assertHostOwned(receipt, previousReceipt) {
  if (!approved.has(receipt) || previousReceipt && !approved.has(previousReceipt)) fail('HOST_PREVIOUS_RECEIPT_UNVERIFIED');
  for (const entry of receipt.entries) {
    const old = previousReceipt?.entries.find(row => row.relative === entry.relative);
    if (old && old.before !== entry.before) fail('HOST_RECEIPT_INCOMPATIBLE');
    if (![entry.before, entry.after, old?.after].filter(Boolean).includes(sha(readReleaseBytes(path.join(receipt.hostRoot, entry.relative))))) fail('HOST_EXTERNAL_CHANGE');
  }
}
export function ensureGuardHelper(base, sourceFile) {
  if (process.platform !== 'linux') fail('RELEASE_PLATFORM_UNSUPPORTED');
  const helper = path.join(base, 'bin/flock-helper.py'); privateReleaseDirectory(path.dirname(helper));
  if (safe(helper, true)) { if (sha(readReleaseBytes(helper)) !== FLOCK_HELPER_SHA256) fail('RELEASE_GUARD_CONFLICT'); fs.chmodSync(helper, 0o600); }
  else {
    if (!sourceFile || sha(readReleaseBytes(sourceFile)) !== FLOCK_HELPER_SHA256) fail('RELEASE_GUARD_UNAVAILABLE');
    const temporary = helper + '.' + randomUUID() + '.tmp'; fs.writeFileSync(temporary, readReleaseBytes(sourceFile), { mode: 0o600, flag: 'wx' });
    try { fs.linkSync(temporary, helper); } catch (error) { if (error.code !== 'EEXIST') throw error; } finally { fs.unlinkSync(temporary); }
    if (sha(readReleaseBytes(helper)) !== FLOCK_HELPER_SHA256) fail('RELEASE_GUARD_CONFLICT');
  }
  return helper;
}
export function withReleaseLock(base, work, { timeoutMs = 15000, helper } = {}) {
  if (process.platform !== 'linux') fail('RELEASE_PLATFORM_UNSUPPORTED');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) fail('RELEASE_INVALID_LOCK_TIMEOUT');
  if (!helper || sha(readReleaseBytes(helper)) !== FLOCK_HELPER_SHA256) fail('RELEASE_GUARD_UNAVAILABLE');
  privateReleaseDirectory(base); const guard = path.join(base, 'install.guard'); safe(guard, true);
  const fd = fs.openSync(guard, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd), current = regular(guard); if (current.ino !== stat.ino || current.dev !== stat.dev || stat.nlink !== 1) fail('RELEASE_UNSAFE_GUARD'); fs.fchmodSync(fd, 0o600);
    const until = Date.now() + timeoutMs;
    while (true) {
      const remaining = until - Date.now();
      if (remaining <= 0) fail('RELEASE_INSTALL_BUSY');
      const result = spawnSync('/usr/bin/python3', ['-I', '-S', helper, '--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: Math.min(1000, remaining), killSignal: 'SIGKILL' });
      if (result.status === 0 && !result.error && !result.signal) break;
      if (result.error?.code === 'ETIMEDOUT' && Date.now() >= until) fail('RELEASE_INSTALL_BUSY');
      if (result.status !== 73) fail(result.error?.code === 'ENOENT' ? 'RELEASE_GUARD_UNAVAILABLE' : 'RELEASE_GUARD_FAILED');
      if (Date.now() >= until) fail('RELEASE_INSTALL_BUSY');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25, until - Date.now()));
    }
    return work();
  } finally { fs.closeSync(fd); }
}
function optionalPointer(base, name) {
  const file = path.join(base, name + '.json'); if (!safe(file, true)) return null;
  const value = json(file, 1048576); if (name === 'activation') return value;
  pointerRoot(base, value); return value;
}
export function isOpenDesignEntry(argv = process.argv, cwd = process.cwd()) {
  if (typeof argv[1] !== 'string' || !['/app/apps/daemon/bin/od.mjs', '/app/apps/daemon/dist/cli.js'].includes(path.resolve(cwd, argv[1]))) return false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--no-open') continue;
    if (['--host', '--port'].includes(argv[i]) && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('-')) { i++; continue; }
    return false;
  }
  return true;
}
export async function preload({ base = path.join(process.env.HOME || '', '.local/share/opendesign-paseo'), hostRoot = '/app', argv = process.argv, cwd = process.cwd(), lockTimeoutMs = 15000 } = {}) {
  if (!isOpenDesignEntry(argv, cwd)) return { applied: false, reason: 'other-entry' };
  let guardSource;
  for (const name of ['current', 'active', 'previous']) {
    try {
      const pointer = optionalPointer(base, name);
      if (pointer) { const candidate = path.join(pointer.releaseRoot, 'src/flock-helper.py'); if (sha(readReleaseBytes(candidate)) === FLOCK_HELPER_SHA256) { guardSource = candidate; break; } }
    } catch {}
  }
  const helper = ensureGuardHelper(base, guardSource);
  return withReleaseLock(base, () => {
    let current, active, previous, activation;
    try { current = optionalPointer(base, 'current'); } catch {}
    try { active = optionalPointer(base, 'active'); } catch {}
    try { previous = optionalPointer(base, 'previous'); } catch {}
    try { activation = optionalPointer(base, 'activation'); } catch {}
    const pointers = [current, active, previous, activation?.to, activation?.from].filter(Boolean);
    const capsules = [];
    for (const pointer of pointers) try { capsules.push(verifyRecovery(base, pointer, hostRoot)); } catch {}
    if (!current && !pointers.length) return { applied: false, reason: 'not-installed' };
    try {
      if (!current) fail('RELEASE_INVALID_POINTER');
      const target = verifyRelease(base, current, { hostRoot });
      // Approval of previous code is independent of the current release.
      let old;
      const prior = active?.releaseRoot !== current.releaseRoot ? active : previous?.releaseRoot !== current.releaseRoot ? previous : null;
      if (prior) old = verifyRelease(base, prior, { hostRoot });
      verifyRecovery(base, current, hostRoot);
      writeReleaseJson(path.join(base, 'activation.json'), { protocolVersion: 1, from: prior, to: current });
      applyVerifiedOverlay(target, { previousReceipt: old, ownedReceipts: capsules });
      verifyRelease(base, current, { hostRoot });
      writeReleaseJson(path.join(base, 'active.json'), current); fs.unlinkSync(path.join(base, 'activation.json'));
      writeReleaseJson(path.join(base, 'boot-status.json'), { phase: 'ready', checkedAt: new Date().toISOString() });
      return { applied: true };
    } catch {
      if (!capsules.length) fail('RELEASE_NO_VERIFIED_RECOVERY');
      const stock = new Map();
      for (const receipt of capsules) for (const entry of receipt.entries) {
        const existing = stock.get(entry.relative); if (existing && existing.before !== entry.before) fail('RELEASE_RECOVERY_CONFLICT'); stock.set(entry.relative, entry);
      }
      const stockReceipt = { hostRoot, entries: [...stock.values()] };
      applyVerifiedOverlay(stockReceipt, { rollback: true, ownedReceipts: capsules });
      let restored;
      for (const pointer of [previous, active].filter(Boolean)) {
        if (pointer.releaseRoot === current?.releaseRoot) continue;
        try { const receipt = verifyRelease(base, pointer, { hostRoot }); verifyRecovery(base, pointer, hostRoot); applyVerifiedOverlay(receipt); restored = pointer; break; } catch {}
      }
      if (restored) { writeReleaseJson(path.join(base, 'current.json'), restored); writeReleaseJson(path.join(base, 'active.json'), restored); }
      else { for (const name of ['current', 'active']) { const file = path.join(base, name + '.json'); if (safe(file, true)) fs.unlinkSync(file); } }
      const journal = path.join(base, 'activation.json'); if (safe(journal, true)) fs.unlinkSync(journal);
      const result = { applied: false, recovered: true, fallback: restored ? 'previous' : 'stock', code: 'RELEASE_REJECTED' };
      writeReleaseJson(path.join(base, 'boot-status.json'), { ...result, checkedAt: new Date().toISOString() }); return result;
    }
  }, { timeoutMs: lockTimeoutMs, helper });
}
const stableFile = path.join(process.env.HOME || '', '.local/share/opendesign-paseo/bin/preload.mjs');
if (isOpenDesignEntry() && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(stableFile)) {
  try { const result = await preload(); if (result.recovered) console.warn('[woow-paseo] RELEASE_REJECTED; verified host fallback restored.'); }
  catch { console.error('[woow-paseo] RELEASE_RECOVERY_REQUIRED; unmanaged files preserved.'); process.exit(1); }
}
