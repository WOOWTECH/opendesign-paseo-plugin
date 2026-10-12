import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {nativeOnboarding} from '../host/native-onboarding.mjs';
function harness(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'od-native-onboard-'));let project=null;const conversations=[];const calls=[];let fail=false;
 const request=async(method,route,body)=>{
  calls.push({method,route,body});
  if(route==='/api/projects'&&method==='POST'){project={...body};conversations.push({id:'conversation-native',projectId:body.id,title:null,sessionMode:'chat'});if(fail)throw new Error('Response was lost after native write');return {project,conversationId:'conversation-native'};}
  if(route.endsWith('/conversations')){
   if(method==='GET')return {conversations};
   throw new Error('A second conversation must never be created');
  }
  if(method==='PATCH')return {conversation:conversations[0]};
  if(method==='PUT')return {message:body};
  return project;
 };
 return {dir,calls,conversations,request,setFail:v=>fail=v,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('native HTTP project and known conversation are reused without model inference',async()=>{
 const h=harness();try{const remembered=[];const fn=nativeOnboarding({dataDir:h.dir,request:h.request});const first=await fn('Use official login only',x=>remembered.push(x));const second=await fn('Use official login only',()=>{},first);
  assert.deepEqual(second,first);assert.equal(h.calls.filter(x=>x.method==='POST').length,1);assert.equal(remembered[0].projectId,first.projectId);assert.equal(remembered.find(x=>x.conversationId).conversationId,first.conversationId);
  assert.equal(h.calls.some(x=>x.route.includes('/chat')||x.route.includes('/runs')),false);assert.ok(h.calls.find(x=>x.method==='PUT').body.content.includes('/paseo/setup'));
 }finally{h.cleanup();}
});
test('lost conversation response reconciles the existing native identity instead of duplicating',async()=>{
 const h=harness();try{const fn=nativeOnboarding({dataDir:h.dir,request:h.request});h.setFail(true);await assert.rejects(fn('Setup',()=>{}));h.setFail(false);const result=await fn('Setup',()=>{});assert.equal(result.conversationId,'conversation-native');assert.equal(h.conversations.length,1);
 }finally{h.cleanup();}
});
test('uncertain native create with no confirmed conversation fails closed on retry',async()=>{
 const h=harness();try{const fn=nativeOnboarding({dataDir:h.dir,request:h.request});h.setFail(true);await assert.rejects(fn('Setup',()=>{}));h.conversations.length=0;await assert.rejects(fn('Setup',()=>{}),{code:'ONBOARDING_UNCERTAIN'});assert.equal(h.calls.filter(x=>x.route==='/api/projects'&&x.method==='POST').length,1);
 }finally{h.cleanup();}
});
test('uses the conversation already created by native project creation',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'od-native-seed-'));let project;const conversations=[];
 const request=async(method,route,body)=>{
  if(method==='POST'&&route==='/api/projects'){project={...body};conversations.push({id:'native-initial',projectId:body.id,title:null,sessionMode:'chat'});return {project,conversationId:'native-initial'};}
  if(route.endsWith('/conversations')){if(method==='GET')return {conversations};const row={id:'duplicate',projectId:project.id,...body};conversations.push(row);return {conversation:row};}
  if(method==='PATCH')return {conversation:conversations[0]};
  if(method==='PUT')return {message:body};
  return project||null;
 };
 try{const result=await nativeOnboarding({dataDir:dir,request})('Setup',()=>{});assert.equal(result.conversationId,'native-initial');assert.equal(conversations.length,1);}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
