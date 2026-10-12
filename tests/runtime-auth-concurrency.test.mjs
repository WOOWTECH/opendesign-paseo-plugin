import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createManager} from '../src/manager.mjs';
import {createAuthFlow} from '../src/auth-flow.mjs';
import {runtimeContext,sourceRoot} from '../src/runtime-context.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function bounded(promise,ms=400){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('auth waited for an unrelated runtime job')),ms);})]);}finally{clearTimeout(timer);}}
function fixture(t,{holdCompletion=false,settleMs=5}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'od-auth-lane-')),home=path.join(root,'home'),dataDir=path.join(root,'data');fs.mkdirSync(home);fs.mkdirSync(dataDir);
 const context=runtimeContext({home,dataDir,packageRoot:sourceRoot,env:{PATH:process.env.PATH}});
 const entered=deferred(),gate=deferred(),submitted=deferred();let child,kills=0,launched=0;
 const auth=createAuthFlow(context,{settleMs,launch:()=>{
  launched++;child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
  child.kill=()=>{kills++;queueMicrotask(()=>child.emit('close',null));return true;};
  child.stdin.on('data',line=>{submitted.resolve(JSON.parse(String(line)));if(!holdCompletion){child.stdout.write(JSON.stringify({phase:'authorization_completed'})+'\n');queueMicrotask(()=>child.emit('close',0));}});
  queueMicrotask(()=>{child.stdout.write(JSON.stringify({phase:'awaiting_authorization',authorizationUrl:'https://auth.openai.com/oauth/authorize?state=private-fixture'})+'\n');child.stdout.write(JSON.stringify({phase:'awaiting_authorization',requiresCode:true})+'\n');});
  return child;
 }});
 const runtime=async(_,action,input,{signal}={})=>{
  if(action==='acceptance'){entered.resolve();await new Promise((resolve,reject)=>{gate.promise.then(resolve);signal?.addEventListener('abort',()=>reject({code:'OPERATION_ABORTED'}),{once:true});});return {checkedAt:new Date().toISOString(),passed:false,providers:[]};}
  return {phase:'running',version:'0.11.2',installed:true,daemon:{owned:true,running:true,reachable:true},providers:[]};
 };
 const manager=createManager({...context,env:context.env},{runtime,auth,supervisor:{start:async()=>{},stop:async()=>{}}});
 t.after(async()=>{gate.resolve();await manager.shutdown();fs.rmSync(root,{recursive:true,force:true});});
 return {manager,entered,gate,submitted,kills:()=>kills,launched:()=>launched};
}

test('Pi complete uses its auth lane while acceptance is still running',async t=>{
 const f=fixture(t);await f.manager.enable();await f.manager.login('start','pi');
 const acceptance=f.manager.acceptance({providers:['claude']});acceptance.catch(()=>{});await f.entered.promise;
 const complete=f.manager.login('complete','pi',{code:'private-callback-fixture'});complete.catch(()=>{});
 const result=await bounded(complete);assert.equal(result.phase,'authorization_completed');
 assert.equal((await f.manager.status()).operation.action,'acceptance');
 assert.equal(JSON.stringify(await f.manager.status()).includes('private-callback-fixture'),false);
 f.gate.resolve();await acceptance;
});

test('Pi cancel preempts pending completion and does not wait for acceptance',async t=>{
 const f=fixture(t,{holdCompletion:true,settleMs:200});await f.manager.enable();await f.manager.login('start','pi');
 const acceptance=f.manager.acceptance({providers:['claude']});acceptance.catch(()=>{});await f.entered.promise;
 const complete=f.manager.login('complete','pi',{code:'private-callback-fixture'});complete.catch(()=>{});await bounded(f.submitted.promise);
 const cancel=await bounded(f.manager.login('cancel','pi'),150);assert.equal(cancel.phase,'cancelled');assert.ok(f.kills()>0);
 await bounded(complete);assert.equal((await f.manager.login('status','pi')).phase,'cancelled');
 assert.equal(JSON.stringify(await f.manager.status()).includes('private-fixture'),false);
 f.gate.resolve();await acceptance;
});

test('cancel invalidates a login start still queued in the auth lane',async t=>{
 const f=fixture(t);const starting=f.manager.login('start','pi');starting.catch(()=>{});
 const cancelled=f.manager.login('cancel','pi');
 await bounded(cancelled);await assert.rejects(starting,{code:'OPERATION_ABORTED'});assert.equal(f.launched(),0);
});

test('shutdown prevents queued auth work from launching after disposal',async t=>{
 const f=fixture(t);const starting=f.manager.login('start','pi');starting.catch(()=>{});
 await f.manager.shutdown();await assert.rejects(starting,{code:'SERVICE_DISPOSED'});assert.equal(f.launched(),0);
 await assert.rejects(f.manager.login('complete','pi',{code:'fixture'}),{code:'SERVICE_DISPOSED'});
});
