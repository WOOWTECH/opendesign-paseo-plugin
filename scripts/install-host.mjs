import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertSafePath, RuntimeError } from '../vendor/pi-paseo/src/state.mjs';
import { buildOverlay } from '../host/overlay.mjs';
import { selectHostCompatibility } from '../host/compatibility-profile.mjs';
import { shipped, sourceDigest, readInstallPointer, bootstrapReadiness, createRecovery, digest } from '../host/release-state.mjs';
import { verifyRelease, verifyRecovery, assertHostOwned, readReleaseBytes, releaseInventory, privateReleaseDirectory, writeReleaseJson, ensureGuardHelper, withReleaseLock, replaceVerifiedFile } from '../bin/preload.mjs';

export function installHost({ source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), home = os.homedir(), hostRoot = '/app', lockTimeoutMs = 15000 } = {}) {
  for (const file of [source, home, hostRoot]) { if (!path.isAbsolute(file)) throw new RuntimeError('INVALID_INSTALL_PATH'); assertSafePath(file); }
  const base = path.join(home, '.local/share/opendesign-paseo');
  privateReleaseDirectory(base);
  const helper = ensureGuardHelper(base, path.join(source, 'src/flock-helper.py'));
  return withReleaseLock(base, () => installLocked({ source, hostRoot, base, helper }), { timeoutMs: lockTimeoutMs, helper });
}
function installLocked({ source, hostRoot, base, helper }) {
  const pkg = JSON.parse(readReleaseBytes(path.join(source, 'package.json')));
  const sdk = JSON.parse(readReleaseBytes(path.join(source, 'node_modules/@modelcontextprotocol/sdk/package.json')));
  if (pkg.name !== '@woowtech/opendesign-paseo' || sdk.version !== '1.31.0') throw new RuntimeError('INSTALL_SOURCE_INCOMPLETE');
  for (const file of ['SKILL.md', 'open-design.json']) if (digest(readReleaseBytes(path.join(source, file))) !== digest(readReleaseBytes(path.join(source, 'plugin', file)))) throw new RuntimeError('INSTALL_PLUGIN_ROOT_MISMATCH');
  privateReleaseDirectory(path.join(base, 'releases'));
  const hash = sourceDigest(source), releaseRoot = path.join(base, 'releases', hash);
  const previous = readInstallPointer(base), active = readInstallPointer(base, 'active');
  const prepared = readInstallPointer(base, 'prepared');
  let previousReceipt, activeReceipt;
  if (previous) { previousReceipt = verifyRelease(base, previous, { hostRoot }); verifyRecovery(base, previous, hostRoot); }
  if (active && active.releaseRoot !== previous?.releaseRoot) activeReceipt = verifyRelease(base, active, { hostRoot });
  if (prepared) { verifyRelease(base, prepared, { hostRoot }); verifyRecovery(base, prepared, hostRoot); }
  const bootstrapRoots = [previous?.releaseRoot, active?.releaseRoot, prepared?.releaseRoot].filter(Boolean);
  if (previousReceipt) assertHostOwned(previousReceipt, activeReceipt);
  if (previous?.releaseRoot === releaseRoot) {
    bootstrapReadiness(base, releaseRoot, bootstrapRoots);
    // Acquiring the process lock has also probed the pinned private Linux helper.
    ensureGuardHelper(base, path.join(releaseRoot, 'src/flock-helper.py'));
    return { version: pkg.version, reused: true, releaseRoot, compatibilityProfile: previousReceipt.compatibilityProfile, restartRequired: true, hostCompatible: true, helperReady: true, nodeOptionsImport: '--import ' + pathToFileURL(path.join(base, 'bin/preload.mjs')).href };
  }
  if (fs.existsSync(releaseRoot)) {
    const fallback = readInstallPointer(base, 'previous');
    const candidate = [prepared, fallback].find(pointer => pointer?.releaseRoot === releaseRoot);
    if (!candidate) throw new RuntimeError('INSTALL_RELEASE_CONFLICT');
    const receipt = verifyRelease(base, candidate, { hostRoot }); verifyRecovery(base, candidate, hostRoot); assertHostOwned(receipt, activeReceipt || previousReceipt);
    const bootstrap = bootstrapReadiness(base, releaseRoot, bootstrapRoots);
    if (previous) writeReleaseJson(path.join(base, 'previous.json'), previous);
    try { writeReleaseJson(path.join(base, 'current.json'), candidate); }
    catch (error) { if (bootstrap.before) replaceVerifiedFile(bootstrap.helper, bootstrap.before, [digest(bootstrap.bytes)], { mode: 0o600 }); throw error; }
    if (prepared?.releaseRoot === releaseRoot) fs.unlinkSync(path.join(base, 'prepared.json'));
    return { version: pkg.version, releaseRoot, compatibilityProfile: receipt.compatibilityProfile, reusedPrepared: true, restartRequired: true, hostCompatible: true, helperReady: true, nodeOptionsImport: '--import ' + pathToFileURL(bootstrap.helper).href };
  }
  const stage = path.join(base, 'releases', '.prepare-' + randomUUID()); privateReleaseDirectory(stage);
  let bootstrap, published = false;
  try {
    for (const name of shipped) { const from = path.join(source, name); if (fs.existsSync(from)) fs.cpSync(from, path.join(stage, name), { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false }); }
    if (sourceDigest(stage) !== hash) throw new RuntimeError('INSTALL_SOURCE_CHANGED');
    const bootstrapSyntax = spawnSync(process.execPath, ['--check', path.join(stage, 'bin/preload.mjs')], { stdio: 'ignore', timeout: 10000 });
    if (bootstrapSyntax.status !== 0) throw new RuntimeError('INSTALL_BOOTSTRAP_NOT_READY');
    bootstrapReadiness(base, stage, bootstrapRoots, { publish: false });
    const compatibility = selectHostCompatibility({ compatibility: JSON.parse(readReleaseBytes(path.join(stage, 'host/compatibility.json'))), hostRoot, previousReceipt });
    let overlayHost = hostRoot;
    if (previousReceipt) {
      overlayHost = path.join(stage, '.original-host'); privateReleaseDirectory(overlayHost);
      for (const [relative, expected] of Object.entries(compatibility.files)) {
        const old = previousReceipt.entries.find(entry => entry.relative === relative);
        const bytes = readReleaseBytes(old ? old.originalFile : path.join(hostRoot, relative));
        if (digest(bytes) !== expected) throw new RuntimeError('HOST_NOT_COMPATIBLE');
        const file = path.join(overlayHost, relative); privateReleaseDirectory(path.dirname(file)); fs.writeFileSync(file, bytes, { mode: old?.mode ?? fs.statSync(path.join(hostRoot, relative)).mode & 0o777 });
      }
    }
    const receipt = buildOverlay({ hostRoot: overlayHost, packageRoot: releaseRoot, overlayRoot: path.join(stage, 'overlay'), compatibility });
    receipt.hostRoot = hostRoot;
    receipt.compatibilityProfile = compatibility.profileId;
    for (const entry of receipt.entries) { entry.originalFile = path.join(releaseRoot, 'overlay', entry.relative + '.original'); entry.patchedFile = path.join(releaseRoot, 'overlay', entry.relative + '.patched'); }
    writeReleaseJson(path.join(stage, 'overlay/receipt.json'), receipt);
    if (overlayHost !== hostRoot) fs.rmSync(overlayHost, { recursive: true, force: true });
    for (const entry of receipt.entries.filter(entry => entry.relative.endsWith('.js'))) {
      const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: readReleaseBytes(path.join(stage, 'overlay', entry.relative + '.patched')), encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'ignore', 'ignore'] });
      if (checked.status !== 0) throw new RuntimeError('HOST_PATCH_SYNTAX_INVALID');
    }
    writeReleaseJson(path.join(stage, '.release.json'), { protocolVersion: 1, version: pkg.version, sourceDigest: hash, files: releaseInventory(stage) });
    if (fs.existsSync(releaseRoot)) throw new RuntimeError('INSTALL_RELEASE_CONFLICT');
    // Save independent stock bytes before publishing any executable pointer.
    const recoverySha256 = createRecovery(base, releaseRoot, stage, receipt);
    fs.renameSync(stage, releaseRoot);
    const pointer = { protocolVersion: 1, version: pkg.version, releaseRoot, hostRoot, manifestSha256: digest(readReleaseBytes(path.join(releaseRoot, '.release.json'))), recoverySha256, publishedAt: new Date().toISOString() };
    const verified = verifyRelease(base, pointer, { hostRoot }); verifyRecovery(base, pointer, hostRoot); assertHostOwned(verified, activeReceipt || previousReceipt);
    writeReleaseJson(path.join(base, 'prepared.json'), pointer);
    bootstrap = bootstrapReadiness(base, releaseRoot, bootstrapRoots);
    ensureGuardHelper(base, path.join(releaseRoot, 'src/flock-helper.py'));
    if (previous) writeReleaseJson(path.join(base, 'previous.json'), previous);
    writeReleaseJson(path.join(base, 'current.json'), pointer); published = true;
    fs.unlinkSync(path.join(base, 'prepared.json'));
    return { version: pkg.version, releaseRoot, compatibilityProfile: receipt.compatibilityProfile, restartRequired: true, nodeOptionsImport: '--import ' + pathToFileURL(bootstrap.helper).href, hostCompatible: true, helperReady: true };
  } catch (error) {
    if (!published && bootstrap?.before && digest(readReleaseBytes(bootstrap.helper)) === digest(bootstrap.bytes)) replaceVerifiedFile(bootstrap.helper, bootstrap.before, [digest(bootstrap.bytes)], { mode: 0o600 });
    throw error;
  } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {}, names = { '--source': 'source', '--home': 'home', '--host-root': 'hostRoot', '--lock-timeout-ms': 'lockTimeoutMs' };
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) { const name = names[args[i]]; if (!name || !args[i + 1] || args[i + 1].startsWith('--')) throw new RuntimeError('INVALID_INSTALL_ARGUMENT'); options[name] = name === 'lockTimeoutMs' ? Number(args[++i]) : args[++i]; }
    console.log(JSON.stringify(installHost(options)));
  } catch (error) { console.error(JSON.stringify({ error: 'HOST_INSTALL_FAILED', code: error instanceof RuntimeError || error?.name === 'ReleaseError' ? error.code : 'INSTALL_FAILED' })); process.exitCode = 1; }
}
