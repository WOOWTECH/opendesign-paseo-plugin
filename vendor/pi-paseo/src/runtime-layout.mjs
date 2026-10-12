import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {privateDirectory,atomicJson,RuntimeError,assertSafePath} from './state.mjs';
const template=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runtime');
const lock=fs.readFileSync(path.join(template,'package-lock.json'));
const lockSha256=createHash('sha256').update(lock).digest('hex');
export const RUNTIME_REVISION='0.11.2-r1-'+lockSha256.slice(0,12);
export const runtimeDirectory=loc=>path.join(loc.runtimeDir,'releases',RUNTIME_REVISION);
export function runtimeReady(loc) {
 try {
  const root=runtimeDirectory(loc);
  assertSafePath(path.join(root,'.pi-paseo-runtime.json'));
  const receipt=JSON.parse(fs.readFileSync(path.join(root,'.pi-paseo-runtime.json')));
  return receipt.lockSha256===lockSha256&&JSON.parse(fs.readFileSync(path.join(root,'node_modules/@getpaseo/cli/package.json'))).version==='0.11.2';
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
