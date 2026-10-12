import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {registerPaseoBridge,installBridgeBodyParser,PLUGIN_ID,MCP_ID} from '../host/adapter.mjs';
import {createManager} from '../src/manager.mjs';
import {createAuthFlow} from '../src/auth-flow.mjs';
import {runtimeContext} from '../src/runtime-context.mjs';

const packageRoot=path.resolve(import.meta.dirname,'..');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function bounded(promise,ms=1000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('operation did not complete independently')),ms);})]);}finally{clearTimeout(timer);}}
async function fixture(t,{write,managerFactory,installed=true}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'od-adapter-race-')),home=path.join(root,'home'),dataDir=path.join(root,'data');
 fs.mkdirSync(home);fs.mkdirSync(path.join(dataDir,'plugins',PLUGIN_ID),{recursive:true});
 for(const name of ['SKILL.md','open-design.json'])fs.copyFileSync(path.join(packageRoot,'plugin',name),path.join(dataDir,'plugins',PLUGIN_ID,name));
 const calls=[];let present=installed,config={servers:[{id:'unrelated',transport:'stdio',command:'other'}]},state={desiredEnabled:false,daemon:{owned:false,running:false},operation:null};
 const fallback={status:async()=>({...state}),enable:async()=>{calls.push('enable');state={...state,desiredEnabled:true};},disable:async()=>{calls.push('disable');state={...state,desiredEnabled:false};},
  restore:async()=>{calls.push('restore');},cancelQueuedOperations:()=>{calls.push('cancelQueuedOperations');},cancelPending:()=>{calls.push('cancelPending');},shutdown:async()=>{calls.push('shutdown');return{stopped:true};}};
 const manager=managerFactory?.({home,dataDir,packageRoot,calls,fallback,setState:value=>{state={...state,...value};}})||fallback;
 const app=express();installBridgeBodyParser(app,{allowedOrigins:['https://od.example.test']});
 const lifecycle=registerPaseoBridge(app,{home,dataDir,packageRoot,port:7457,allowedOrigins:['https://od.example.test'],manager,
  nativeRequest:async()=>null,getInstalledPluginRecord:()=>present?{id:PLUGIN_ID,sourceKind:'github'}:null,
  mcpConfig:{writeMcpConfig:async(_,transform)=>{const previous=config;const next=transform(previous);await write?.(next,previous);config=next;return config;}}});
 app.post('/api/plugins/install',(_req,res)=>{present=true;res.json({installed:true});});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
 const post=(body,route='/api/paseo-bridge')=>fetch(base+route,{method:'POST',headers:{Origin:'https://od.example.test','Content-Type':'application/json'},body:JSON.stringify(body)});
 const status=async()=>{const response=await fetch(base+'/api/paseo-bridge');assert.equal(response.status,200);return response.json();};
 t.after(async()=>{await lifecycle.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
 return {home,dataDir,lifecycle,manager,post,status,calls,config:()=>config,present:value=>{present=value;}};
}
async function finish(h){for(let i=0;i<100;i++){const value=await h.status();if(value.operation?.status!=='running')return value;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('host operation stayed running');}

test('uninstall drains an in-flight MCP write and prevents enable after removal',async t=>{
 const entered=deferred(),gate=deferred();t.after(()=>gate.resolve());
 const h=await fixture(t,{write:async next=>{if(next.servers.some(row=>row.id===MCP_ID)){entered.resolve();await gate.promise;}}});
 assert.equal((await h.post({action:'enable'})).status,202);await bounded(entered.promise);
 const uninstall=h.lifecycle.beforeUninstall(PLUGIN_ID);uninstall.catch(()=>{});
 assert.equal((await h.post({action:'enable'})).status,409);gate.resolve();await bounded(uninstall);
 h.present(false);assert.equal((await h.status()).desiredEnabled,false);
 assert.equal(h.calls.includes('enable'),false);assert.equal(h.calls.filter(call=>call==='disable').length,1);
 assert.deepEqual(h.config().servers,[{id:'unrelated',transport:'stdio',command:'other'}]);
 assert.equal(JSON.parse(fs.readFileSync(path.join(h.dataDir,'paseo/host-registration.json'))).registered,false);
});

test('priority disable fences a delayed enable and keeps its own polling operation ID',async t=>{
 const entered=deferred(),gate=deferred();t.after(()=>gate.resolve());
 const h=await fixture(t,{write:async next=>{if(next.servers.some(row=>row.id===MCP_ID)){entered.resolve();await gate.promise;}}});
 await h.post({action:'enable'});await bounded(entered.promise);
 const response=await h.post({action:'disable'});assert.equal(response.status,202);const scheduled=await response.json();
 gate.resolve();const value=await finish(h);assert.equal(value.operation.id,scheduled.operation.id);assert.equal(value.operation.status,'completed');
 assert.equal(value.desiredEnabled,false);assert.equal(h.calls.includes('enable'),false);assert.ok(h.calls.includes('disable'));
});

test('shutdown drains pending MCP publication and fences late restore/enable',async t=>{
 const entered=deferred(),gate=deferred();t.after(()=>gate.resolve());
 const h=await fixture(t,{write:async next=>{if(next.servers.some(row=>row.id===MCP_ID)){entered.resolve();await gate.promise;}}});
 h.lifecycle.start();await bounded(entered.promise);let returned=false;
 const stopping=h.lifecycle.shutdown().then(()=>{returned=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(returned,false);
 gate.resolve();await bounded(stopping);assert.equal(h.calls.includes('restore'),false);assert.equal(h.calls.includes('enable'),false);
 assert.equal(h.calls.at(-1),'shutdown');assert.equal((await h.post({action:'enable'})).status,409);
});

test('completed host operation cannot conceal an independent manager operation',async t=>{
 let setState;const h=await fixture(t,{managerFactory:input=>{setState=input.setState;return input.fallback;}});
 const scheduled=await (await h.post({action:'enable'})).json();assert.equal((await finish(h)).operation.id,scheduled.operation.id);
 const current={id:'independent-login',action:'login',status:'running',startedAt:new Date().toISOString()};setState({operation:current});
 assert.deepEqual((await h.status()).operation,current);
});

test('completed host operation cannot replace a newer manager result for the same action',async t=>{
 let setState;const h=await fixture(t,{managerFactory:input=>{setState=input.setState;return input.fallback;}});
 await h.post({action:'enable'});await finish(h);
 const current={id:'new-manager-enable',action:'enable',status:'error',startedAt:new Date(Date.now()+1000).toISOString(),completedAt:new Date(Date.now()+2000).toISOString(),code:'DAEMON_UNREACHABLE'};
 setState({operation:current});assert.deepEqual((await h.status()).operation,current);
});

test('host long job ID remains stable while the manager journals the same active action',async t=>{
 const entered=deferred(),gate=deferred();t.after(()=>gate.resolve());
 const h=await fixture(t,{managerFactory:({fallback,setState})=>({...fallback,enable:async()=>{setState({operation:{id:'manager-id',action:'enable',status:'running'}});entered.resolve();await gate.promise;}})});
 const scheduled=await (await h.post({action:'enable'})).json();await bounded(entered.promise);assert.equal((await h.status()).operation.id,scheduled.operation.id);
 gate.resolve();
});

test('status started during acceptance keeps its running operation until the next GET can read the final two-provider receipt',async t=>{
 const acceptanceEntered=deferred(),acceptanceGate=deferred(),acceptanceCompleted=deferred(),statusEntered=deferred(),statusGate=deferred();
 t.after(()=>{acceptanceGate.resolve();statusGate.resolve();});let deferStatus=true;
 const claude={provider:'claude',passed:true,firstReply:true,followup:true,model:'claude-haiku-4-5',modeId:'default',cleanup:{archived:true}};
 const partial={checkedAt:'2026-10-12T06:02:33.000Z',passed:false,providers:[claude]};
 const final={checkedAt:'2026-10-12T06:02:42.000Z',passed:false,providers:[claude,{provider:'pi',passed:true,firstReply:true,followup:true,model:'openrouter/anthropic/claude-haiku-4.5',modeId:null,cleanup:{archived:true}}]};
 const h=await fixture(t,{managerFactory:({fallback,setState})=>{
  setState({desiredEnabled:true,lastVerification:partial});
  return{...fallback,acceptance:async()=>{acceptanceEntered.resolve();await acceptanceGate.promise;setState({lastVerification:final});acceptanceCompleted.resolve();return final;},
   status:async()=>{const value=await fallback.status();if(deferStatus){deferStatus=false;statusEntered.resolve();await statusGate.promise;}return value;}};
 }});
 const scheduled=await(await h.post({action:'acceptance',providers:['claude','pi']})).json();assert.equal(scheduled.operation.status,'running');await bounded(acceptanceEntered.promise);
 const reading=h.status();await bounded(statusEntered.promise);
 acceptanceGate.resolve();await bounded(acceptanceCompleted.promise);await new Promise(resolve=>setImmediate(resolve));
 statusGate.resolve();const first=await bounded(reading);
 assert.equal(first.operation.id,scheduled.operation.id);assert.equal(first.operation.status,'running','a pre-completion receipt must not be paired with completed');
 assert.deepEqual(first.lastVerification,partial);
 const second=await h.status();assert.equal(second.operation.id,scheduled.operation.id);assert.equal(second.operation.status,'completed');assert.deepEqual(second.lastVerification,final);
 assert.deepEqual(second.lastVerification.providers.map(row=>row.provider),['claude','pi']);assert.equal(second.lastVerification.passed,false);
});

test('absent plugin with an unregistered receipt still stops orphaned enabled intent',async t=>{
 const disabled=deferred();const h=await fixture(t,{installed:false,managerFactory:({fallback,setState})=>{setState({desiredEnabled:true});return{...fallback,disable:async()=>{await fallback.disable();disabled.resolve();}};}});
 fs.mkdirSync(path.join(h.dataDir,'paseo'),{recursive:true});fs.writeFileSync(path.join(h.dataDir,'paseo/host-registration.json'),JSON.stringify({registered:false}));
 h.lifecycle.start();await bounded(disabled.promise);assert.equal((await h.status()).desiredEnabled,false);
});

test('uninstall aborts active manager acceptance and invalidates an already queued enable',async t=>{
 const entered=deferred(),gate=deferred();t.after(()=>gate.resolve());let acceptance,queuedEnable;
 const h=await fixture(t,{managerFactory:options=>createManager({...options,env:{PATH:process.env.PATH}},{supervisor:{start:async()=>{},stop:async()=>{}},runtime:async(_,action,input,{signal})=>{
  options.calls.push(action);
  if(action==='acceptance'){entered.resolve();await new Promise((resolve,reject)=>{gate.promise.then(resolve);signal.addEventListener('abort',()=>reject({code:'OPERATION_ABORTED'}),{once:true});});return{passed:false,providers:[]};}
  return{phase:'running',daemon:{owned:true,running:true,reachable:true}};
 }})});
 await h.manager.enable();acceptance=h.manager.acceptance({providers:['claude']});acceptance.catch(()=>{});await bounded(entered.promise);
 queuedEnable=h.manager.enable();queuedEnable.catch(()=>{});await bounded(h.lifecycle.beforeUninstall(PLUGIN_ID));
 await assert.rejects(acceptance,{code:'OPERATION_ABORTED'});await assert.rejects(queuedEnable,{code:'OPERATION_ABORTED'});
 assert.equal((await h.status()).desiredEnabled,false);assert.equal(h.calls.filter(action=>action==='enable').length,1);
});

test('verified native reinstall permits a fresh enable after uninstall',async t=>{
 const h=await fixture(t);await h.post({},'/api/plugins/install');
 for(let i=0;i<100&&!h.calls.includes('enable');i++)await new Promise(resolve=>setTimeout(resolve,5));await finish(h);
 await h.lifecycle.beforeUninstall(PLUGIN_ID);h.present(false);
 assert.equal((await h.post({action:'enable'})).status,409);
 assert.equal((await h.post({},'/api/plugins/install')).status,200);
 for(let i=0;i<100&&h.calls.filter(call=>call==='enable').length<2;i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(h.calls.filter(call=>call==='enable').length,2);assert.equal((await finish(h)).desiredEnabled,true);
});

test('real HTTP Pi complete/cancel bypass acceptance and keep protected auth material out of status',async t=>{
 const entered=deferred(),gate=deferred(),submitted=deferred();t.after(()=>gate.resolve());let hold=false,kills=0;
 const h=await fixture(t,{managerFactory:options=>{
  const context=runtimeContext({...options,env:{PATH:process.env.PATH,ANTHROPIC_API_KEY:'tenant-key-fixture'}});
  const auth=createAuthFlow(context,{settleMs:5,launch:()=>{
   const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
   child.kill=()=>{kills++;queueMicrotask(()=>child.emit('close',null));return true;};
   child.stdin.on('data',line=>{if(hold)submitted.resolve(JSON.parse(String(line)));else{child.stdout.write(JSON.stringify({phase:'authorization_completed'})+'\n');queueMicrotask(()=>child.emit('close',0));}});
   queueMicrotask(()=>{child.stdout.write(JSON.stringify({phase:'awaiting_authorization',authorizationUrl:'https://auth.openai.com/oauth/authorize?state=private-fixture',requiresCode:true})+'\n');});return child;
  }});
  return createManager(context,{auth,supervisor:{start:async()=>{},stop:async()=>{}},runtime:async(_,action,input,{signal})=>{
   if(action==='acceptance'){entered.resolve();await new Promise((resolve,reject)=>{gate.promise.then(resolve);signal.addEventListener('abort',()=>reject({code:'OPERATION_ABORTED'}),{once:true});});return{passed:false,providers:[]};}
   return{phase:'running',daemon:{owned:true,running:true,reachable:true}};
  }});
 }});
 await h.manager.enable();const start=await (await h.post({action:'login',provider:'pi',step:'start'})).json();assert.equal(start.requiresCode,true);
 assert.equal((await h.post({action:'acceptance',providers:['claude']})).status,202);await bounded(entered.promise);
 const completed=await bounded(h.post({action:'login',provider:'pi',step:'complete',code:'private-callback-fixture'}));assert.equal(completed.status,200);assert.equal((await completed.json()).phase,'authorization_completed');
 assert.equal((await h.status()).operation.action,'acceptance');assert.equal((await h.status()).operation.status,'running');
 hold=true;await h.post({action:'login',provider:'pi',step:'start'});
 const completing=h.post({action:'login',provider:'pi',step:'complete',code:'private-callback-fixture'});await bounded(submitted.promise);
 const cancelled=await bounded(h.post({action:'login',provider:'pi',step:'cancel'}));assert.equal(cancelled.status,200);assert.equal((await cancelled.json()).phase,'cancelled');
 assert.equal((await bounded(completing)).status,200);assert.ok(kills>0);
 const status=JSON.stringify(await h.status());for(const secret of ['private-fixture','private-callback-fixture','tenant-key-fixture','authorizationUrl'])assert.equal(status.includes(secret),false);
 gate.resolve();await finish(h);
});
