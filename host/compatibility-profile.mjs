import path from 'node:path';
import {createHash} from 'node:crypto';
import {readReleaseBytes,selectCompatibilityProfile} from '../bin/preload.mjs';
import {RuntimeError} from '../vendor/pi-paseo/src/state.mjs';

/** Read every pinned original; never assemble a profile from per-file matches. */
export function selectHostCompatibility({compatibility,hostRoot,previousReceipt}) {
 selectCompatibilityProfile(compatibility,compatibility.files);
 const hashes={};
 for(const relative of Object.keys(compatibility.files||{})) {
  const old=previousReceipt?.entries.find(entry=>entry.relative===relative);
  const bytes=readReleaseBytes(old?old.originalFile:path.join(hostRoot,relative));
  hashes[relative]=createHash('sha256').update(bytes).digest('hex');
  if(old&&hashes[relative]!==old.before)throw new RuntimeError('HOST_NOT_COMPATIBLE');
 }
 const profile=selectCompatibilityProfile(compatibility,hashes);
 return {...compatibility,...profile,profileId:profile.id,serverSha256:profile.files[compatibility.serverRelativePath||'apps/daemon/dist/server.js']};
}
