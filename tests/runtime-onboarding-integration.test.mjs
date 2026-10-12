import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createManager} from '../src/manager.mjs';
import {sourceRoot} from '../src/runtime-context.mjs';
import {nativeHttpClient,nativeOnboarding} from '../host/native-onboarding.mjs';

// Exercise the actual manager/callback/client over HTTP. The native route
// fixture implements its createOnly contract and injects response failures.
async function fixture(t,{failure='reject_seed'}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'od-onboarding-retry-')),home=path.join(root,'home'),dataDir=path.join(root,'data');
 fs.mkdirSync(home);fs.mkdirSync(dataDir);
 const stateDir=path.join(dataDir,'paseo'),onboardingFile=path.join(stateDir,'onboarding.json'),nativeFile=path.join(stateDir,'native-onboarding.json');
 const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
 const calls=[],checkpoints=[],messages=new Map();let project=null,conversations=[],failed=false,originalMessage=null;
 const server=http.createServer((req,res)=>{void(async()=>{
  let bytes='';for await(const chunk of req)bytes+=chunk;
  const body=bytes?JSON.parse(bytes):undefined,route=new URL(req.url,'http://127.0.0.1').pathname;
  calls.push({method:req.method,route,body});
  const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(req.method==='POST'&&route==='/api/projects'){
   assert.equal(project,null,'must create only one native project');project={...body};
   conversations=[{id:'native-initial-conversation',projectId:project.id,title:null,sessionMode:'chat'}];
   return json({project,conversationId:conversations[0].id});
  }
  const projectRoute=project?'/api/projects/'+encodeURIComponent(project.id):null;
  if(req.method==='GET'&&route===projectRoute)return json({project});
  if(req.method==='GET'&&route===projectRoute+'/conversations')return json({conversations});
  const conversationRoute=projectRoute+'/conversations/'+conversations[0]?.id;
  if(req.method==='PATCH'&&route===conversationRoute){Object.assign(conversations[0],body);return json({conversation:conversations[0]});}
  if(req.method==='PUT'&&route.startsWith(conversationRoute+'/messages/')){
   const messageId=decodeURIComponent(route.slice((conversationRoute+'/messages/').length));assert.equal(messageId,body.id);assert.equal(body.createOnly,true);
   checkpoints.push(read(onboardingFile));
   if(!failed&&failure==='reject_seed'){failed=true;return json({error:'synthetic seed failure'},503);}
   const existing=messages.get(messageId);
   if(body.createOnly&&existing!==undefined)return json({message:existing});
   const {createOnly,...message}=body;messages.set(messageId,message);
   if(!failed&&failure==='lost_seed_response'){
    failed=true;
    // A tenant edit between the lost response and retry must also survive.
    message.content+='\nTenant fixture edit after the lost response';
    originalMessage=structuredClone(message);res.destroy();return;
   }
   return json({message});
  }
  return json({error:'not found'},404);
 })().catch(error=>{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.code||'FIXTURE_ROUTE_FAILED'}));});});
 server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const callback=nativeOnboarding({dataDir,request:nativeHttpClient(server.address().port)});
 const managers=[];let running=false;
 const manager=()=>{
  const value=createManager({home,dataDir,packageRoot:sourceRoot,env:{PATH:process.env.PATH},onboarding:callback},{supervisor:{start:async()=>{},stop:async()=>{}},runtime:async(_,action)=>{
   if(action==='enable')running=true;if(action==='disable')running=false;
   return{installed:true,version:'0.11.2',phase:running?'running':'disabled',daemon:{owned:true,running,reachable:running}};
  }});managers.push(value);return value;
 };
 t.after(async()=>{await Promise.all(managers.map(value=>value.shutdown()));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
 return {manager:manager(),newManager:manager,calls,checkpoints,messages,readOnboarding:()=>read(onboardingFile),readNative:()=>read(nativeFile),onboardingFile,
  originalMessage:()=>originalMessage,conversationCount:()=>conversations.length};
}

test('manager enable resumes a failed native seed on the same project/conversation/message and then stops invoking the callback',async t=>{
 const h=await fixture(t);await assert.rejects(h.manager.ensureOnboarding(),{code:'ONBOARDING_INITIALIZATION_FAILED'});
 const checkpoint=h.readOnboarding(),intent=h.readNative();
 const value=await h.manager.enable();
 const puts=h.calls.filter(call=>call.method==='PUT');assert.equal(puts.length,2,'enable must retry the seed after remembering its conversation');
 assert.equal(puts[1].route,puts[0].route);assert.equal(puts[1].body.id,intent.messageId);assert.equal(puts[1].body.content,puts[0].body.content);
 assert.equal(checkpoint.initialized,false);assert.equal(checkpoint.creation,'retryable');assert.equal(checkpoint.code,'ONBOARDING_INITIALIZATION_FAILED');
 for(const saved of h.checkpoints){assert.equal(saved.projectId,checkpoint.projectId);assert.equal(saved.conversationId,checkpoint.conversationId);assert.equal(saved.initialized,false);}
 assert.equal(value.onboarding.initialized,true);assert.equal(value.onboarding.code,null);
 const ready=h.readOnboarding();assert.equal(ready.initialized,true);assert.equal(ready.code,null);assert.equal(ready.creation,'created');
 assert.equal(ready.projectId,checkpoint.projectId);assert.equal(ready.conversationId,checkpoint.conversationId);
 assert.equal(h.calls.filter(call=>call.method==='POST').length,1);assert.equal(h.conversationCount(),1);assert.equal(h.messages.size,1);
 const count=h.calls.length;await h.manager.ensureOnboarding();await h.manager.enable();await h.newManager().restore();assert.equal(h.calls.length,count);
});

test('lost native PUT response retries createOnly with the same message ID and preserves its existing tenant content',async t=>{
 const h=await fixture(t,{failure:'lost_seed_response'});
 await assert.rejects(h.manager.ensureOnboarding(),{code:'ONBOARDING_INITIALIZATION_FAILED'});
 const checkpoint=h.readOnboarding(),intent=h.readNative(),existing=h.originalMessage();
 assert.equal(h.messages.size,1);assert.equal(intent.seeded,undefined);assert.equal(checkpoint.initialized,false);
 const value=await h.manager.enable();
 const puts=h.calls.filter(call=>call.method==='PUT');assert.equal(puts.length,2);assert.equal(puts[1].route,puts[0].route);
 assert.equal(puts[1].body.id,existing.id);assert.equal(puts[1].body.createOnly,true);
 assert.deepEqual(h.messages.get(existing.id),existing,'createOnly must return the existing native message without overwriting a tenant edit');
 assert.equal(h.messages.size,1);assert.equal(h.readNative().seeded,true);assert.equal(h.readOnboarding().initialized,true);
 assert.equal(value.onboarding.code,null);assert.equal(value.onboarding.projectId,checkpoint.projectId);assert.equal(value.onboarding.conversationId,checkpoint.conversationId);
 const count=h.calls.length;await h.newManager().ensureOnboarding();assert.equal(h.calls.length,count);
 assert.equal(h.calls.filter(call=>call.method==='POST').length,1);assert.equal(h.conversationCount(),1);
});

test('legacy failed known-ID checkpoint retries its native seed after manager restart',async t=>{
 const h=await fixture(t);await assert.rejects(h.manager.ensureOnboarding(),{code:'ONBOARDING_INITIALIZATION_FAILED'});
 const checkpoint=h.readOnboarding();delete checkpoint.initialized;checkpoint.creation='created';
 fs.writeFileSync(h.onboardingFile,JSON.stringify(checkpoint));
 const next=h.newManager(),value=await next.ensureOnboarding();
 assert.equal(value.initialized,true);assert.equal(value.code,null);assert.equal(value.projectId,checkpoint.projectId);assert.equal(value.conversationId,checkpoint.conversationId);
 const puts=h.calls.filter(call=>call.method==='PUT');assert.equal(puts.length,2);assert.equal(puts[1].route,puts[0].route);
 assert.equal(h.calls.filter(call=>call.method==='POST').length,1);assert.equal(h.conversationCount(),1);assert.equal(h.messages.size,1);
});

test('legacy successful known IDs remain initialized without native callback work or state rewriting',async t=>{
 const h=await fixture(t);fs.mkdirSync(path.dirname(h.onboardingFile),{recursive:true});
 for(const ids of [{conversationId:'legacy-conversation'},{id:'legacy-conversation'}]){
  const record={projectId:'legacy-project',...ids,url:'/projects/legacy-project/conversations/legacy-conversation',creation:'created',completed:true,code:null};
  fs.writeFileSync(h.onboardingFile,JSON.stringify(record));
  const value=await h.manager.ensureOnboarding();assert.equal(value.initialized,true);assert.equal(value.completed,true);assert.equal(value.conversationId,'legacy-conversation');
  await h.manager.enable();assert.equal(h.calls.length,0);assert.deepEqual(h.readOnboarding(),record);
 }
});
