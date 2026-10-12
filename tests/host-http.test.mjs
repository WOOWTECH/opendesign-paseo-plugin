import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {registerPaseoBridge,installBridgeBodyParser} from '../host/adapter.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=path.resolve(import.meta.dirname,'..');
async function harness(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'od-bridge-http-'));fs.mkdirSync(path.join(dir,'plugins/woowtech-paseo'),{recursive:true});for(const f of ['SKILL.md','open-design.json'])fs.copyFileSync(path.join(root,'plugin',f),path.join(dir,'plugins/woowtech-paseo',f));
 const calls=[];let config={servers:[{id:'unrelated',transport:'stdio',command:'node',args:['unchanged.mjs'],enabled:true}]};let state={desiredEnabled:false,phase:'disabled'};
 const manager={status:async()=>({...state}),enable:async()=>{calls.push('enable');state={desiredEnabled:true,phase:'running'};},disable:async()=>{calls.push('disable');state={desiredEnabled:false,phase:'disabled'};},models:async provider=>({provider,models:[{id:'model'}]}),pair:async()=>({url:'https://app.paseo.sh/?offer=private'}),acceptance:async input=>{calls.push({acceptance:input});},login:async(...args)=>{calls.push({login:args});return {phase:'authorization_completed'};},ensureOnboarding:async()=>({url:'/projects/p/conversations/c'}),restore:async()=>{},shutdown:async()=>{},cancelPending:()=>{}};
 const app=express();installBridgeBodyParser(app,{allowedOrigins:['https://od.example.test']});app.use(express.json({limit:'4mb'}));
 const lifecycle=registerPaseoBridge(app,{dataDir:dir,home:dir,packageRoot:root,port:7457,allowedOrigins:['https://od.example.test'],nativeRequest:async()=>null,manager,getInstalledPluginRecord:()=>({id:'woowtech-paseo',sourceKind:'github'}),mcpConfig:{writeMcpConfig:async(_dir,update)=>{config=await update(config);return config;}}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{lifecycle.disarm();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const post=(body,headers={})=>fetch(base+'/api/paseo-bridge',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://od.example.test',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
 return {base,post,calls,dir,lifecycle,config:()=>config};
}
test('real HTTP rejects cross-site and malformed requests before manager calls',async t=>{
 const h=await harness(t);
 for(const [body,headers,status] of [[{action:'enable'},{Origin:'https://evil.example.test'},403],[{action:'enable'},{'Sec-Fetch-Site':'cross-site'},403],['{',{},400],[{action:'enable',cwd:'/etc'}, {},400],['x'.repeat(17000),{},413]]){
  const response=await h.post(body,headers);assert.equal(response.status,status);assert.ok(response.headers.get('cache-control').includes('no-store'));assert.equal(response.headers.get('referrer-policy'),'no-referrer');const result=await response.json();assert.ok(result.error.code);
 }
 assert.equal(h.calls.length,0);
});
test('enable merges its own native MCP entry and retains unrelated integrations',async t=>{
 const h=await harness(t);assert.equal((await h.post({action:'enable'})).status,202);await new Promise(r=>setTimeout(r,30));
 assert.deepEqual(h.config().servers.find(x=>x.id==='unrelated'),{id:'unrelated',transport:'stdio',command:'node',args:['unchanged.mjs'],enabled:true});assert.equal(h.config().servers.filter(x=>x.id==='woow-paseo').length,1);assert.ok(h.calls.includes('enable'));
});
test('native MCP entry initializes through real SDK stdio with explicit tenant HOME/dataDir',async t=>{
 const h=await harness(t);
 assert.equal((await h.post({action:'enable'})).status,202);
 for(let i=0;i<20&&!h.config().servers.some(row=>row.id==='woow-paseo');i++)await new Promise(resolve=>setTimeout(resolve,5));
 const entry=h.config().servers.find(row=>row.id==='woow-paseo');assert.ok(entry);
 assert.equal(entry.env?.HOME,h.dir);assert.equal(entry.env?.OPENDESIGN_PASEO_DATA_DIR,h.dir);
 assert.equal(Object.hasOwn(entry.env,'OD_API_TOKEN'),false);
 const client=new Client({name:'host-http-test',version:'1'});
 const transport=new StdioClientTransport({command:entry.command,args:entry.args,env:entry.env,stderr:'pipe'});
 t.after(async()=>client.close());
 await client.connect(transport);
 assert.equal((await client.listTools()).tools.length,4);
 const result=await client.callTool({name:'paseo_status',arguments:{}});
 assert.equal(JSON.parse(result.content[0].text).desiredEnabled,false);
});
test('selected catalog settings and protected OAuth completion reach exact manager arguments',async t=>{
 const h=await harness(t);const input={providers:['codex'],models:{codex:'model'},modes:{codex:'default'}};
 assert.equal((await h.post({action:'acceptance',...input})).status,202);await new Promise(r=>setTimeout(r,30));assert.deepEqual(h.calls.find(x=>x.acceptance).acceptance,input);
 assert.equal((await h.post({action:'login',step:'complete',provider:'pi',code:'private-callback'})).status,200);assert.deepEqual(h.calls.find(x=>x.login).login,['complete','pi',{code:'private-callback'}]);
});
test('streaming oversized body still receives a private 413 JSON response',async t=>{
 const h=await harness(t);
 const result=await new Promise((resolve,reject)=>{const req=http.request(h.base+'/api/paseo-bridge',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://od.example.test'}},res=>{let bytes='';res.on('data',x=>bytes+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(bytes)}));});req.on('error',reject);req.write('x'.repeat(9000));req.write('x'.repeat(9000));req.end();});
 assert.equal(result.status,413);assert.equal(result.body.error.code,'BODY_TOO_LARGE');assert.equal(h.calls.length,0);
});
