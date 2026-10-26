import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createStandaloneApp, standaloneConfig} from '../host/standalone.mjs';
import {haIngressAllowed} from '../host/ha-ingress.mjs';
const prefix='/api/hassio_ingress/'+'a'.repeat(32);
const host='ha.example.test:8123';
const headers={host,'x-od-ha-peer':'172.30.32.2','x-remote-user-id':'b'.repeat(32),'x-ingress-path':prefix};
const mutation={...headers,origin:'https://'+host,referer:`https://${host}${prefix}/paseo/setup/`,'sec-fetch-site':'same-origin','content-type':'application/json'};

test('HA authorization rejects TCP peers, forged forwarding, missing users and origin/subpath attacks',()=>{
 const request=(changes={})=>({socket:{},method:'POST',url:'/api/paseo-bridge',headers:mutation,...changes});
 assert.equal(haIngressAllowed(request()),true);
 for(const h of [
  {'x-od-ha-peer':'127.0.0.1'},{'x-remote-user-id':''},{'x-remote-user-id':'b'.repeat(32)+',fake'},
  {'x-ingress-path':prefix+'/'},{'x-ingress-path':prefix+'/../evil'},{'x-ingress-path':'//evil.test'},
  {'x-ingress-path':prefix+'%2f'},{'x-ingress-path':prefix+'"<script>'},
  {origin:'https://evil.test'},{origin:'null'},{origin:'https://'+host+'/'},{origin:'https://'+host+',https://evil.test'},
  {origin:undefined},{referer:undefined},{referer:'https://'+host+'/plugins'},
  {referer:`http://${host}${prefix}/paseo/setup/`},{referer:`https://${host}${prefix}evil/paseo/setup/`},
  {'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'},{'sec-fetch-site':'none'},
  {'x-forwarded-host':host},{'x-forwarded-proto':'https'},{forwarded:'for=172.30.32.2'},
  {host:'ha.example.test:8123@evil.test'},{host:host+'/evil'},
 ])assert.equal(haIngressAllowed(request({headers:{...mutation,...h}})),false,JSON.stringify(h));
 for(const url of ['/api/paseo-bridge/extra','//paseo/setup','/paseo/assets/%2e%2e%2fpackage.json','/paseo/setup/../setup','/paseo/%73etup','/paseo/setup\\evil'])assert.equal(haIngressAllowed(request({url})),false,url);
 assert.equal(haIngressAllowed(request({socket:{remoteAddress:'127.0.0.1'}})),false);
 assert.equal(haIngressAllowed(request({method:'PUT'})),false);
 assert.equal(haIngressAllowed(request({method:'POST',headers:{...mutation,origin:'http://'+host,referer:`http://${host}${prefix}/paseo/setup/`}})),true,'LAN HTTP HA supported');
});

test('HA mode requires explicit absolute Unix socket and leaves HTTPS mode strict',()=>{
 const env={HOME:'/data/test/home',OPENDESIGN_PASEO_DATA_DIR:'/data/test',OPENDESIGN_PASEO_BUNDLED_PLUGIN:'/app/plugins/woow-paseo',OPENDESIGN_PASEO_TRANSPORT:'ha-ingress',OPENDESIGN_PASEO_SOCKET:'/run/paseo/bridge.sock'};
 assert.equal(standaloneConfig(env).haIngress,true);
 for(const extra of [{OPENDESIGN_PASEO_SOCKET:undefined},{OPENDESIGN_PASEO_SOCKET:'relative'},{OPENDESIGN_PASEO_TRANSPORT:'anything'},{OPENDESIGN_PASEO_TRANSPORT:'https'}])assert.throws(()=>standaloneConfig({...env,...extra}));
});

test('real Unix HTTP serves prefixed setup/assets and accepts only authorized mutations',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paseo-ha-'));
 const root=path.resolve(import.meta.dirname,'..');let enabled=0;
 const manager={status:async()=>({desiredEnabled:false}),enable:async()=>{enabled++;},shutdown:async()=>{},cancelPending(){}};
 const {app,bridge}=createStandaloneApp({haIngress:true,dataDir:dir,home:dir,packageRoot:root,bundledPlugin:path.join(root,'launcher'),nativePort:7456},{manager,nativeRequest:async()=>({servers:[]})});
 const socketPath=path.join(dir,'bridge.sock');const server=app.listen(socketPath);await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await bridge.shutdown();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const send=(route,h=headers,body)=>new Promise((resolve,reject)=>{
  const req=http.request({socketPath,path:route,method:body?'POST':'GET',headers:h},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body);
 });
 for(const route of ['/paseo/setup','/paseo/setup/']){
  const res=await send(route);assert.equal(res.status,200);assert.match(res.text,new RegExp(`data-ingress-path="${prefix}"`));
  assert.ok(res.text.includes(`src="${prefix}/paseo/assets/setup.js"`));assert.ok(res.text.includes(`href="${prefix}/plugins"`));
  assert.equal(res.headers['referrer-policy'],'same-origin');assert.match(res.headers['content-security-policy'],/frame-ancestors 'none'/);
 }
 assert.equal((await send('/paseo/assets/setup.js')).status,200);
 assert.equal((await send('/paseo/setup/',{})).status,403);
 assert.equal((await send('/api/paseo-bridge',headers,'{"action":"enable"}')).status,403);
 assert.equal(enabled,0);
 assert.equal((await send('/api/paseo-bridge',mutation,'{"action":"enable"}')).status,202);
 for(let n=0;n<50&&!enabled;n++)await new Promise(r=>setTimeout(r,5));assert.equal(enabled,1);
});
