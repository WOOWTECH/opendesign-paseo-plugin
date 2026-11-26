import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {privateDirectory,atomicJson,RuntimeError,assertSafePath} from './state.mjs';
const template=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runtime');
const lock=fs.readFileSync(path.join(template,'package-lock.json'));
const lockSha256=createHash('sha256').update(lock).digest('hex');
export const RUNTIME_LOCK_SHA256=lockSha256;
export const PASEO_VERSION='0.17.5';
export const LEGACY_PASEO_VERSION='0.11.2';
export const RUNTIME_REVISION=PASEO_VERSION+'-r1-'+lockSha256.slice(0,12);
const LEGACY_LOCK_SHA256='ae1416f8ca854dac432e1eac0e057490bce581ab08c0d60851f3298bb8893d00';
export const LEGACY_RUNTIME_REVISION=LEGACY_PASEO_VERSION+'-r1-'+LEGACY_LOCK_SHA256.slice(0,12);
export const runtimeDirectory=loc=>path.join(loc.runtimeDir,'releases',RUNTIME_REVISION);
export const legacyRuntimeDirectory=loc=>path.join(loc.runtimeDir,'releases',LEGACY_RUNTIME_REVISION);
export function legacyRuntimeReady(loc) {
 try {
  const root=legacyRuntimeDirectory(loc),receiptFile=path.join(root,'.pi-paseo-runtime.json');assertSafePath(receiptFile);
  const receipt=JSON.parse(fs.readFileSync(receiptFile));
  return receipt.revision===LEGACY_RUNTIME_REVISION&&receipt.lockSha256===LEGACY_LOCK_SHA256&&
   JSON.parse(fs.readFileSync(path.join(root,'node_modules/@getpaseo/cli/package.json'))).version===LEGACY_PASEO_VERSION&&
   JSON.parse(fs.readFileSync(path.join(root,'node_modules/@getpaseo/server/package.json'))).version===LEGACY_PASEO_VERSION;
 } catch {return false;}
}
export function runtimeReady(loc) {
 try {
  const root=runtimeDirectory(loc);
  assertSafePath(path.join(root,'.pi-paseo-runtime.json'));
  const receipt=JSON.parse(fs.readFileSync(path.join(root,'.pi-paseo-runtime.json')));
  return receipt.lockSha256===lockSha256&&receipt.revision===RUNTIME_REVISION&&JSON.parse(fs.readFileSync(path.join(root,'node_modules/@getpaseo/cli/package.json'))).version===PASEO_VERSION;
 } catch {return false;}
}
export function prepareRuntimeManifest(loc) {
 const root=runtimeDirectory(loc);privateDirectory(root);
 const file=path.join(root,'package.json');assertSafePath(file);
 if(fs.existsSync(file)&&JSON.parse(fs.readFileSync(file)).name!=='pi-paseo-managed-runtime')throw new RuntimeError('RUNTIME_NOT_OWNED');
 for(const name of ['package.json','package-lock.json']) {
  assertSafePath(path.join(root,name));fs.copyFileSync(path.join(template,name),path.join(root,name));
 }
 return root;
}
export function markRuntimeReady(loc) {atomicJson(path.join(runtimeDirectory(loc),'.pi-paseo-runtime.json'),{lockSha256,revision:RUNTIME_REVISION});}
