import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {nativeOnboarding} from '../host/native-onboarding.mjs';

test('missing old checkpoint recovers the owned project, conversation and seed without writes',async t=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'paseo-recover-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
 const project={id:'owned-project',metadata:{woowPaseoInstallation:'installation-marker'}};const calls=[];
 const request=async(method,route)=>{
  calls.push({method,route});assert.equal(method,'GET');
  if(route==='/api/projects')return {projects:[{id:'peer'},project]};
  if(route.endsWith('/messages'))return {messages:[{id:'seed',role:'assistant',content:'Paseo 的安裝與連線由受保護設定頁處理。 Continue existing setup.'}]};
  if(route.endsWith('/conversations'))return {conversations:[{id:'owned-conversation'}]};
  return project;
 };
 const fn=nativeOnboarding({dataDir,request,reconcileExisting:true});const first=await fn('Setup',()=>{});
 assert.equal(first.projectId,'owned-project');assert.equal(first.conversationId,'owned-conversation');
 await fn('Setup',()=>{},first);assert.equal(calls.filter(x=>x.route==='/api/projects').length,1);
});
test('multiple marked projects fail closed instead of creating another onboarding',async t=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'paseo-ambiguous-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
 const fn=nativeOnboarding({dataDir,reconcileExisting:true,request:async(method,route)=>{assert.equal(method,'GET');assert.equal(route,'/api/projects');return {projects:[1,2].map(id=>({id:String(id),metadata:{woowPaseoInstallation:'marker'}}))};}});
 await assert.rejects(fn('Setup',()=>{}),{code:'ONBOARDING_UNCERTAIN'});
});
