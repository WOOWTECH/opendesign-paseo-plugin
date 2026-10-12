// Installer state only; the stable bootstrap does not import release modules.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readReleaseBytes, privateReleaseDirectory, writeReleaseJson, replaceVerifiedFile, ReleaseError, RELEASE_FILES_SHIPPED, releaseSourceDigest } from '../bin/preload.mjs';
export const shipped = RELEASE_FILES_SHIPPED;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const sourceDigest = releaseSourceDigest;
export function readInstallPointer(base, name = 'current') {
  const file = path.join(base, name + '.json');
  try { return JSON.parse(readReleaseBytes(file, 1048576)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new ReleaseError('RELEASE_INSTALL_POINTER_INVALID'); }
}
export function bootstrapReadiness(base, releaseRoot, previousRoot, { publish = true } = {}) {
  const helper = path.join(base, 'bin/preload.mjs'), bytes = readReleaseBytes(path.join(releaseRoot, 'bin/preload.mjs'));
  let before;
  try { before = readReleaseBytes(helper); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const allowed = [digest(bytes)];
  for (const root of [previousRoot].flat().filter(Boolean)) allowed.push(digest(readReleaseBytes(path.join(root, 'bin/preload.mjs'))));
  if (before && !allowed.includes(digest(before))) throw new ReleaseError('INSTALL_BOOTSTRAP_CONFLICT');
  if (!publish) return { helper, bytes, before };
  privateReleaseDirectory(path.dirname(helper));
  if (before) { if (digest(before) !== digest(bytes)) replaceVerifiedFile(helper, bytes, allowed, { mode: 0o600 }); fs.chmodSync(helper, 0o600); }
  else {
    const temporary = helper + '.' + randomUUID() + '.tmp'; fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    try { fs.linkSync(temporary, helper); } finally { fs.unlinkSync(temporary); }
  }
  if (digest(readReleaseBytes(helper)) !== digest(bytes) || fs.statSync(helper).mode & 0o077) throw new ReleaseError('INSTALL_BOOTSTRAP_NOT_READY');
  return { helper, before, bytes };
}
export function createRecovery(base, releaseRoot, stage, receipt) {
  const id = path.basename(releaseRoot), destination = path.join(base, 'recovery', id), temporary = destination + '.prepare-' + randomUUID();
  privateReleaseDirectory(path.dirname(destination)); privateReleaseDirectory(temporary);
  try {
    const recovery = { ...receipt, entries: receipt.entries.map(entry => {
      const bytes = readReleaseBytes(path.join(stage, 'overlay', entry.relative + '.original'));
      if (digest(bytes) !== entry.before) throw new ReleaseError('RELEASE_INVALID_ORIGINAL');
      const backup = path.join(temporary, 'stock', entry.relative + '.original'); privateReleaseDirectory(path.dirname(backup)); fs.writeFileSync(backup, bytes, { mode: 0o600, flag: 'wx' });
      return { ...entry, originalFile: path.join(destination, 'stock', entry.relative + '.original') };
    }) };
    writeReleaseJson(path.join(temporary, 'receipt.json'), recovery);
    if (fs.existsSync(destination)) throw new ReleaseError('RELEASE_RECOVERY_CONFLICT');
    fs.renameSync(temporary, destination);
    return digest(readReleaseBytes(path.join(destination, 'receipt.json')));
  } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true }); }
}
