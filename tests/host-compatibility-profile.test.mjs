import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {selectCompatibilityProfile, verifyRelease} from '../bin/preload.mjs';
import {selectHostCompatibility} from '../host/compatibility-profile.mjs';
import {releaseFixture} from './host-release-fixture.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const compatibility=JSON.parse(fs.readFileSync(new URL('../host/compatibility.json',import.meta.url)));
const server='apps/daemon/dist/server.js', html='apps/web/out/index.html';
const omnigentId='woow-omnigent-20261012.0425';

test('base pins remain exact and the Omnigent profile requires the complete six-file fingerprint',()=>{
 assert.equal(compatibility.files[server],'57b001ded470fc56f20d180544173f20690992aafd79542ac490adeef50911a4');
 assert.equal(compatibility.files[html],'1328ace1a31672dc64440f76ebb2f2a6b25c4cbafc53fbc921bc51f0e2c8568c');
 const base=selectCompatibilityProfile(compatibility,compatibility.files);
 assert.equal(base.id,'base-opendesign-0.24.1');
 const omni=compatibility.profiles.find(profile=>profile.id===omnigentId);
 assert.equal(omni.files[server],'06c1dd26b8c43e3a997e95dceabbea908d0935dd4cce49b931f5daf24a8a1799');
 assert.equal(omni.files[html],'fe91b68d81fee458597f50973aff0af496d7f6c6011c5e8c7cf50ec5cf5eb3f6');
 assert.equal(omni.daemonPackageVersion,'0.23.1'); assert.equal(omni.openDesignImageVersion,'0.24.1');
 assert.equal(omni.imageSha256,'9532363f25345fb94ce3504196bafcf91533f572600496d550bec918d03db1a1');
 assert.deepEqual(Object.keys(omni.files).sort(),Object.keys(compatibility.files).sort());
 for(const file of Object.keys(compatibility.files).filter(file=>![server,html].includes(file)))assert.equal(omni.files[file],compatibility.files[file]);
 assert.equal(selectCompatibilityProfile(compatibility,omni.files).id,omnigentId);
});

test('mixed, unknown, incomplete and extra source fingerprints fail closed',()=>{
 const omni=compatibility.profiles.find(profile=>profile.id===omnigentId);
 const mixed={...compatibility.files,[server]:omni.files[server]}, unknown={...omni.files,[server]:'0'.repeat(64)}, missing={...omni.files}; delete missing[html];
 for(const files of [mixed,unknown,missing,{...omni.files,'unexpected.js':'0'.repeat(64)}])assert.throws(()=>selectCompatibilityProfile(compatibility,files),{code:'HOST_NOT_COMPATIBLE'});
 for(const bad of [
  {...compatibility,profiles:[{...omni,files:{[server]:omni.files[server]}}]},
  {...compatibility,profiles:[omni,omni]},
  {...compatibility,profiles:[{...omni,daemonPackageVersion:'0.24.0'}]},
 ])assert.throws(()=>selectCompatibilityProfile(bad,omni.files),{code:'HOST_NOT_COMPATIBLE'});
});

function profileFixture(t){
 const f=releaseFixture(t), base=JSON.parse(fs.readFileSync(path.join(f.source,'host/compatibility.json')));
 const stocks={...f.stocks,[server]:'// Native Omnigent registration remains here.\n'+f.stocks[server],[html]:f.stocks[html].replace('Original app','Original app + Omnigent')};
 const omni={id:omnigentId,label:'Woow Omnigent v0.1.0',files:Object.fromEntries(Object.entries(stocks).map(([file,bytes])=>[file,sha(bytes)]))};
 f.write(f.source,'host/compatibility.json',JSON.stringify({...base,profileId:'base-opendesign-0.24.1',profiles:[omni]}));
 for(const [file,bytes] of Object.entries(stocks))f.write(f.hostRoot,file,bytes);
 return {...f,profileStocks:stocks};
}

test('real Omnigent-profile install/boot/upgrade/reuse verifies profile receipts and retains host additions',async t=>{
 const f=profileFixture(t);
 assert.equal(selectHostCompatibility({compatibility:JSON.parse(fs.readFileSync(path.join(f.source,'host/compatibility.json'))),hostRoot:f.hostRoot}).profileId,omnigentId);
 const first=f.install();assert.equal(first.compatibilityProfile,omnigentId);
 let receipt=verifyRelease(f.base,f.pointer('current'));assert.equal(receipt.compatibilityProfile,omnigentId);
 assert.equal((await f.boot()).applied,true);
 assert.ok(fs.readFileSync(path.join(f.hostRoot,server),'utf8').includes('Native Omnigent registration remains here.'));
 f.revision('B');const second=f.install();assert.notEqual(second.releaseRoot,first.releaseRoot);
 assert.equal((await f.boot()).applied,true); assert.equal(f.install().reused,true);
 receipt=verifyRelease(f.base,f.pointer('current'));assert.equal(receipt.compatibilityProfile,omnigentId);
 fs.writeFileSync(path.join(second.releaseRoot,'host/adapter.mjs'),'rejected');
 const recovered=await f.boot();assert.equal(recovered.fallback,'previous');assert.equal(f.pointer('current').releaseRoot,first.releaseRoot);
});

test('a mixed actual host cannot publish a release or modify host code',t=>{
 const f=profileFixture(t);f.write(f.hostRoot,html,f.stocks[html]);
 const before=Object.fromEntries(Object.keys(f.stocks).map(file=>[file,fs.readFileSync(path.join(f.hostRoot,file))]));
 assert.throws(()=>f.install(),{code:'HOST_NOT_COMPATIBLE'});
 assert.equal(fs.existsSync(path.join(f.base,'current.json')),false);
 for(const [file,bytes] of Object.entries(before))assert.deepEqual(fs.readFileSync(path.join(f.hostRoot,file)),bytes);
});

const privateRoot='/data/pi-agent/home/.private/opendesign-paseo';
const captures={
 [server]:path.join(privateRoot,'host-current-server.js'),
 [html]:path.join(privateRoot,'host-current-index.html'),
 ...Object.fromEntries(Object.keys(compatibility.files).filter(file=>![server,html].includes(file)).map(file=>[file,path.join(privateRoot,'host-baseline',file.replace('apps/daemon/dist/',''))])),
};
test('captured current Omnigent sources pass real six-file install/boot/reuse and retain native routes and Next bundles',
 {skip:Object.values(captures).every(file=>fs.existsSync(file))?false:'Authorized current source capture is required'},async t=>{
  const f=releaseFixture(t);
  f.write(f.source,'host/compatibility.json',JSON.stringify(compatibility));
  const sourceFiles={};
  for(const [relative,file] of Object.entries(captures)) {
   sourceFiles[relative]=fs.readFileSync(file);f.write(f.hostRoot,relative,sourceFiles[relative]);
  }
  const selected=selectHostCompatibility({compatibility,hostRoot:f.hostRoot});assert.equal(selected.profileId,omnigentId);
  const installed=f.install();assert.equal(installed.compatibilityProfile,omnigentId);
  assert.equal((await f.boot()).applied,true);assert.equal(f.install().reused,true);
  const receipt=verifyRelease(f.base,f.pointer('current'));assert.equal(receipt.entries.length,6);assert.equal(receipt.compatibilityProfile,omnigentId);
  const originalServer=sourceFiles[server].toString(),patchedServer=fs.readFileSync(path.join(f.hostRoot,server),'utf8');
  const omnigentLines=originalServer.split('\n').filter(line=>/omnigent/i.test(line)&&(/^import\s/.test(line)||/register\w*Routes/.test(line)));
  assert.ok(omnigentLines.length>0);for(const line of omnigentLines)assert.ok(patchedServer.includes(line));
  const originalHtml=sourceFiles[html].toString(),patchedHtml=fs.readFileSync(path.join(f.hostRoot,html),'utf8');
  for(const [tag] of originalHtml.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="[^"]+"[^>]*>/g))assert.ok(patchedHtml.includes(tag));
  assert.ok(patchedHtml.includes('/paseo/entry.js'));
 });
