import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {selectedBrand} from '../vendor/pi-paseo/src/brand-identity.mjs';
import {patchBrandIdentitySource,BRAND_SERVER_PATH,ORIGINAL_BRAND_SERVER_SHA256,PATCHED_BRAND_SERVER_SHA256} from '../vendor/pi-paseo/src/brand-identity-patch.mjs';
import {prepareRuntimeManifest,runtimeDirectory,runtimeReady,PASEO_VERSION} from '../vendor/pi-paseo/src/runtime-layout.mjs';
import {readyFixture,upstreamServer} from './fixtures/managed-runtime.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');

test('the frozen upstream server gets only the optional hello brand field and helper import',()=>{
 const source=upstreamServer().toString();assert.equal(sha(source),ORIGINAL_BRAND_SERVER_SHA256);
 const patched=patchBrandIdentitySource(source);assert.equal(sha(patched),PATCHED_BRAND_SERVER_SHA256);
 assert.equal(patchBrandIdentitySource(patched),patched);
 assert.equal(patched.replace('import {agentConnectBrand} from "./pi-paseo-brand-identity.mjs";\n','').replace('            brand: agentConnectBrand,\n',''),source);
 assert.throws(()=>patchBrandIdentitySource(source+'\n'),{code:'BRAND_IDENTITY_SOURCE_MISMATCH'});
});
test('brand comes from the locally selected target; unknown targets fail closed',()=>{
 for(const target of ['paseo','woowtech','apporo'])assert.equal(selectedBrand(target).id,target);
 assert.throws(()=>selectedBrand('remote-untrusted'),{code:'INVALID_CONNECTION_TARGET'});
 const url=new URL('../vendor/pi-paseo/src/brand-identity.mjs',import.meta.url).href;
 for(const target of ['paseo','woowtech','apporo']){
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import {agentConnectBrand} from ${JSON.stringify(url)};console.log(agentConnectBrand.id)`],{env:{PATH:process.env.PATH,PI_PASEO_CONNECTION_TARGET:target},encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(result.stdout.trim(),target);
 }
});
test('a stale receipt, edited server or edited brand helper is not a ready runtime',t=>{
 const runtimeDir=fs.mkdtempSync(path.join(os.tmpdir(),'od-brand-'));t.after(()=>fs.rmSync(runtimeDir,{recursive:true,force:true}));
 const loc={runtimeDir},root=prepareRuntimeManifest(loc),cli=path.join(root,'node_modules/@getpaseo/cli');fs.mkdirSync(cli,{recursive:true});fs.writeFileSync(path.join(cli,'package.json'),JSON.stringify({version:PASEO_VERSION}));
 readyFixture(loc);assert.equal(runtimeReady(loc),true);
 const receipt=path.join(root,'.pi-paseo-runtime.json'),before=fs.readFileSync(receipt);
 const old=JSON.parse(before);delete old.brandIdentityPatchId;fs.writeFileSync(receipt,JSON.stringify(old));assert.equal(runtimeReady(loc),false);fs.writeFileSync(receipt,before);
 const server=path.join(runtimeDirectory(loc),BRAND_SERVER_PATH);fs.appendFileSync(server,'\n');assert.equal(runtimeReady(loc),false);
 readyFixture(loc);fs.appendFileSync(path.join(path.dirname(server),'pi-paseo-brand-identity.mjs'),'\n');assert.equal(runtimeReady(loc),false);
});
